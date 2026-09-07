import { describe, expect, it, vi } from "vitest";
import {
	createScreenshotBackfill,
	SCREENSHOT_SETTLE_MS,
	type ScreenshotBackfillDeps,
	type TabState,
} from "./screenshotBackfill";
import type { TrackedEntry } from "./trackedCache";

const URL_A = "https://example.com/a?utm_source=x";
const TAB_ID = 7;

/** A tracked row that definitely has no screenshot — the only trigger. */
const NEEDS_SHOT: TrackedEntry = {
	tracked: true,
	bookmarkId: "bm-1",
	hasScreenshot: false,
};

type Harness = ReturnType<typeof harness>;

function harness(
	options: {
		enabled?: boolean | (() => Promise<boolean>);
		cached?: TrackedEntry | undefined;
		looked?: TrackedEntry | undefined;
		tab?: TabState | undefined;
		captured?: string | undefined | (() => Promise<string | undefined>);
	} = {},
) {
	const { enabled = true, cached = undefined, looked = undefined } = options;
	// `in` rather than a default: `{ tab: undefined }` and
	// `{ captured: undefined }` are the "tab gone" / "capture refused" cases,
	// which a default parameter would silently overwrite.
	const tab: TabState | undefined =
		"tab" in options
			? options.tab
			: { url: URL_A, active: true, status: "complete" };
	const captured = "captured" in options ? options.captured : "BASE64";

	const deps = {
		isCaptureEnabled: vi.fn(
			typeof enabled === "function" ? enabled : async () => enabled,
		),
		getCached: vi.fn((_url: string) => cached),
		lookupTracked: vi.fn(async (_url: string) => looked),
		sleep: vi.fn(async (_ms: number) => {}),
		getTab: vi.fn(async (_tabId: number) => tab),
		capture: vi.fn(
			typeof captured === "function"
				? captured
				: async (_url: string) => captured,
		),
		enqueue: vi.fn(async (_url: string, _base64: string) => {}),
		flush: vi.fn(async () => {}),
	};

	const backfill = createScreenshotBackfill(
		deps as unknown as ScreenshotBackfillDeps,
	);
	return {
		backfill,
		deps,
		complete: (
			overrides: Partial<{ tabId: number; url: string; active: boolean }> = {},
		) =>
			backfill.onTabComplete({
				tabId: TAB_ID,
				url: URL_A,
				active: true,
				...overrides,
			}),
	};
}

/** Nothing observable happened — the assertion the gate tests all share. */
function expectNoWork(deps: Harness["deps"]): void {
	expect(deps.getCached).not.toHaveBeenCalled();
	expect(deps.lookupTracked).not.toHaveBeenCalled();
	expect(deps.capture).not.toHaveBeenCalled();
	expect(deps.enqueue).not.toHaveBeenCalled();
	expect(deps.flush).not.toHaveBeenCalled();
}

describe("createScreenshotBackfill — the m19 gate (SPEC §15.4)", () => {
	it("toggle off: zero lookups, captures or enqueues", async () => {
		const { deps, complete } = harness({ enabled: false, cached: NEEDS_SHOT });
		await complete();
		expect(deps.isCaptureEnabled).toHaveBeenCalledTimes(1);
		expectNoWork(deps);
	});

	it("a toggle read that throws is treated as off", async () => {
		const { deps, complete } = harness({
			enabled: async () => {
				throw new Error("storage unavailable");
			},
			cached: NEEDS_SHOT,
		});
		await expect(complete()).resolves.toBeUndefined();
		expectNoWork(deps);
	});

	it("the gate precedes the settle and the tab read too", async () => {
		const { deps, complete } = harness({ enabled: false, cached: NEEDS_SHOT });
		await complete();
		expect(deps.sleep).not.toHaveBeenCalled();
		expect(deps.getTab).not.toHaveBeenCalled();
	});
});

describe("createScreenshotBackfill — eligibility", () => {
	it("a non-http(s) url never backfills", async () => {
		for (const url of [
			"chrome://extensions",
			"file:///Users/me/notes.txt",
			"about:blank",
			"",
		]) {
			const { deps, complete } = harness({ cached: NEEDS_SHOT });
			await complete({ url });
			expectNoWork(deps);
		}
	});

	it("a missing url never backfills", async () => {
		const { deps, backfill } = harness({ cached: NEEDS_SHOT });
		await backfill.onTabComplete({ tabId: TAB_ID, active: true });
		expectNoWork(deps);
	});

	it("an inactive tab never backfills", async () => {
		const { deps, complete } = harness({ cached: NEEDS_SHOT });
		await complete({ active: false });
		expect(deps.capture).not.toHaveBeenCalled();
		expect(deps.enqueue).not.toHaveBeenCalled();
	});

	it("a cache hit spends no lookup", async () => {
		const { deps, complete } = harness({ cached: NEEDS_SHOT });
		await complete();
		expect(deps.getCached).toHaveBeenCalledWith(URL_A);
		expect(deps.lookupTracked).not.toHaveBeenCalled();
		expect(deps.capture).toHaveBeenCalledTimes(1);
	});

	it("a cache miss spends exactly one lookup", async () => {
		const { deps, complete } = harness({
			cached: undefined,
			looked: NEEDS_SHOT,
		});
		await complete();
		expect(deps.lookupTracked).toHaveBeenCalledTimes(1);
		expect(deps.lookupTracked).toHaveBeenCalledWith(URL_A);
		expect(deps.capture).toHaveBeenCalledTimes(1);
	});

	it("a failed lookup (unpaired, network, non-2xx) does nothing", async () => {
		const { deps, complete } = harness({
			cached: undefined,
			looked: undefined,
		});
		await complete();
		expect(deps.lookupTracked).toHaveBeenCalledTimes(1);
		expect(deps.capture).not.toHaveBeenCalled();
	});

	it("tracked === false never triggers", async () => {
		for (const entry of [
			{ tracked: false } as TrackedEntry,
			{ tracked: false, bookmarkId: "bm-1", hasScreenshot: false },
		]) {
			const { deps, complete } = harness({ cached: entry });
			await complete();
			expect(deps.capture).not.toHaveBeenCalled();
			expect(deps.enqueue).not.toHaveBeenCalled();
		}
	});

	it("hasScreenshot === undefined NEVER triggers (uncertainty does nothing)", async () => {
		// Exactly what an optimistic override after a live save looks like.
		for (const entry of [
			{ tracked: true } as TrackedEntry,
			{ tracked: true, bookmarkId: "bm-1" },
		]) {
			const { deps, complete } = harness({ cached: entry });
			await complete();
			expect(deps.capture).not.toHaveBeenCalled();
			expect(deps.sleep).not.toHaveBeenCalled();
		}
	});

	it("hasScreenshot === true never triggers", async () => {
		const { deps, complete } = harness({
			cached: { tracked: true, bookmarkId: "bm-1", hasScreenshot: true },
		});
		await complete();
		expect(deps.capture).not.toHaveBeenCalled();
	});

	it("a row with no id can't be attempted (nothing to spend the attempt on)", async () => {
		const { deps, complete } = harness({
			cached: { tracked: true, hasScreenshot: false },
		});
		await complete();
		expect(deps.capture).not.toHaveBeenCalled();
	});
});

describe("createScreenshotBackfill — the settle re-check", () => {
	it("waits SCREENSHOT_SETTLE_MS, then re-reads the tab, then captures", async () => {
		const { deps, complete } = harness({ cached: NEEDS_SHOT });
		await complete();
		expect(deps.sleep).toHaveBeenCalledWith(SCREENSHOT_SETTLE_MS);
		expect(deps.getTab).toHaveBeenCalledWith(TAB_ID);
		const slept = deps.sleep.mock.invocationCallOrder[0] ?? 0;
		const captured = deps.capture.mock.invocationCallOrder[0] ?? 0;
		expect(slept).toBeLessThan(captured);
	});

	it("abandons when the tab navigated away during the settle", async () => {
		const { deps, complete } = harness({
			cached: NEEDS_SHOT,
			tab: {
				url: "https://example.com/somewhere-else",
				active: true,
				status: "complete",
			},
		});
		await complete();
		expect(deps.capture).not.toHaveBeenCalled();
		expect(deps.enqueue).not.toHaveBeenCalled();
	});

	it("abandons when the tab is no longer active after the settle", async () => {
		const { deps, complete } = harness({
			cached: NEEDS_SHOT,
			tab: { url: URL_A, active: false, status: "complete" },
		});
		await complete();
		expect(deps.capture).not.toHaveBeenCalled();
	});

	it("abandons when a navigation started during the settle (still loading)", async () => {
		// Chrome reports the OLD url until the new one commits, so the url and
		// `active` both still match — only `status` reveals the teardown.
		const { deps, backfill, complete } = harness({
			cached: NEEDS_SHOT,
			tab: { url: URL_A, active: true, status: "loading" },
		});
		await complete();
		expect(deps.capture).not.toHaveBeenCalled();
		expect(deps.enqueue).not.toHaveBeenCalled();
		expect(backfill.attemptedCount()).toBe(1); // the attempt is still spent
	});

	it("abandons when the tab is gone", async () => {
		const { deps, complete } = harness({ cached: NEEDS_SHOT, tab: undefined });
		await complete();
		expect(deps.capture).not.toHaveBeenCalled();
	});

	it("compares the RAW url — the extension never normalizes", async () => {
		const { deps, complete } = harness({
			cached: NEEDS_SHOT,
			// The same page after Chrome dropped the tracking param: a different
			// raw string, so the capture is abandoned.
			tab: { url: "https://example.com/a", active: true, status: "complete" },
		});
		await complete();
		expect(deps.capture).not.toHaveBeenCalled();
	});
});

describe("createScreenshotBackfill — one attempt per bookmark", () => {
	it("the success path enqueues once and flushes once", async () => {
		const { deps, complete } = harness({ cached: NEEDS_SHOT });
		await complete();
		expect(deps.capture).toHaveBeenCalledWith(URL_A);
		expect(deps.enqueue).toHaveBeenCalledTimes(1);
		expect(deps.enqueue).toHaveBeenCalledWith(URL_A, "BASE64");
		expect(deps.flush).toHaveBeenCalledTimes(1);
	});

	it("a second complete event for the same bookmark does nothing", async () => {
		const { deps, backfill, complete } = harness({ cached: NEEDS_SHOT });
		await complete();
		await complete();
		expect(deps.capture).toHaveBeenCalledTimes(1);
		expect(deps.enqueue).toHaveBeenCalledTimes(1);
		expect(backfill.attemptedCount()).toBe(1);
	});

	it("two overlapping complete events never double-capture (cache hit)", async () => {
		const { deps, complete } = harness({ cached: NEEDS_SHOT });
		await Promise.all([complete(), complete()]);
		expect(deps.capture).toHaveBeenCalledTimes(1);
		expect(deps.enqueue).toHaveBeenCalledTimes(1);
	});

	it("two overlapping complete events never double-capture (cache MISS)", async () => {
		// Both events get past the cache and issue their own lookup; neither
		// resolves until both are in flight, so the `attempted` set — not luck
		// with the microtask order — is what stops the second capture.
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		const capture = vi.fn(async (_url: string) => "BASE64");
		const enqueue = vi.fn(async (_url: string, _base64: string) => {});
		const backfill = createScreenshotBackfill({
			isCaptureEnabled: async () => true,
			getCached: () => undefined,
			lookupTracked: async () => {
				started += 1;
				await gate;
				return NEEDS_SHOT;
			},
			sleep: async () => {},
			getTab: async () => ({ url: URL_A, active: true, status: "complete" }),
			capture,
			enqueue,
			flush: async () => {},
		});

		const first = backfill.onTabComplete({
			tabId: TAB_ID,
			url: URL_A,
			active: true,
		});
		const second = backfill.onTabComplete({
			tabId: TAB_ID,
			url: URL_A,
			active: true,
		});
		await Promise.resolve();
		expect(started).toBe(2); // both lookups are genuinely in flight
		release?.();
		await Promise.all([first, second]);

		expect(capture).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(backfill.attemptedCount()).toBe(1);
	});

	it("a refused capture SPENDS the attempt", async () => {
		const { deps, complete } = harness({
			cached: NEEDS_SHOT,
			captured: undefined,
		});
		await complete();
		expect(deps.capture).toHaveBeenCalledTimes(1);
		expect(deps.enqueue).not.toHaveBeenCalled();
		expect(deps.flush).not.toHaveBeenCalled();
		await complete();
		expect(deps.capture).toHaveBeenCalledTimes(1); // not retried
	});

	it("a capture that rejects SPENDS the attempt and never throws out", async () => {
		const { deps, complete } = harness({
			cached: NEEDS_SHOT,
			captured: async () => {
				throw new Error("captureVisibleTab rejected");
			},
		});
		await expect(complete()).resolves.toBeUndefined();
		await complete();
		expect(deps.capture).toHaveBeenCalledTimes(1);
		expect(deps.enqueue).not.toHaveBeenCalled();
	});

	it("a tab that navigated away SPENDS the attempt", async () => {
		const { deps, backfill, complete } = harness({
			cached: NEEDS_SHOT,
			tab: {
				url: "https://example.com/elsewhere",
				active: true,
				status: "complete",
			},
		});
		await complete();
		expect(backfill.attemptedCount()).toBe(1);
		await complete();
		expect(deps.getTab).toHaveBeenCalledTimes(1);
		expect(deps.sleep).toHaveBeenCalledTimes(1);
	});

	it("a tab inactive after the settle SPENDS the attempt", async () => {
		const { deps, complete } = harness({
			cached: NEEDS_SHOT,
			tab: { url: URL_A, active: false, status: "complete" },
		});
		await complete();
		await complete();
		expect(deps.sleep).toHaveBeenCalledTimes(1);
	});

	it("an enqueue failure SPENDS the attempt and never throws out", async () => {
		const { deps, complete } = harness({ cached: NEEDS_SHOT });
		deps.enqueue.mockImplementationOnce(async () => {
			throw new Error("storage quota exceeded");
		});
		await expect(complete()).resolves.toBeUndefined();
		expect(deps.flush).not.toHaveBeenCalled();
		await complete();
		expect(deps.capture).toHaveBeenCalledTimes(1);
	});

	it("the attempt is keyed on the BOOKMARK id, not the url", async () => {
		const { deps, backfill } = harness({ cached: NEEDS_SHOT });
		await backfill.onTabComplete({ tabId: TAB_ID, url: URL_A, active: true });
		// A different raw URL resolving to the SAME row (an m22 URL edit, a
		// stripped tracking param): the spent id bars the way before the settle.
		await backfill.onTabComplete({
			tabId: TAB_ID,
			url: "https://example.com/a?utm_source=y",
			active: true,
		});
		expect(deps.capture).toHaveBeenCalledTimes(1);
		expect(backfill.attemptedCount()).toBe(1);
	});

	it("different bookmarks each get their own attempt", async () => {
		let entry: TrackedEntry = NEEDS_SHOT;
		let current = "https://a.example/";
		const capture = vi.fn(async (_url: string) => "BASE64");
		const backfill = createScreenshotBackfill({
			isCaptureEnabled: async () => true,
			getCached: () => entry,
			lookupTracked: async () => undefined,
			sleep: async () => {},
			getTab: async () => ({
				url: current,
				active: true,
				status: "complete",
			}),
			capture,
			enqueue: async () => {},
			flush: async () => {},
		});
		await backfill.onTabComplete({ tabId: 1, url: current, active: true });
		entry = { tracked: true, bookmarkId: "bm-2", hasScreenshot: false };
		current = "https://b.example/";
		await backfill.onTabComplete({ tabId: 2, url: current, active: true });
		expect(capture).toHaveBeenCalledTimes(2);
		expect(backfill.attemptedCount()).toBe(2);
	});
});
