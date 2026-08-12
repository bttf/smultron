import { describe, expect, it, vi } from "vitest";
import {
	createBrowseBuffer,
	createCaptureSession,
	createEventFactory,
	formatTransition,
	isCaptureEnabled,
	parseAttentionToggle,
	shouldDrainAfterAppend,
} from "./attention";
import type { BrowseEvent, BrowseOutboxEntry, KeyValueStorage } from "./types";
import {
	BOOT_ID_KEY,
	BROWSE_BUFFER_CAP,
	BROWSE_BUFFER_KEY,
	BROWSE_DOCUMENT_LIFECYCLE_LIMIT,
	BROWSE_TITLE_LIMIT,
	BROWSE_TRANSITION_LIMIT,
	BROWSE_URL_LIMIT,
	MAX_TIMESTAMP_MS,
} from "./types";

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

/** Deterministic uuids so assertions can name the ids they expect. */
function counterUuid(prefix = "id"): () => string {
	let n = 0;
	return () => `${prefix}-${++n}`;
}

function event(id: string, bootId = "boot"): BrowseEvent {
	return { id, bootId, kind: "window_blur", occurredAtMs: 1_000 };
}

function bufferOf(storage: FakeStorage): BrowseEvent[] {
	return (storage.data[BROWSE_BUFFER_KEY] as BrowseEvent[] | undefined) ?? [];
}

function bufferIds(storage: FakeStorage): string[] {
	return bufferOf(storage).map((e) => e.id);
}

describe("isCaptureEnabled", () => {
	it("is true ONLY for {enabled: true}", () => {
		expect(isCaptureEnabled({ enabled: true })).toBe(true);
		expect(isCaptureEnabled({ enabled: false })).toBe(false);
	});

	it("treats a missing / malformed value as disabled (default OFF)", () => {
		expect(isCaptureEnabled(undefined)).toBe(false);
		expect(isCaptureEnabled(null)).toBe(false);
		expect(isCaptureEnabled({})).toBe(false);
		expect(isCaptureEnabled(true)).toBe(false);
		expect(isCaptureEnabled("enabled")).toBe(false);
		expect(isCaptureEnabled({ enabled: "true" })).toBe(false);
	});
});

describe("parseAttentionToggle", () => {
	it("classifies the two capture-session edges", () => {
		expect(parseAttentionToggle(undefined, { enabled: true })).toBe("enabled");
		expect(parseAttentionToggle({ enabled: false }, { enabled: true })).toBe(
			"enabled",
		);
		expect(parseAttentionToggle({ enabled: true }, { enabled: false })).toBe(
			"disabled",
		);
		expect(parseAttentionToggle({ enabled: true }, undefined)).toBe("disabled");
	});

	it("ignores writes that don't change the effective state", () => {
		expect(
			parseAttentionToggle({ enabled: true }, { enabled: true }),
		).toBeUndefined();
		expect(parseAttentionToggle({ enabled: false }, undefined)).toBeUndefined();
	});
});

describe("formatTransition", () => {
	it("joins type and qualifiers with |", () => {
		expect(formatTransition("typed", ["from_address_bar"])).toBe(
			"typed|from_address_bar",
		);
		expect(formatTransition("link", ["forward_back", "server_redirect"])).toBe(
			"link|forward_back|server_redirect",
		);
	});

	it("returns the bare type with no qualifiers, undefined with no type", () => {
		expect(formatTransition("link", [])).toBe("link");
		expect(formatTransition("link", undefined)).toBe("link");
		expect(formatTransition(undefined, ["forward_back"])).toBeUndefined();
		expect(formatTransition("", ["forward_back"])).toBeUndefined();
	});
});

describe("event constructors", () => {
	const events = createEventFactory({
		uuid: counterUuid("evt"),
		now: () => 1_700_000_000_000,
	});

	it("nav carries tabId + url and NEVER a title", () => {
		const nav = events.nav({
			bootId: "boot",
			tabId: 7,
			url: "https://example.com/a?b=1",
			occurredAtMs: 1_699_999_000_123,
			transition: "typed|from_address_bar",
		});
		expect(nav).toEqual({
			id: "evt-1",
			bootId: "boot",
			kind: "nav",
			occurredAtMs: 1_699_999_000_123,
			tabId: 7,
			url: "https://example.com/a?b=1",
			transition: "typed|from_address_bar",
		});
		expect("title" in nav).toBe(false);
	});

	it("nav records documentLifecycle verbatim when present", () => {
		const nav = events.nav({
			bootId: "boot",
			tabId: 1,
			url: "https://example.com/",
			documentLifecycle: "prerender",
		});
		expect(nav.documentLifecycle).toBe("prerender");
	});

	it("nav omits every optional field that wasn't supplied", () => {
		const nav = events.nav({
			bootId: "boot",
			tabId: 1,
			url: "https://a.test/",
		});
		expect(Object.keys(nav).sort()).toEqual([
			"bootId",
			"id",
			"kind",
			"occurredAtMs",
			"tabId",
			"url",
		]);
	});

	it("tab_activated always carries tabId AND windowId, enrichment optional", () => {
		const bare = events.tabActivated({ bootId: "boot", tabId: 3, windowId: 9 });
		expect(bare.tabId).toBe(3);
		expect(bare.windowId).toBe(9);
		expect("url" in bare).toBe(false);
		expect("title" in bare).toBe(false);

		const enriched = events.tabActivated({
			bootId: "boot",
			tabId: 3,
			windowId: 9,
			url: "https://example.com/",
			title: "Example",
		});
		expect(enriched.url).toBe("https://example.com/");
		expect(enriched.title).toBe("Example");
	});

	it("window_focus requires windowId; window_blur carries NO fields", () => {
		const focus = events.windowFocus({ bootId: "boot", windowId: 4, tabId: 2 });
		expect(focus.windowId).toBe(4);
		expect(focus.tabId).toBe(2);

		const blur = events.windowBlur({ bootId: "boot" });
		expect(Object.keys(blur).sort()).toEqual([
			"bootId",
			"id",
			"kind",
			"occurredAtMs",
		]);
		expect(blur.kind).toBe("window_blur");
	});

	it("idle carries only idleState; capture_start/stop carry nothing", () => {
		const idle = events.idle({ bootId: "boot", idleState: "locked" });
		expect(Object.keys(idle).sort()).toEqual([
			"bootId",
			"id",
			"idleState",
			"kind",
			"occurredAtMs",
		]);

		for (const built of [
			events.captureStart({ bootId: "boot" }),
			events.captureStop({ bootId: "boot" }),
		]) {
			expect(Object.keys(built).sort()).toEqual([
				"bootId",
				"id",
				"kind",
				"occurredAtMs",
			]);
		}
	});

	it("defaults occurredAtMs to now() and floors/clamps supplied stamps", () => {
		expect(events.windowBlur({ bootId: "boot" }).occurredAtMs).toBe(
			1_700_000_000_000,
		);
		// webNavigation timeStamps are floats — the server requires an integer.
		expect(
			events.nav({
				bootId: "boot",
				tabId: 1,
				url: "https://a.test/",
				occurredAtMs: 1_699_999_000_123.987,
			}).occurredAtMs,
		).toBe(1_699_999_000_123);
		expect(
			events.windowBlur({ bootId: "boot", occurredAtMs: -5 }).occurredAtMs,
		).toBe(0);
		expect(
			events.windowBlur({ bootId: "boot", occurredAtMs: Number.NaN })
				.occurredAtMs,
		).toBe(0);
		expect(
			events.windowBlur({ bootId: "boot", occurredAtMs: 1e18 }).occurredAtMs,
		).toBe(MAX_TIMESTAMP_MS);
	});

	it("clamps string fields to the server's §13 bounds", () => {
		const nav = events.nav({
			bootId: "boot",
			tabId: 1,
			url: `https://a.test/${"x".repeat(BROWSE_URL_LIMIT)}`,
			transition: "t".repeat(BROWSE_TRANSITION_LIMIT + 10),
			documentLifecycle: "d".repeat(BROWSE_DOCUMENT_LIFECYCLE_LIMIT + 10),
		});
		expect(nav.url).toHaveLength(BROWSE_URL_LIMIT);
		expect(nav.transition).toHaveLength(BROWSE_TRANSITION_LIMIT);
		expect(nav.documentLifecycle).toHaveLength(BROWSE_DOCUMENT_LIFECYCLE_LIMIT);

		const activated = events.tabActivated({
			bootId: "boot",
			tabId: 1,
			windowId: 1,
			title: "t".repeat(BROWSE_TITLE_LIMIT + 10),
		});
		expect(activated.title).toHaveLength(BROWSE_TITLE_LIMIT);
	});

	it("mints a unique id per event", () => {
		const a = events.windowBlur({ bootId: "boot" });
		const b = events.windowBlur({ bootId: "boot" });
		expect(a.id).not.toBe(b.id);
	});
});

describe("createCaptureSession", () => {
	it("ensure() mints and persists when storage.session is empty", async () => {
		const sessionStorage = fakeStorage();
		const session = createCaptureSession({
			sessionStorage,
			uuid: counterUuid("boot"),
		});
		expect(await session.ensure()).toEqual({ bootId: "boot-1", minted: true });
		expect(sessionStorage.data[BOOT_ID_KEY]).toBe("boot-1");
	});

	it("ensure() REUSES a stored bootId (worker death is not a boundary)", async () => {
		const sessionStorage = fakeStorage({ [BOOT_ID_KEY]: "boot-existing" });
		const uuid = vi.fn(() => "boot-new");
		const session = createCaptureSession({ sessionStorage, uuid });
		expect(await session.ensure()).toEqual({
			bootId: "boot-existing",
			minted: false,
		});
		expect(uuid).not.toHaveBeenCalled();
	});

	it("restart() ALWAYS mints a fresh bootId, replacing the stored one", async () => {
		const sessionStorage = fakeStorage({ [BOOT_ID_KEY]: "boot-old" });
		const session = createCaptureSession({
			sessionStorage,
			uuid: counterUuid("boot"),
		});
		expect(await session.restart()).toBe("boot-1");
		expect(sessionStorage.data[BOOT_ID_KEY]).toBe("boot-1");
		expect(await session.current()).toBe("boot-1");
	});

	it("current() ignores a missing or malformed stored value", async () => {
		expect(
			await createCaptureSession({
				sessionStorage: fakeStorage(),
				uuid: counterUuid(),
			}).current(),
		).toBeUndefined();
		expect(
			await createCaptureSession({
				sessionStorage: fakeStorage({ [BOOT_ID_KEY]: "" }),
				uuid: counterUuid(),
			}).current(),
		).toBeUndefined();
	});
});

describe("shouldDrainAfterAppend", () => {
	it("triggers at 50 buffered events, not before", () => {
		expect(shouldDrainAfterAppend(49)).toBe(false);
		expect(shouldDrainAfterAppend(50)).toBe(true);
		expect(shouldDrainAfterAppend(2_000)).toBe(true);
	});
});

describe("createBrowseBuffer", () => {
	function setup(initial: Record<string, unknown> = {}) {
		const storage = fakeStorage(initial);
		const enqueued: BrowseOutboxEntry[][] = [];
		const buffer = createBrowseBuffer({
			storage,
			enqueueBrowse: async (entries) => {
				enqueued.push(entries);
			},
			uuid: counterUuid("entry"),
		});
		return { storage, enqueued, buffer };
	}

	it("appends in order and reports the buffer size", async () => {
		const { storage, buffer } = setup();
		expect(await buffer.append(event("a"))).toBe(1);
		expect(await buffer.append(event("b"))).toBe(2);
		expect(bufferIds(storage)).toEqual(["a", "b"]);
		expect(await buffer.size()).toBe(2);
	});

	it("drops the OLDEST events at BROWSE_BUFFER_CAP", async () => {
		const full = Array.from({ length: BROWSE_BUFFER_CAP }, (_, i) =>
			event(`old-${i}`),
		);
		const { storage, buffer } = setup({ [BROWSE_BUFFER_KEY]: full });
		expect(await buffer.append(event("newest"))).toBe(BROWSE_BUFFER_CAP);
		const ids = bufferIds(storage);
		expect(ids).toHaveLength(BROWSE_BUFFER_CAP);
		expect(ids[0]).toBe("old-1");
		expect(ids.at(-1)).toBe("newest");
		expect(ids).not.toContain("old-0");
	});

	it("drains into ≤500-event entries and clears exactly what it drained", async () => {
		const events = Array.from({ length: 1_200 }, (_, i) => event(`e-${i}`));
		const { storage, enqueued, buffer } = setup({
			[BROWSE_BUFFER_KEY]: events,
		});

		expect(await buffer.drain()).toBe(1_200);
		expect(enqueued).toHaveLength(1);
		const entries = enqueued[0] ?? [];
		expect(entries.map((e) => e.events.length)).toEqual([500, 500, 200]);
		expect(entries.every((e) => e.kind === "browse")).toBe(true);
		expect(new Set(entries.map((e) => e.id)).size).toBe(3);
		// Order is preserved across the batches.
		expect(entries[0]?.events[0]?.id).toBe("e-0");
		expect(entries[2]?.events.at(-1)?.id).toBe("e-1199");
		expect(bufferIds(storage)).toEqual([]);
	});

	it("is a no-op on an empty buffer", async () => {
		const { enqueued, buffer } = setup();
		expect(await buffer.drain()).toBe(0);
		expect(enqueued).toEqual([]);
	});

	it("serializes appends racing INTO a drain — nothing lost, nothing double-drained", async () => {
		const storage = fakeStorage({
			[BROWSE_BUFFER_KEY]: [event("a"), event("b")],
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const enqueued: BrowseOutboxEntry[][] = [];
		const buffer = createBrowseBuffer({
			storage,
			enqueueBrowse: async (entries) => {
				// Hold the drain open right where an interleaved append would
				// otherwise slip into the read→clear window.
				await gate;
				enqueued.push(entries);
			},
			uuid: counterUuid("entry"),
		});

		const draining = buffer.drain();
		const appends = Promise.all([
			buffer.append(event("c")),
			buffer.append(event("d")),
		]);
		release();

		expect(await draining).toBe(2);
		await appends;

		// The drained pair left; the racing appends survived in order.
		expect(enqueued[0]?.[0]?.events.map((e) => e.id)).toEqual(["a", "b"]);
		expect(bufferIds(storage)).toEqual(["c", "d"]);

		// A second drain ships exactly the racers — never a re-send of a/b.
		expect(await buffer.drain()).toBe(2);
		expect(enqueued[1]?.[0]?.events.map((e) => e.id)).toEqual(["c", "d"]);
		expect(bufferIds(storage)).toEqual([]);
	});

	it("enqueues BEFORE clearing: dying in between duplicates, never loses", async () => {
		const storage = fakeStorage({
			[BROWSE_BUFFER_KEY]: [event("a"), event("b")],
		});
		const enqueued: BrowseOutboxEntry[][] = [];
		let killAfterEnqueue = true;
		const buffer = createBrowseBuffer({
			storage,
			enqueueBrowse: async (entries) => {
				enqueued.push(entries);
				if (killAfterEnqueue) {
					// The worker dies before the buffer clear persists: every
					// subsequent storage write is lost.
					storage.set = async () => {
						throw new Error("worker died");
					};
				}
			},
			uuid: counterUuid("entry"),
		});

		await expect(buffer.drain()).rejects.toThrow("worker died");
		// Zero loss: the events are still buffered.
		expect(bufferIds(storage)).toEqual(["a", "b"]);

		// Worker revived (fresh storage adapter): the same events drain again —
		// a DUPLICATE batch, which the server dedupes on clientEventId.
		killAfterEnqueue = false;
		const revived = fakeStorage({ [BROWSE_BUFFER_KEY]: bufferOf(storage) });
		storage.set = revived.set;
		storage.get = revived.get;
		expect(await buffer.drain()).toBe(2);
		expect(enqueued).toHaveLength(2);
		expect(enqueued[1]?.[0]?.events.map((e) => e.id)).toEqual(["a", "b"]);
		expect(bufferIds(revived)).toEqual([]);
	});

	it("keeps serving appends after a failed drain (the mutex never wedges)", async () => {
		const storage = fakeStorage({ [BROWSE_BUFFER_KEY]: [event("a")] });
		let fail = true;
		const buffer = createBrowseBuffer({
			storage,
			enqueueBrowse: async () => {
				if (fail) throw new Error("outbox unavailable");
			},
			uuid: counterUuid("entry"),
		});
		await expect(buffer.drain()).rejects.toThrow("outbox unavailable");
		// The buffer still works, and the failed drain kept its events.
		expect(await buffer.append(event("b"))).toBe(2);
		expect(bufferIds(storage)).toEqual(["a", "b"]);
		fail = false;
		expect(await buffer.drain()).toBe(2);
		expect(bufferIds(storage)).toEqual([]);
	});
});
