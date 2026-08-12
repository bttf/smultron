import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBrowseBuffer,
	createCaptureSession,
	createEventFactory,
} from "./attention";
import {
	type BaselineTarget,
	createAttentionCapture,
	type TabInfo,
} from "./attentionCapture";
import type { BrowseEvent, BrowseOutboxEntry, KeyValueStorage } from "./types";
import { BOOT_ID_KEY, BROWSE_BUFFER_KEY } from "./types";

interface FakeStorage extends KeyValueStorage {
	data: Record<string, unknown>;
}

function fakeStorage(initial: Record<string, unknown> = {}): FakeStorage {
	const data: Record<string, unknown> = structuredClone(initial);
	return {
		data,
		get: async (key) => structuredClone(data[key]),
		set: async (key, value) => {
			data[key] = structuredClone(value);
		},
	};
}

function counterUuid(prefix: string): () => string {
	let n = 0;
	return () => `${prefix}-${++n}`;
}

type TabLookup = (id: number) => Promise<TabInfo | undefined>;

interface Harness {
	capture: ReturnType<typeof createAttentionCapture>;
	storage: FakeStorage;
	sessionStorage: FakeStorage;
	enqueued: BrowseOutboxEntry[];
	flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
	getTab: ReturnType<typeof vi.fn<TabLookup>>;
	getActiveTabInWindow: ReturnType<typeof vi.fn<TabLookup>>;
	getBaselineTarget: ReturnType<
		typeof vi.fn<() => Promise<BaselineTarget | undefined>>
	>;
	buffered: () => BrowseEvent[];
	/** Everything captured: still buffered + already drained, in order. */
	all: () => BrowseEvent[];
}

function harness(options: {
	enabled?: boolean;
	bootId?: string;
	baselineTarget?: BaselineTarget;
	buffer?: BrowseEvent[];
}): Harness {
	const storage = fakeStorage(
		options.buffer === undefined ? {} : { [BROWSE_BUFFER_KEY]: options.buffer },
	);
	const sessionStorage = fakeStorage(
		options.bootId === undefined ? {} : { [BOOT_ID_KEY]: options.bootId },
	);
	const enqueued: BrowseOutboxEntry[] = [];
	const buffer = createBrowseBuffer({
		storage,
		enqueueBrowse: async (entries) => {
			enqueued.push(...entries);
		},
		uuid: counterUuid("entry"),
	});
	const flush = vi.fn<() => Promise<void>>(async () => {});
	const getTab = vi.fn<TabLookup>(async () => undefined);
	const getActiveTabInWindow = vi.fn<TabLookup>(async () => undefined);
	const getBaselineTarget = vi.fn<() => Promise<BaselineTarget | undefined>>(
		async () => options.baselineTarget,
	);

	const capture = createAttentionCapture({
		buffer,
		session: createCaptureSession({
			sessionStorage,
			uuid: counterUuid("boot"),
		}),
		events: createEventFactory({
			uuid: counterUuid("evt"),
			now: () => 1_700_000_000_000,
		}),
		isEnabled: async () => options.enabled === true,
		getBaselineTarget,
		getTab,
		getActiveTabInWindow,
		flush,
	});

	const buffered = (): BrowseEvent[] =>
		(storage.data[BROWSE_BUFFER_KEY] as BrowseEvent[] | undefined) ?? [];

	return {
		capture,
		storage,
		sessionStorage,
		enqueued,
		flush,
		getTab,
		getActiveTabInWindow,
		getBaselineTarget,
		buffered,
		all: () => [...enqueued.flatMap((entry) => entry.events), ...buffered()],
	};
}

describe("capture gating (toggle OFF = zero capture)", () => {
	let off: Harness;

	beforeEach(() => {
		off = harness({ enabled: false });
	});

	it("records nothing and observes nothing while disabled", async () => {
		await off.capture.recordNav({ tabId: 1, url: "https://a.test/" });
		await off.capture.recordTabActivated({ tabId: 1, windowId: 2 });
		await off.capture.recordWindowFocus(2);
		await off.capture.recordWindowBlur();
		await off.capture.recordIdle("idle");

		expect(off.all()).toEqual([]);
		// Not even enrichment: nothing is looked up, nothing is queried.
		expect(off.getTab).not.toHaveBeenCalled();
		expect(off.getActiveTabInWindow).not.toHaveBeenCalled();
		expect(off.getBaselineTarget).not.toHaveBeenCalled();
		// And no capture session is minted while off.
		expect(off.sessionStorage.data[BOOT_ID_KEY]).toBeUndefined();
	});

	it("start() ships leftovers but begins no session while disabled", async () => {
		const leftovers = harness({
			enabled: false,
			buffer: [
				{
					id: "left-1",
					bootId: "boot-prev",
					kind: "window_blur",
					occurredAtMs: 1,
				},
			],
		});
		await leftovers.capture.start();
		// Captured while the toggle was ON — they still drain (SPEC §13).
		expect(
			leftovers.enqueued.flatMap((e) => e.events).map((e) => e.id),
		).toEqual(["left-1"]);
		expect(leftovers.flush).toHaveBeenCalledTimes(1);
		expect(leftovers.sessionStorage.data[BOOT_ID_KEY]).toBeUndefined();
	});
});

describe("capture-session boundaries", () => {
	it("mints a bootId + capture_start + baseline on the first event of a boot", async () => {
		const h = harness({
			enabled: true,
			baselineTarget: {
				tabId: 5,
				windowId: 3,
				url: "https://start.test/",
				title: "Start",
			},
		});
		await h.capture.recordIdle("active");

		const events = h.all();
		expect(events.map((e) => e.kind)).toEqual([
			"capture_start",
			"tab_activated",
			"idle",
		]);
		expect(new Set(events.map((e) => e.bootId))).toEqual(new Set(["boot-1"]));
		expect(events[1]).toMatchObject({
			kind: "tab_activated",
			tabId: 5,
			windowId: 3,
			url: "https://start.test/",
			title: "Start",
		});
		expect(h.sessionStorage.data[BOOT_ID_KEY]).toBe("boot-1");
	});

	it("skips the baseline when no window has focus", async () => {
		const h = harness({ enabled: true, baselineTarget: undefined });
		await h.capture.recordWindowBlur();
		expect(h.all().map((e) => e.kind)).toEqual([
			"capture_start",
			"window_blur",
		]);
	});

	it("REUSES a stored bootId after worker death — no capture_start, no baseline", async () => {
		const h = harness({
			enabled: true,
			bootId: "boot-alive",
			baselineTarget: { tabId: 1, windowId: 1 },
		});
		await h.capture.recordWindowBlur();
		await h.capture.recordIdle("idle");

		const events = h.all();
		expect(events.map((e) => e.kind)).toEqual(["window_blur", "idle"]);
		expect(events.every((e) => e.bootId === "boot-alive")).toBe(true);
		expect(h.getBaselineTarget).not.toHaveBeenCalled();
	});

	it("mints ONE session under concurrent events", async () => {
		const h = harness({ enabled: true, baselineTarget: undefined });
		await Promise.all([
			h.capture.recordWindowBlur(),
			h.capture.recordIdle("idle"),
			h.capture.recordWindowBlur(),
		]);
		const events = h.all();
		expect(events.filter((e) => e.kind === "capture_start")).toHaveLength(1);
		expect(new Set(events.map((e) => e.bootId))).toEqual(new Set(["boot-1"]));
	});

	it("start() begins the session when the toggle is on (browser startup)", async () => {
		const h = harness({
			enabled: true,
			baselineTarget: { tabId: 9, windowId: 1 },
		});
		await h.capture.start();
		expect(h.enqueued.flatMap((e) => e.events).map((e) => e.kind)).toEqual([
			"capture_start",
			"tab_activated",
		]);
		expect(h.flush).toHaveBeenCalled();
	});

	it("start() after a worker restart mid-session emits NOTHING", async () => {
		const h = harness({ enabled: true, bootId: "boot-alive" });
		await h.capture.start();
		expect(h.all()).toEqual([]);
	});
});

describe("toggle reactions", () => {
	it("enable → fresh bootId + capture_start + baseline, then drain + flush", async () => {
		const h = harness({
			enabled: true,
			bootId: "boot-stale",
			baselineTarget: { tabId: 2, windowId: 4, url: "https://x.test/" },
		});
		await h.capture.handleToggleChange({ enabled: false }, { enabled: true });

		// A NEW session even though storage.session still held the old id: dwell
		// must never be computed across the off gap.
		expect(h.sessionStorage.data[BOOT_ID_KEY]).toBe("boot-1");
		const shipped = h.enqueued.flatMap((e) => e.events);
		expect(shipped.map((e) => e.kind)).toEqual([
			"capture_start",
			"tab_activated",
		]);
		expect(shipped.every((e) => e.bootId === "boot-1")).toBe(true);
		expect(h.flush).toHaveBeenCalledTimes(1);
		expect(h.buffered()).toEqual([]);
	});

	it("disable → capture_stop under the CURRENT bootId, then drain + flush", async () => {
		// The toggle is already off by the time the change lands — capture_stop
		// is the capture's own final edge and must be recorded anyway (§13).
		const h = harness({ enabled: false, bootId: "boot-live" });
		await h.capture.handleToggleChange({ enabled: true }, { enabled: false });

		const shipped = h.enqueued.flatMap((e) => e.events);
		expect(shipped).toHaveLength(1);
		expect(shipped[0]).toMatchObject({
			kind: "capture_stop",
			bootId: "boot-live",
		});
		expect(h.flush).toHaveBeenCalledTimes(1);
	});

	it("disable with no session records nothing and flushes nothing", async () => {
		const h = harness({ enabled: false });
		await h.capture.handleToggleChange({ enabled: true }, { enabled: false });
		expect(h.all()).toEqual([]);
		// Nothing drained → no flush (the retry cadence stays the outbox's).
		expect(h.flush).not.toHaveBeenCalled();
	});

	it("clears the bootId at the disable edge, so a raced event opens a NEW boot", async () => {
		const h = harness({ enabled: false, bootId: "boot-live" });
		await h.capture.handleToggleChange({ enabled: true }, { enabled: false });
		expect(h.sessionStorage.data[BOOT_ID_KEY]).toBe("");

		// A listener that got past the gate before the toggle landed must not
		// record under the stopped boot, after its own capture_stop.
		const raced = harness({ enabled: true, bootId: "" });
		await raced.capture.recordWindowBlur();
		const kinds = raced.all();
		expect(kinds.map((e) => e.kind)).toEqual(["capture_start", "window_blur"]);
		expect(kinds.every((e) => e.bootId === "boot-1")).toBe(true);
	});

	it("a re-enable after a disable mints ANOTHER fresh bootId", async () => {
		const h = harness({ enabled: true, baselineTarget: undefined });
		await h.capture.handleToggleChange(undefined, { enabled: true });
		await h.capture.handleToggleChange({ enabled: true }, { enabled: false });
		await h.capture.handleToggleChange({ enabled: false }, { enabled: true });

		const kinds = h.enqueued.flatMap((e) => e.events);
		expect(kinds.map((e) => e.kind)).toEqual([
			"capture_start",
			"capture_stop",
			"capture_start",
		]);
		expect(kinds[0]?.bootId).toBe("boot-1");
		expect(kinds[1]?.bootId).toBe("boot-1");
		expect(kinds[2]?.bootId).toBe("boot-2");
	});

	it("ignores a no-op write of the toggle key", async () => {
		const h = harness({ enabled: true, bootId: "boot-live" });
		await h.capture.handleToggleChange({ enabled: true }, { enabled: true });
		expect(h.all()).toEqual([]);
		expect(h.flush).not.toHaveBeenCalled();
		expect(h.sessionStorage.data[BOOT_ID_KEY]).toBe("boot-live");
	});
});

describe("recording", () => {
	it("nav keeps the event's own timestamp, transition and lifecycle", async () => {
		const h = harness({ enabled: true, bootId: "boot-live" });
		await h.capture.recordNav({
			tabId: 12,
			url: "https://example.com/watch?v=1",
			occurredAtMs: 1_699_000_000_500.4,
			transition: "link|forward_back",
			documentLifecycle: "prerender",
		});
		expect(h.all()[0]).toEqual({
			id: "evt-1",
			bootId: "boot-live",
			kind: "nav",
			occurredAtMs: 1_699_000_000_500,
			tabId: 12,
			url: "https://example.com/watch?v=1",
			transition: "link|forward_back",
			documentLifecycle: "prerender",
		});
	});

	it("skips a nav with an empty url entirely — never on the wire, no session side effects", async () => {
		// Defensive: `url` is required for nav with a server bound of min(1),
		// so an empty url would 400 — and poison-drop — its whole batch.
		// webNavigation always supplies a url in practice; if one ever arrives
		// empty, the event is skipped before the gate (no session minted, no
		// capture_start emitted for it).
		const h = harness({ enabled: true });
		await h.capture.recordNav({ tabId: 12, url: "" });
		expect(h.all()).toEqual([]);
		expect(h.sessionStorage.data).toEqual({});
	});

	it("tab_activated enriches via tabs.get", async () => {
		const h = harness({ enabled: true, bootId: "boot-live" });
		h.getTab.mockResolvedValue({
			tabId: 4,
			url: "https://a.test/",
			title: "A",
		});
		await h.capture.recordTabActivated({ tabId: 4, windowId: 7 });
		expect(h.all()[0]).toMatchObject({
			kind: "tab_activated",
			tabId: 4,
			windowId: 7,
			url: "https://a.test/",
			title: "A",
		});
	});

	it("tab_activated is still recorded when the lookup fails", async () => {
		const h = harness({ enabled: true, bootId: "boot-live" });
		h.getTab.mockResolvedValue(undefined);
		await h.capture.recordTabActivated({ tabId: 4, windowId: 7 });
		const event = h.all()[0];
		expect(event).toMatchObject({
			kind: "tab_activated",
			tabId: 4,
			windowId: 7,
		});
		expect(event !== undefined && "url" in event).toBe(false);
		expect(event !== undefined && "title" in event).toBe(false);
	});

	it("omits Chrome's empty pre-commit url/title from enrichment and the baseline", async () => {
		const h = harness({ enabled: true, bootId: "boot-live" });
		// A tab opened with ⌘T reports url "" and title "" until it commits.
		h.getTab.mockResolvedValue({ tabId: 4, url: "", title: "" });
		await h.capture.recordTabActivated({ tabId: 4, windowId: 7 });
		const activated = h.all()[0];
		expect(activated).toMatchObject({ kind: "tab_activated", tabId: 4 });
		expect(activated !== undefined && "url" in activated).toBe(false);
		expect(activated !== undefined && "title" in activated).toBe(false);

		const baseline = harness({
			enabled: true,
			baselineTarget: { tabId: 1, windowId: 1, url: "", title: "" },
		});
		await baseline.capture.recordWindowBlur();
		const synthetic = baseline.all()[1];
		expect(synthetic?.kind).toBe("tab_activated");
		expect(synthetic !== undefined && "url" in synthetic).toBe(false);
	});

	it("window_focus enriches with that window's active tab; blur carries nothing", async () => {
		const h = harness({ enabled: true, bootId: "boot-live" });
		h.getActiveTabInWindow.mockResolvedValue({
			tabId: 8,
			url: "https://b.test/",
			title: "B",
		});
		await h.capture.recordWindowFocus(3);
		await h.capture.recordWindowBlur();

		const [focus, blur] = h.all();
		expect(h.getActiveTabInWindow).toHaveBeenCalledWith(3);
		expect(focus).toMatchObject({
			kind: "window_focus",
			windowId: 3,
			tabId: 8,
			url: "https://b.test/",
			title: "B",
		});
		expect(Object.keys(blur ?? {}).sort()).toEqual([
			"bootId",
			"id",
			"kind",
			"occurredAtMs",
		]);
	});

	it("idle carries the state", async () => {
		const h = harness({ enabled: true, bootId: "boot-live" });
		await h.capture.recordIdle("locked");
		expect(h.all()[0]).toMatchObject({ kind: "idle", idleState: "locked" });
	});
});

describe("drain triggers", () => {
	it("drains as soon as the buffer reaches 50 events", async () => {
		const h = harness({ enabled: true, bootId: "boot-live" });
		for (let i = 0; i < 49; i++) await h.capture.recordWindowBlur();
		expect(h.enqueued).toEqual([]);
		expect(h.flush).not.toHaveBeenCalled();
		expect(h.buffered()).toHaveLength(49);

		await h.capture.recordWindowBlur();
		expect(h.enqueued).toHaveLength(1);
		expect(h.enqueued[0]?.events).toHaveLength(50);
		expect(h.flush).toHaveBeenCalledTimes(1);
		expect(h.buffered()).toEqual([]);
	});

	it("drainAndFlush ships the buffer (the 1-minute alarm path)", async () => {
		const h = harness({ enabled: true, bootId: "boot-live" });
		await h.capture.recordIdle("active");
		expect(h.enqueued).toEqual([]);

		await h.capture.drainAndFlush();
		expect(h.enqueued.flatMap((e) => e.events)).toHaveLength(1);
		expect(h.flush).toHaveBeenCalledTimes(1);
	});

	it("the drain alarm does NOT flush on an empty buffer", async () => {
		// Otherwise the 1-minute drain silently becomes a 1-minute retry for a
		// halted queue, overriding the outbox's designed 5-minute cadence.
		const h = harness({ enabled: true, bootId: "boot-live" });
		await h.capture.drainAndFlush();
		expect(h.flush).not.toHaveBeenCalled();
	});
});
