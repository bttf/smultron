/**
 * The service worker's snapshot run (m25, SPEC §17.7), Chrome-free: every
 * Chrome call (tab lookup, script injection, the CDP capture, session
 * storage, keep-alive) is injected, so the step order, the failure handling
 * and the one-at-a-time rule are testable.
 *
 * Order (§17.7): read the page (injected `snapshot` script) → full-page
 * screenshot over CDP (a failure here only costs the tiles) → `POST
 * /api/snapshots` → PUT each asset to its signed URL, ≤ 3 at a time → `POST
 * /api/snapshots/:id/complete`. Progress goes to `snapshotState` after every
 * step; the popup renders it and may close at any time without cancelling.
 */

import {
	type AssetBlob,
	buildAssets,
	buildCreateBody,
	capMarkdown,
	isInFlight,
	maxTilesFor,
	type PageCapture,
	READ_TIMEOUT_MS,
	type ScreenshotTile,
	type SnapshotState,
	type StoredMarkdown,
	withTimeout,
} from "./snapshot";
import {
	type ApiConfig,
	completeSnapshot,
	createSnapshot,
	describeFailure,
	missingAssets,
	runPool,
	type UploadTarget,
	uploadAsset,
} from "./snapshotApi";

/** PUTs in flight at once (§17.7). */
export const UPLOAD_CONCURRENCY = 3;

export interface SnapshotTab {
	url?: string;
	title?: string;
	favIconUrl?: string;
}

export interface SnapshotRunDeps {
	getTab(tabId: number): Promise<SnapshotTab | undefined>;
	/** The pairing token + API base URL; undefined when unpaired. */
	loadConfig(): Promise<ApiConfig | undefined>;
	/** `chrome.scripting.executeScript` of the `snapshot` script; throws on failure. */
	readPage(tabId: number): Promise<PageCapture>;
	/** The CDP full-page capture; throws on failure. */
	captureScreenshot(
		tabId: number,
		options: { devicePixelRatio: number; maxTiles: number },
	): Promise<ScreenshotTile[]>;
	fetch: typeof fetch;
	getState(): Promise<SnapshotState | undefined>;
	setState(state: SnapshotState): Promise<void>;
	/** Store (or, with undefined, clear) the last run's markdown. */
	setMarkdown(value: StoredMarkdown | undefined): Promise<void>;
	now(): number;
	newRunId(): string;
	/** Keep the worker alive for the run; returns the stop function. */
	keepAlive?(): () => void;
}

export type StartOutcome = "started" | "busy";

function isWebUrl(url: string | undefined): url is string {
	return url !== undefined && /^https?:\/\//i.test(url);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createSnapshotRunner(deps: SnapshotRunDeps) {
	let running = false;

	/**
	 * A state still marked in flight when this worker starts belongs to a
	 * worker that died mid-run: nothing is running it any more. Mark it failed
	 * so the popup re-enables the button instead of waiting forever.
	 */
	async function recover(): Promise<void> {
		try {
			const state = await deps.getState();
			if (!running && isInFlight(state) && state !== undefined) {
				await deps.setState({
					...state,
					step: "failed",
					error: "interrupted — try again",
				});
			}
		} catch {
			// Session storage unavailable: nothing to recover.
		}
	}

	let ready: Promise<void> | undefined;

	/**
	 * Run the recovery once per worker. Called when the worker starts, and
	 * awaited by `start` so a recovery write can never land on top of a new
	 * run's first state.
	 */
	function init(): Promise<void> {
		ready ??= recover();
		return ready;
	}

	/**
	 * Start a snapshot of `tabId` unless one is already running. Resolves when
	 * the run finishes; the run itself never throws — every outcome lands in
	 * `snapshotState`.
	 */
	async function start(tabId: number): Promise<StartOutcome> {
		await init();
		if (running) return "busy";
		running = true;
		const stopKeepAlive = deps.keepAlive?.();
		try {
			await run(tabId);
		} finally {
			stopKeepAlive?.();
			running = false;
		}
		return "started";
	}

	async function run(tabId: number): Promise<void> {
		let state: SnapshotState = {
			runId: deps.newRunId(),
			tabId,
			url: "",
			step: "reading",
			startedAtMs: deps.now(),
		};
		const publish = async (patch: Partial<SnapshotState>): Promise<void> => {
			state = { ...state, ...patch };
			try {
				await deps.setState(state);
			} catch {
				// A failed progress write must not fail the snapshot.
			}
		};
		const fail = (error: string, extra: Partial<SnapshotState> = {}) =>
			publish({ step: "failed", error, ...extra });
		try {
			await steps(tabId, () => state, publish, fail);
		} catch (error) {
			// Nothing below should throw; if something does, the state must still
			// leave "in flight" or the popup's button never comes back.
			await fail(`unexpected error: ${errorText(error)}`);
		}
	}

	async function steps(
		tabId: number,
		current: () => SnapshotState,
		publish: (patch: Partial<SnapshotState>) => Promise<void>,
		fail: (error: string, extra?: Partial<SnapshotState>) => Promise<void>,
	): Promise<void> {
		// The previous run's markdown goes the moment a new run starts (§17.7).
		await deps.setMarkdown(undefined).catch(() => {});

		const tab = await deps.getTab(tabId);
		if (!isWebUrl(tab?.url)) {
			await fail("only web pages can be snapshotted", { url: tab?.url ?? "" });
			return;
		}
		const url = tab.url;
		await publish({ url, title: tab.title });

		const config = await deps.loadConfig();
		if (config === undefined) {
			await fail("not paired", { unpaired: true });
			return;
		}

		// 1. Read the page.
		let capture: PageCapture;
		try {
			capture = await withTimeout(
				deps.readPage(tabId),
				READ_TIMEOUT_MS,
				"the page script",
			);
		} catch (error) {
			await fail(`couldn't read the page: ${errorText(error)}`);
			return;
		}
		const markdown = capMarkdown(capture.result.markdown);
		await deps
			.setMarkdown({ runId: current().runId, markdown })
			.catch(() => {});
		await publish({
			step: "capturing",
			title: capture.result.title || tab.title,
			markdownChars: markdown.length,
		});

		// 2. Full-page screenshot. A failure only costs the tiles (§17.7).
		let tiles: ScreenshotTile[] = [];
		let screenshotFailed = false;
		try {
			tiles = await deps.captureScreenshot(tabId, {
				devicePixelRatio: capture.metadata.viewport?.devicePixelRatio ?? 1,
				maxTiles: maxTilesFor(capture),
			});
		} catch {
			tiles = [];
			screenshotFailed = true;
		}
		if (tiles.length === 0) screenshotFailed = true;

		// 3. Create the snapshot (and the bookmark, as a live capture).
		const assets = buildAssets(capture, tiles);
		await publish({
			step: "uploading",
			screenshotFailed,
			screenshotCount: assets.filter((a) => a.kind === "screenshot").length,
			uploaded: 0,
			uploadTotal: assets.length,
		});
		const body = buildCreateBody({
			url,
			faviconUrl: tab.favIconUrl,
			capture,
			markdown,
			assets,
			now: deps.now,
		});
		const created = await createSnapshot(config, deps.fetch, body);
		if (!created.ok) {
			if (created.status === 401) {
				await fail("not paired", { unpaired: true });
			} else {
				await fail(`couldn't save the snapshot: ${describeFailure(created)}`);
			}
			return;
		}
		const snapshotId = created.value.snapshot.id;
		await publish({ snapshotId });

		// 4. PUT every asset to its signed URL.
		const targets = new Map<string, UploadTarget>();
		for (const target of created.value.uploads)
			targets.set(`${target.kind}:${target.idx}`, target);
		const unmatched = assets.find((a) => !targets.has(`${a.kind}:${a.idx}`));
		if (unmatched !== undefined) {
			await fail(
				`the server returned no upload URL for ${unmatched.kind} ${unmatched.idx}`,
			);
			return;
		}
		let uploaded = 0;
		const uploadFailure = await runPool(
			assets,
			UPLOAD_CONCURRENCY,
			async (asset: AssetBlob) => {
				const target = targets.get(
					`${asset.kind}:${asset.idx}`,
				) as UploadTarget;
				const result = await uploadAsset(
					deps.fetch,
					target.uploadUrl,
					asset.mime,
					asset.bytes,
				);
				if (!result.ok)
					return `upload failed (${asset.kind} ${asset.idx}): ${describeFailure(result)}`;
				uploaded += 1;
				await publish({ uploaded });
				return undefined;
			},
		);
		if (uploadFailure !== undefined) {
			await fail(uploadFailure);
			return;
		}

		// 5. Complete.
		const completed = await completeSnapshot(config, deps.fetch, snapshotId);
		if (!completed.ok) {
			if (completed.status === 401) {
				await fail("not paired", { unpaired: true });
			} else if (completed.status === 409) {
				const missing = missingAssets(completed.body);
				await fail(
					`upload incomplete: ${missing.length || "some"} file(s) missing on the server`,
				);
			} else {
				await fail(
					`couldn't finish the snapshot: ${describeFailure(completed)}`,
				);
			}
			return;
		}
		await publish({ step: "done", error: undefined });
	}

	return { init, start };
}
