import { describe, expect, it } from "vitest";
import type {
	PageCapture,
	ScreenshotTile,
	SnapshotState,
	StoredMarkdown,
} from "./snapshot";
import { createSnapshotRunner, type SnapshotRunDeps } from "./snapshotRun";

const BASE = "https://smultron.test";
const TAB_URL = "https://example.com/engines";

function pageCapture(): PageCapture {
	return {
		result: {
			title: "On Engines",
			markdown: "# On Engines\n\nThe analytical engine.",
			adapterId: "generic",
			adapterVersion: "1.0.0",
			data: { extraction: "readability" },
		},
		metadata: {
			url: TAB_URL,
			title: "On Engines",
			meta: [],
			openGraph: {},
			twitter: {},
			jsonLd: [],
			links: [],
			viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
			scrollHeight: 4000,
			userAgent: "test",
			capturedAt: "2026-10-01T10:00:00.000Z",
		},
		html: "<html><body>engines</body></html>",
	};
}

function tiles(n: number): ScreenshotTile[] {
	return Array.from({ length: n }, () => ({
		bytes: new Uint8Array([1, 2, 3]),
		width: 2560,
		height: 8000,
	}));
}

function summary(id: number, status = "uploading") {
	return {
		id,
		bookmarkId: 7,
		url: TAB_URL,
		title: "On Engines",
		adapterId: "generic",
		adapterVersion: "1.0.0",
		status,
		capturedAt: "2026-10-01T10:00:00.000Z",
		createdAt: "2026-10-01T10:00:01.000Z",
		markdownChars: 35,
		screenshotCount: 2,
	};
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

interface Request {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: unknown;
}

function harness(
	options: {
		capture?: PageCapture;
		screenshot?: () => Promise<ScreenshotTile[]>;
		createStatus?: number;
		initialState?: SnapshotState;
	} = {},
) {
	const states: SnapshotState[] = [];
	let stored = options.initialState;
	let markdown: StoredMarkdown | undefined;
	const requests: Request[] = [];
	let putsInFlight = 0;
	let maxPutsInFlight = 0;

	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		requests.push({
			url,
			method,
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body,
		});
		if (url === `${BASE}/api/snapshots` && method === "POST") {
			if (options.createStatus !== undefined)
				return json(options.createStatus, { error: "nope" });
			const body = JSON.parse(String(init?.body)) as {
				assets: Array<{ kind: string; idx: number }>;
			};
			return json(201, {
				snapshot: summary(42),
				uploads: body.assets.map((a) => ({
					kind: a.kind,
					idx: a.idx,
					path: `user/42/${a.kind}-${a.idx}`,
					uploadUrl: `https://storage.test/${a.kind}-${a.idx}?token=t`,
				})),
			});
		}
		if (url.startsWith("https://storage.test/")) {
			putsInFlight += 1;
			maxPutsInFlight = Math.max(maxPutsInFlight, putsInFlight);
			await new Promise((resolve) => setTimeout(resolve, 2));
			putsInFlight -= 1;
			return new Response(null, { status: 200 });
		}
		if (url === `${BASE}/api/snapshots/42/complete` && method === "POST")
			return json(200, { snapshot: summary(42, "complete") });
		return json(404, { error: "not_found" });
	}) as typeof fetch;

	const deps: SnapshotRunDeps = {
		getTab: async () => ({
			url: TAB_URL,
			title: "Tab title",
			favIconUrl: "https://example.com/favicon.ico",
		}),
		loadConfig: async () => ({ token: "tok", baseUrl: BASE }),
		readPage: async () => options.capture ?? pageCapture(),
		captureScreenshot: options.screenshot ?? (async () => tiles(5)),
		fetch: fetchImpl,
		getState: async () => stored,
		setState: async (state) => {
			stored = state;
			states.push(state);
		},
		setMarkdown: async (value) => {
			markdown = value;
		},
		now: () => Date.parse("2026-10-01T10:00:00.000Z"),
		newRunId: () => "run-1",
	};
	return {
		runner: createSnapshotRunner(deps),
		states,
		requests,
		markdown: () => markdown,
		maxPutsInFlight: () => maxPutsInFlight,
	};
}

describe("createSnapshotRunner", () => {
	it("reads, captures, creates, uploads ≤3 at a time, completes", async () => {
		const h = harness();
		expect(await h.runner.start(3)).toBe("started");

		const steps = h.states.map((s) => s.step);
		expect(steps[0]).toBe("reading");
		expect(steps).toContain("capturing");
		expect(steps).toContain("uploading");
		expect(steps.at(-1)).toBe("done");
		const last = h.states.at(-1);
		expect(last).toMatchObject({
			tabId: 3,
			url: TAB_URL,
			snapshotId: 42,
			screenshotFailed: false,
			screenshotCount: 5,
			uploaded: 7,
			uploadTotal: 7,
		});

		const create = h.requests.find((r) => r.url === `${BASE}/api/snapshots`);
		expect(create?.headers.Authorization).toBe("Bearer tok");
		const body = JSON.parse(String(create?.body));
		expect(body).toMatchObject({
			url: TAB_URL,
			title: "On Engines",
			faviconUrl: "https://example.com/favicon.ico",
			adapterId: "generic",
			adapterVersion: "1.0.0",
			markdown: "# On Engines\n\nThe analytical engine.",
			capturedAt: "2026-10-01T10:00:00.000Z",
		});
		expect(
			body.assets.map(
				(a: { kind: string; idx: number }) => `${a.kind}:${a.idx}`,
			),
		).toEqual([
			"screenshot:0",
			"screenshot:1",
			"screenshot:2",
			"screenshot:3",
			"screenshot:4",
			"html:0",
			"data:0",
		]);
		expect(body.assets[0]).toEqual({
			kind: "screenshot",
			idx: 0,
			mime: "image/webp",
			byteSize: 3,
			width: 2560,
			height: 8000,
		});

		const puts = h.requests.filter((r) => r.method === "PUT");
		expect(puts).toHaveLength(7);
		// The signed URL carries its own token; the pairing token never goes to Storage.
		expect(puts.every((p) => p.headers.Authorization === undefined)).toBe(true);
		expect(
			puts.find((p) => p.url.includes("html-0"))?.headers["Content-Type"],
		).toBe("text/html");
		expect(h.maxPutsInFlight()).toBeLessThanOrEqual(3);
		expect(h.maxPutsInFlight()).toBeGreaterThan(1);

		expect(h.requests.at(-1)?.url).toBe(`${BASE}/api/snapshots/42/complete`);
		expect(h.markdown()).toEqual({
			runId: "run-1",
			markdown: "# On Engines\n\nThe analytical engine.",
		});
	});

	it("continues with zero tiles when the screenshot fails", async () => {
		const capture = pageCapture();
		delete capture.result.data;
		const h = harness({
			screenshot: async () => {
				throw new Error("debugger refused");
			},
			capture,
		});
		await h.runner.start(3);
		expect(h.states.at(-1)).toMatchObject({
			step: "done",
			screenshotFailed: true,
			screenshotCount: 0,
		});
		const create = h.requests.find((r) => r.url === `${BASE}/api/snapshots`);
		const body = JSON.parse(String(create?.body));
		// No data asset either: the adapter returned none.
		expect(body.assets.map((a: { kind: string }) => a.kind)).toEqual(["html"]);
	});

	it("reports a 401 as not paired and uploads nothing", async () => {
		const h = harness({ createStatus: 401 });
		await h.runner.start(3);
		expect(h.states.at(-1)).toMatchObject({ step: "failed", unpaired: true });
		expect(h.requests.some((r) => r.method === "PUT")).toBe(false);
	});

	it("runs one snapshot at a time", async () => {
		const h = harness();
		const [first, second] = await Promise.all([
			h.runner.start(3),
			h.runner.start(4),
		]);
		expect([first, second]).toEqual(["started", "busy"]);
	});

	it("marks a state left in flight by a dead worker as failed", async () => {
		const h = harness({
			initialState: {
				runId: "old",
				tabId: 9,
				url: TAB_URL,
				step: "uploading",
				startedAtMs: 0,
			},
		});
		await h.runner.init();
		expect(h.states.at(-1)).toMatchObject({ runId: "old", step: "failed" });
	});
});
