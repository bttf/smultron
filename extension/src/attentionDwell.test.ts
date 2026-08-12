/**
 * m19 hardening: dwell-edge SUFFICIENCY, proven by simulation (SPEC §13).
 *
 * §13's bet is that storing only raw edges is enough for RED-92 to
 * reconstruct dwell retroactively: dwell = active tab ∧ focused window ∧
 * non-idle, valid only BETWEEN events of the same `bootId`, with
 * `capture_stop` / a bootId change as hard boundaries (everything after the
 * last event of a boot is unknown time, never dwell). Edges cannot be
 * backfilled after the collection week, so a scenario the stream cannot
 * disambiguate would be unrecoverable data loss.
 *
 * These tests drive the REAL capture orchestrator (attentionCapture.ts +
 * attention.ts, exactly as background.ts wires them) through multi-step
 * scenarios — tab switches, app blur, idle, browser restarts, toggle cycles,
 * multi-window focus, SPA navs, worker death — and assert a minimal
 * reference slicer (test-local; RED-92 owns the real one) computes the
 * expected dwell intervals from the emitted stream ALONE.
 */

import { describe, expect, it } from "vitest";
import {
	createBrowseBuffer,
	createCaptureSession,
	createEventFactory,
} from "./attention";
import {
	type AttentionCapture,
	createAttentionCapture,
	type TabInfo,
} from "./attentionCapture";
import type { BrowseEvent, BrowseOutboxEntry, KeyValueStorage } from "./types";

// ---------------------------------------------------------------------------
// Reference slicer (test-local — deliberately minimal, §13 rules only).

interface DwellSlice {
	tabId: number;
	/** The tab's last-known URL over the slice (from activation/nav edges). */
	url: string | undefined;
	start: number;
	end: number;
}

/**
 * Replays the stream in capture order, tracking the three §13 signals
 * (per-window active tab, focused window, idle) and closing the open dwell
 * interval at every edge. Boundary rules:
 * - a `bootId` change resets ALL state — the open interval already ended at
 *   the previous boot's last event, so the gap contributes nothing;
 * - `capture_stop` ends dwell at its own timestamp;
 * - the synthetic baseline `tab_activated` immediately after `capture_start`
 *   doubles as the initial focus signal (§13: it is emitted ONLY when a
 *   window has focus; otherwise the stream starts blurred);
 * - trailing time after the last event is unknown, never dwell.
 */
function sliceDwell(stream: BrowseEvent[]): DwellSlice[] {
	const slices: DwellSlice[] = [];
	let boot: string | undefined;
	let focused: number | undefined;
	let idle = false;
	let stopped = false;
	let baselineNext = false;
	const activeTab = new Map<number, number>();
	const tabUrl = new Map<number, string>();
	let open: { tabId: number; start: number } | undefined;
	let lastAt = 0;

	const close = (end: number): void => {
		if (open !== undefined && end > open.start) {
			slices.push({
				tabId: open.tabId,
				url: tabUrl.get(open.tabId),
				start: open.start,
				end,
			});
		}
		open = undefined;
	};

	for (const event of stream) {
		if (event.bootId !== boot) {
			// Hard boundary: nothing between boots is attributable.
			close(lastAt);
			boot = event.bootId;
			focused = undefined;
			idle = false;
			stopped = false;
			baselineNext = false;
			activeTab.clear();
			tabUrl.clear();
		}
		close(event.occurredAtMs);

		const wasBaselineSlot = baselineNext;
		baselineNext = false;
		switch (event.kind) {
			case "capture_start":
				focused = undefined;
				idle = false;
				stopped = false;
				baselineNext = true;
				break;
			case "capture_stop":
				stopped = true;
				break;
			case "tab_activated":
				if (event.windowId !== undefined && event.tabId !== undefined) {
					activeTab.set(event.windowId, event.tabId);
					if (event.url !== undefined) tabUrl.set(event.tabId, event.url);
					if (wasBaselineSlot) focused = event.windowId;
				}
				break;
			case "window_focus":
				if (event.windowId !== undefined) {
					focused = event.windowId;
					if (event.tabId !== undefined) {
						activeTab.set(event.windowId, event.tabId);
						if (event.url !== undefined) tabUrl.set(event.tabId, event.url);
					}
				}
				break;
			case "window_blur":
				focused = undefined;
				break;
			case "idle":
				idle = event.idleState !== "active";
				break;
			case "nav":
				if (event.tabId !== undefined && event.url !== undefined) {
					tabUrl.set(event.tabId, event.url);
				}
				break;
		}

		const dwellTab =
			!stopped && !idle && focused !== undefined
				? activeTab.get(focused)
				: undefined;
		if (dwellTab !== undefined) {
			open = { tabId: dwellTab, start: event.occurredAtMs };
		}
		lastAt = event.occurredAtMs;
	}
	// Trailing open interval: zero-length by construction (unknown time).
	close(lastAt);
	return slices;
}

function dwellMsByTab(slices: DwellSlice[]): Map<number, number> {
	const out = new Map<number, number>();
	for (const slice of slices) {
		out.set(slice.tabId, (out.get(slice.tabId) ?? 0) + slice.end - slice.start);
	}
	return out;
}

function dwellMsByUrl(slices: DwellSlice[]): Map<string | undefined, number> {
	const out = new Map<string | undefined, number>();
	for (const slice of slices) {
		out.set(slice.url, (out.get(slice.url) ?? 0) + slice.end - slice.start);
	}
	return out;
}

function totalDwellMs(slices: DwellSlice[]): number {
	return slices.reduce((sum, slice) => sum + slice.end - slice.start, 0);
}

// ---------------------------------------------------------------------------
// Simulated browser world around the REAL capture orchestrator.

function memStorage(): KeyValueStorage {
	const data: Record<string, unknown> = {};
	return {
		get: async (key) => structuredClone(data[key]),
		set: async (key, value) => {
			data[key] = structuredClone(value);
		},
	};
}

const T0 = 1_754_900_000_000;
/** Absolute clock value `s` seconds into the scenario. */
function at(s: number): number {
	return T0 + s * 1_000;
}

interface World {
	clock: { t: number };
	enabled: boolean;
	/** windowId → its active tab (drives baseline + enrichment lookups). */
	windows: Map<number, TabInfo>;
	focusedWindowId: number | undefined;
	capture: AttentionCapture;
	/** Everything captured so far, in capture order (drained + buffered). */
	all(): BrowseEvent[];
	/** Service-worker death + revival: new instance, SAME storages. */
	workerRestart(): void;
	/** Browser quit + relaunch: chrome.storage.session resets too. */
	browserRestart(): void;
}

function createWorld(): World {
	const local = memStorage();
	let session = memStorage();
	const enqueued: BrowseOutboxEntry[] = [];
	let buffered: BrowseEvent[] = [];
	let uuidN = 0;
	const uuid = (): string => `id-${++uuidN}`;

	const build = (): AttentionCapture => {
		// Track the buffer contents through the sink so all() can interleave
		// drained + still-buffered events in capture order.
		const buffer = createBrowseBuffer({
			storage: local,
			enqueueBrowse: async (entries) => {
				enqueued.push(...entries);
				const drained = new Set(
					entries.flatMap((entry) => entry.events.map((event) => event.id)),
				);
				buffered = buffered.filter((event) => !drained.has(event.id));
			},
			uuid,
		});
		const trackedBuffer = {
			append: async (event: BrowseEvent): Promise<number> => {
				const size = await buffer.append(event);
				buffered.push(event);
				return size;
			},
			drain: () => buffer.drain(),
			size: () => buffer.size(),
		};
		return createAttentionCapture({
			buffer: trackedBuffer,
			session: createCaptureSession({ sessionStorage: session, uuid }),
			events: createEventFactory({ uuid, now: () => world.clock.t }),
			isEnabled: async () => world.enabled,
			getBaselineTarget: async () => {
				const windowId = world.focusedWindowId;
				if (windowId === undefined) return undefined;
				const tab = world.windows.get(windowId);
				if (tab?.tabId === undefined) return undefined;
				return { tabId: tab.tabId, windowId, url: tab.url, title: tab.title };
			},
			getTab: async (tabId) => {
				for (const tab of world.windows.values()) {
					if (tab.tabId === tabId) return tab;
				}
				return undefined;
			},
			getActiveTabInWindow: async (windowId) => world.windows.get(windowId),
			flush: async () => {},
		});
	};

	const world: World = {
		clock: { t: T0 },
		enabled: false,
		windows: new Map(),
		focusedWindowId: undefined,
		capture: undefined as unknown as AttentionCapture,
		all: () => [...enqueued.flatMap((entry) => entry.events), ...buffered],
		workerRestart: () => {
			world.capture = build();
		},
		browserRestart: () => {
			session = memStorage();
			world.capture = build();
		},
	};
	world.capture = build();
	return world;
}

// Scenario verbs — each mirrors the Chrome event background.ts translates.

async function enable(world: World, s: number): Promise<void> {
	world.clock.t = at(s);
	world.enabled = true;
	await world.capture.handleToggleChange({ enabled: false }, { enabled: true });
}

async function disable(world: World, s: number): Promise<void> {
	world.clock.t = at(s);
	world.enabled = false;
	await world.capture.handleToggleChange({ enabled: true }, { enabled: false });
}

async function activateTab(
	world: World,
	s: number,
	windowId: number,
	tab: TabInfo,
): Promise<void> {
	world.clock.t = at(s);
	world.windows.set(windowId, tab);
	if (tab.tabId === undefined) throw new Error("tab needs an id");
	await world.capture.recordTabActivated({ tabId: tab.tabId, windowId });
}

async function focusWindow(
	world: World,
	s: number,
	windowId: number,
): Promise<void> {
	world.clock.t = at(s);
	world.focusedWindowId = windowId;
	await world.capture.recordWindowFocus(windowId);
}

async function blurChrome(world: World, s: number): Promise<void> {
	world.clock.t = at(s);
	world.focusedWindowId = undefined;
	await world.capture.recordWindowBlur();
}

async function goIdle(
	world: World,
	s: number,
	state: "active" | "idle" | "locked",
): Promise<void> {
	world.clock.t = at(s);
	await world.capture.recordIdle(state);
}

async function navigate(
	world: World,
	s: number,
	tabId: number,
	url: string,
	transition?: string,
): Promise<void> {
	world.clock.t = at(s);
	await world.capture.recordNav({
		tabId,
		url,
		occurredAtMs: at(s),
		transition,
	});
}

const TAB_A: TabInfo = { tabId: 10, url: "https://a.example/", title: "A" };
const TAB_B: TabInfo = { tabId: 11, url: "https://b.example/", title: "B" };
const TAB_C: TabInfo = { tabId: 20, url: "https://c.example/", title: "C" };

/** A world with window 1 focused on tab A — the common starting point. */
function focusedWorld(): World {
	const world = createWorld();
	world.windows.set(1, TAB_A);
	world.focusedWindowId = 1;
	return world;
}

// ---------------------------------------------------------------------------

describe("dwell-edge sufficiency (SPEC §13 slicing rule over the real stream)", () => {
	it("(a) tab A → tab B → app switch (blur) → back (focus)", async () => {
		const world = focusedWorld();
		await enable(world, 0); // capture_start + baseline tab_activated(A)
		await activateTab(world, 10, 1, TAB_B);
		await blurChrome(world, 20);
		await focusWindow(world, 30, 1); // window_focus enriched with tab B
		await disable(world, 40); // capture_stop closes the last interval

		const slices = sliceDwell(world.all());
		expect(dwellMsByTab(slices)).toEqual(
			new Map([
				[10, 10_000],
				[11, 20_000], // 10→20 and 30→40; the blurred 20→30 is NOT dwell
			]),
		);
		expect(totalDwellMs(slices)).toBe(30_000);
	});

	it("(b) focused tab + idle 60s+ → active again", async () => {
		const world = focusedWorld();
		await enable(world, 0);
		await goIdle(world, 100, "idle");
		await goIdle(world, 160, "active");
		await disable(world, 200);

		const slices = sliceDwell(world.all());
		// 0→100 and 160→200; the idle 100→160 stretch is excluded.
		expect(dwellMsByTab(slices)).toEqual(new Map([[10, 140_000]]));
		expect(totalDwellMs(slices)).toBe(140_000);
	});

	it("(c) browser quit + restart next morning — the overnight gap is NOT dwell", async () => {
		const world = focusedWorld();
		await enable(world, 0);
		await navigate(world, 60, 10, "https://a.example/deep", "link");
		// Browser quits: MV3 leaves NO shutdown edge. 11 hours pass.
		world.browserRestart();
		const morning = 60 + 11 * 3_600;
		world.clock.t = at(morning);
		await world.capture.start(); // startup: fresh bootId, capture_start + baseline
		await disable(world, morning + 30);

		const stream = world.all();
		// Two capture sessions: the restart minted a fresh bootId.
		expect(new Set(stream.map((event) => event.bootId)).size).toBe(2);
		expect(
			stream.filter((event) => event.kind === "capture_start"),
		).toHaveLength(2);

		const slices = sliceDwell(stream);
		// 60s before the quit + 30s after the relaunch — and NOT 11 hours:
		// dwell is only valid between same-bootId events.
		expect(totalDwellMs(slices)).toBe(90_000);
		for (const slice of slices) {
			expect(slice.end - slice.start).toBeLessThanOrEqual(60_000);
		}
	});

	it("(d) toggle off mid-session, on again later — the off gap is NOT dwell", async () => {
		const world = focusedWorld();
		await enable(world, 0);
		await disable(world, 50); // capture_stop, session cleared
		await enable(world, 300); // NEW bootId + capture_start + baseline
		await disable(world, 350);

		const stream = world.all();
		expect(new Set(stream.map((event) => event.bootId)).size).toBe(2);

		const slices = sliceDwell(stream);
		expect(dwellMsByTab(slices)).toEqual(new Map([[10, 100_000]]));
		// Nothing inside the off window [50s, 300s) is attributable.
		for (const slice of slices) {
			const insideOffGap = slice.start >= at(50) && slice.end <= at(300);
			expect(insideOffGap).toBe(false);
		}
	});

	it("(e) two windows — window_focus carries enough to know which tab is dwelt", async () => {
		const world = focusedWorld();
		world.windows.set(2, TAB_C);
		await enable(world, 0);
		await focusWindow(world, 10, 2); // enriched with window 2's active tab C
		await focusWindow(world, 20, 1); // back — enriched with tab A
		await disable(world, 30);

		const slices = sliceDwell(world.all());
		expect(dwellMsByTab(slices)).toEqual(
			new Map([
				[10, 20_000],
				[20, 10_000],
			]),
		);
	});

	it("(e2) failed window_focus enrichment degrades to unknown, never misattributes", async () => {
		const world = focusedWorld();
		// Window 2 exists but its active-tab lookup fails (no entry).
		await enable(world, 0);
		await focusWindow(world, 10, 2); // bare window_focus — no tabId
		await focusWindow(world, 20, 1);
		await disable(world, 30);

		const slices = sliceDwell(world.all());
		// 10→20 is unknown (window 2's tab was never learned) — it must show up
		// as NO dwell rather than as tab A's.
		expect(dwellMsByTab(slices)).toEqual(new Map([[10, 20_000]]));
		expect(totalDwellMs(slices)).toBe(20_000);
	});

	it("(f) SPA navigation within the dwelt tab keeps attribution, slices by URL", async () => {
		const world = focusedWorld();
		await enable(world, 0);
		await navigate(world, 30, 10, "https://a.example/two", "link");
		await navigate(
			world,
			60,
			10,
			"https://a.example/three",
			"link|forward_back",
		);
		await disable(world, 90);

		const slices = sliceDwell(world.all());
		// Nav edges never break the tab's dwell...
		expect(dwellMsByTab(slices)).toEqual(new Map([[10, 90_000]]));
		// ...and carry enough to attribute time per URL.
		expect(dwellMsByUrl(slices)).toEqual(
			new Map<string | undefined, number>([
				["https://a.example/", 30_000],
				["https://a.example/two", 30_000],
				["https://a.example/three", 30_000],
			]),
		);
	});

	it("(g) worker death mid-session leaves NO spurious boundary", async () => {
		const world = focusedWorld();
		await enable(world, 0);
		await activateTab(world, 30, 1, TAB_B);
		// The service worker dies and revives: same storages, new instance,
		// no start() (revival is not browser startup — listeners just re-fire).
		world.workerRestart();
		await navigate(world, 60, 11, "https://b.example/deep", "link");
		await disable(world, 90);

		const stream = world.all();
		// One session end to end: no fresh bootId, no extra capture_start/stop.
		expect(new Set(stream.map((event) => event.bootId)).size).toBe(1);
		expect(
			stream.filter((event) => event.kind === "capture_start"),
		).toHaveLength(1);
		expect(
			stream.filter((event) => event.kind === "capture_stop"),
		).toHaveLength(1);

		const slices = sliceDwell(stream);
		// Tab B's dwell runs 30→90 uninterrupted through the death.
		expect(dwellMsByTab(slices)).toEqual(
			new Map([
				[10, 30_000],
				[11, 60_000],
			]),
		);
	});

	it("(h) enabling while no window has focus starts the stream blurred", async () => {
		const world = createWorld(); // no focused window at all
		world.windows.set(1, TAB_A);
		await enable(world, 0); // baseline skipped (§13)
		await focusWindow(world, 20, 1);
		await disable(world, 50);

		const slices = sliceDwell(world.all());
		// Nothing before the first window_focus is attributable.
		expect(dwellMsByTab(slices)).toEqual(new Map([[10, 30_000]]));
		expect(totalDwellMs(slices)).toBe(30_000);
	});
});
