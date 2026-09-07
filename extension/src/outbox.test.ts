import { describe, expect, it, vi } from "vitest";
import { createEventFactory } from "./attention";
import {
	type BlobKeyValueStorage,
	createBrowseEntry,
	createEntry,
	createHighlightEntry,
	createOutbox,
	type FetchLike,
	type MinimalResponse,
	toBrowseEventInput,
} from "./outbox";
import type {
	BrowseEvent,
	BrowseOutboxEntry,
	HighlightOutboxEntry,
	OutboxEntry,
	ScreenshotOutboxEntry,
	SyncOutboxEntry,
} from "./types";
import {
	BROWSE_OUTBOX_ENTRY_CAP,
	CONFIG_KEY,
	OUTBOX_KEY,
	SCREENSHOT_BLOB_PREFIX,
	SCREENSHOT_MAX_ATTEMPTS,
	SCREENSHOT_OUTBOX_ENTRY_CAP,
} from "./types";

const OK: MinimalResponse = { ok: true, status: 200 };

interface FakeStorage extends BlobKeyValueStorage {
	data: Record<string, unknown>;
	/** Every key written or removed, in order — the write-order assertions. */
	writes: string[];
}

function fakeStorage(initial: Record<string, unknown> = {}): FakeStorage {
	const data: Record<string, unknown> = structuredClone(initial);
	const writes: string[] = [];
	return {
		data,
		writes,
		get: async (key) => structuredClone(data[key]),
		set: async (key, value) => {
			writes.push(`set:${key}`);
			data[key] = structuredClone(value);
		},
		remove: async (key) => {
			writes.push(`remove:${key}`);
			delete data[key];
		},
	};
}

/** JSON bodies only — a screenshot entry's body is raw bytes. */
function jsonBody(body: string | Uint8Array<ArrayBuffer> | undefined): unknown {
	return JSON.parse(typeof body === "string" ? body : "null");
}

function entry(
	id: string,
	mode: "live" | "backfill" = "live",
): SyncOutboxEntry {
	// Deliberately no `kind` field: this is the legacy persisted shape, which
	// must keep routing as sync everywhere (backward compat).
	return {
		id,
		mode,
		bookmarks: [
			{
				url: `https://example.com/${id}`,
				title: `Bookmark ${id}`,
				chromeId: `chrome-${id}`,
				dateAddedMs: 1_700_000_000_000,
				folderPath: "Bookmarks Bar/Dev",
			},
		],
	};
}

function highlight(id: string): HighlightOutboxEntry {
	return {
		id,
		kind: "highlight",
		url: `https://example.com/${id}`,
		text: `Highlight ${id}`,
	};
}

/** Deterministic uuids for factory-built wire assertions. */
function counterUuid(prefix: string): () => string {
	let n = 0;
	return () => `${prefix}-${++n}`;
}

function browseEvent(
	id: string,
	overrides: Partial<BrowseEvent> = {},
): BrowseEvent {
	return {
		id,
		bootId: "boot-1",
		kind: "window_blur",
		occurredAtMs: 1_700_000_000_000,
		...overrides,
	};
}

function browse(id: string, events: BrowseEvent[] = [browseEvent(`e-${id}`)]) {
	const entry: BrowseOutboxEntry = { id, kind: "browse", events };
	return entry;
}

const configured = {
	[CONFIG_KEY]: { token: "tok-123", baseUrl: "https://api.test" },
};

function queueIds(storage: FakeStorage): string[] {
	const queue = (storage.data[OUTBOX_KEY] as OutboxEntry[] | undefined) ?? [];
	return queue.map((e) => e.id);
}

describe("enqueue", () => {
	it("persists entries to storage in FIFO order", async () => {
		const storage = fakeStorage();
		const outbox = createOutbox({ storage, fetchFn: vi.fn<FetchLike>() });
		await outbox.enqueue(entry("a"));
		await outbox.enqueue(entry("b"));
		await outbox.enqueue(entry("c"));
		expect(queueIds(storage)).toEqual(["a", "b", "c"]);
	});

	it("createEntry assigns unique ids and keeps mode/bookmarks", () => {
		const bookmarks = entry("x").bookmarks;
		const one = createEntry("backfill", bookmarks);
		const two = createEntry("backfill", bookmarks);
		expect(one.mode).toBe("backfill");
		expect(one.kind).toBe("sync");
		expect(one.bookmarks).toEqual(bookmarks);
		expect(one.id).not.toBe(two.id);
	});

	it("createHighlightEntry assigns unique ids and keeps kind/url/text", () => {
		const one = createHighlightEntry("https://example.com/a", "snippet");
		const two = createHighlightEntry("https://example.com/a", "snippet");
		expect(one.kind).toBe("highlight");
		expect(one.url).toBe("https://example.com/a");
		expect(one.text).toBe("snippet");
		expect(one.id).not.toBe(two.id);
	});
});

describe("flush", () => {
	it("posts entries in FIFO order with correct URL, headers, and body", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [entry("a"), entry("b", "backfill")],
		});
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();

		expect(fetchFn).toHaveBeenCalledTimes(2);
		const [url, init] = fetchFn.mock.calls[0] ?? [];
		expect(url).toBe("https://api.test/api/sync");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer tok-123",
		});
		// Body is the SPEC §8 payload — mode + bookmarks only, no outbox id.
		expect(jsonBody(init?.body)).toEqual({
			mode: "live",
			bookmarks: entry("a").bookmarks,
		});
		expect(jsonBody(fetchFn.mock.calls[1]?.[1].body)).toEqual({
			mode: "backfill",
			bookmarks: entry("b").bookmarks,
		});
	});

	it("removes exactly the acked entry on 2xx and continues with later entries", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [entry("a"), entry("b")],
		});
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(queueIds(storage)).toEqual([]);
	});

	it("stops on network error, keeping the failed entry and everything after it in order", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [entry("a"), entry("b"), entry("c")],
		});
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValueOnce(OK)
			.mockRejectedValueOnce(new Error("offline"));
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(queueIds(storage)).toEqual(["b", "c"]);
	});

	it("stops on non-2xx, keeping the failed entry and everything after it in order", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [entry("a"), entry("b"), entry("c")],
		});
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValueOnce(OK)
			.mockResolvedValueOnce({ ok: false, status: 500 });
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(queueIds(storage)).toEqual(["b", "c"]);
	});

	it("retries from the failed entry on the next flush", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [entry("a"), entry("b")],
		});
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValueOnce({ ok: false, status: 503 });
		const outbox = createOutbox({ storage, fetchFn });
		await outbox.flush();
		expect(queueIds(storage)).toEqual(["a", "b"]);

		fetchFn.mockResolvedValue(OK);
		await outbox.flush();
		expect(queueIds(storage)).toEqual([]);
		// Call 1 = failed "a"; calls 2 and 3 = retried "a" then "b".
		const posted = fetchFn.mock.calls.map(
			([, init]) =>
				(jsonBody(init.body) as { bookmarks: Array<{ chromeId: string }> })
					.bookmarks[0]?.chromeId,
		);
		expect(posted).toEqual(["chrome-a", "chrome-a", "chrome-b"]);
	});

	it("is a no-op when no token is configured: no fetch, queue untouched", async () => {
		const storage = fakeStorage({ [OUTBOX_KEY]: [entry("a")] });
		const fetchFn = vi.fn<FetchLike>();
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(queueIds(storage)).toEqual(["a"]);
	});

	it("falls back to the default base URL when only a token is configured", async () => {
		const storage = fakeStorage({
			[CONFIG_KEY]: { token: "tok-123" },
			[OUTBOX_KEY]: [entry("a")],
		});
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledWith(
			"https://smultron.redpine.software/api/sync",
			expect.anything(),
		);
	});

	it("posts each entry exactly once when flushes overlap (in-flight guard)", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [entry("a"), entry("b")],
		});
		// Gate the first POST so the first flush is provably still in flight
		// when the second one starts.
		let release: (r: MinimalResponse) => void = () => {};
		const gate = new Promise<MinimalResponse>((resolve) => {
			release = resolve;
		});
		const fetchFn = vi
			.fn<FetchLike>()
			.mockImplementationOnce(() => gate)
			.mockResolvedValue(OK);
		const outbox = createOutbox({ storage, fetchFn });

		const first = outbox.flush();
		const second = outbox.flush(); // overlapping call
		await second; // guard: returns immediately without sending anything
		release(OK);
		await first;

		expect(fetchFn).toHaveBeenCalledTimes(2);
		const posted = fetchFn.mock.calls.map(
			([, init]) =>
				(jsonBody(init.body) as { bookmarks: Array<{ chromeId: string }> })
					.bookmarks[0]?.chromeId,
		);
		expect(posted).toEqual(["chrome-a", "chrome-b"]);
		expect(queueIds(storage)).toEqual([]);
	});

	it("survives worker restart: a fresh instance over the same storage completes the queue", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [entry("a"), entry("b"), entry("c")],
		});
		// First worker acks "a" then dies on a network error at "b".
		const dyingFetch = vi
			.fn<FetchLike>()
			.mockResolvedValueOnce(OK)
			.mockRejectedValue(new Error("worker died"));
		await createOutbox({ storage, fetchFn: dyingFetch }).flush();
		expect(queueIds(storage)).toEqual(["b", "c"]);

		// New module instance (fresh guard) sees the surviving queue.
		const freshFetch = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn: freshFetch }).flush();
		expect(queueIds(storage)).toEqual([]);
		const posted = freshFetch.mock.calls.map(
			([, init]) =>
				(jsonBody(init.body) as { bookmarks: Array<{ chromeId: string }> })
					.bookmarks[0]?.chromeId,
		);
		// "a" was already acked and persisted — never re-sent.
		expect(posted).toEqual(["chrome-b", "chrome-c"]);
	});

	it("persists the queue incrementally after each acked entry", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [entry("a"), entry("b"), entry("c")],
		});
		const snapshots: string[][] = [];
		const fetchFn = vi.fn<FetchLike>(async () => {
			snapshots.push(queueIds(storage));
			return OK;
		});
		await createOutbox({ storage, fetchFn }).flush();
		// At each POST the previously acked entries are already gone from
		// storage; the in-flight entry is only removed after its 2xx.
		expect(snapshots).toEqual([["a", "b", "c"], ["b", "c"], ["c"]]);
		expect(queueIds(storage)).toEqual([]);
	});
});

describe("flush kind-routing (SPEC §6)", () => {
	it("posts a mixed FIFO queue [sync, highlight] in order to the right endpoints with the right bodies", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [createEntry("live", entry("a").bookmarks), highlight("h")],
		});
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();

		expect(fetchFn).toHaveBeenCalledTimes(2);
		const [syncUrl, syncInit] = fetchFn.mock.calls[0] ?? [];
		expect(syncUrl).toBe("https://api.test/api/sync");
		expect(jsonBody(syncInit?.body)).toEqual({
			mode: "live",
			bookmarks: entry("a").bookmarks,
		});
		const [hlUrl, hlInit] = fetchFn.mock.calls[1] ?? [];
		expect(hlUrl).toBe("https://api.test/api/highlights");
		expect(hlInit?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer tok-123",
		});
		// Body is exactly SPEC §8 — url + text only; no outbox id, no kind.
		expect(jsonBody(hlInit?.body)).toEqual({
			url: "https://example.com/h",
			text: "Highlight h",
		});
		expect(queueIds(storage)).toEqual([]);
	});

	it("routes legacy entries WITHOUT a kind field as sync", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [entry("legacy")], // entry() builds the pre-kind shape
		});
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledWith(
			"https://api.test/api/sync",
			expect.anything(),
		);
		expect(queueIds(storage)).toEqual([]);
	});
});

describe("flush failure handling per kind (SPEC §6 poison rule)", () => {
	it("drops a highlight on 400, persists the drop, and continues with later entries", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [highlight("bad"), entry("after")],
		});
		const droppedSnapshots: string[][] = [];
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValueOnce({ ok: false, status: 400 })
			.mockImplementation(async () => {
				// By the time the next entry is posted, the drop is persisted.
				droppedSnapshots.push(queueIds(storage));
				return OK;
			});
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(droppedSnapshots).toEqual([["after"]]);
		expect(queueIds(storage)).toEqual([]);
	});

	it("drops a highlight on 409 (no matching bookmark) and continues", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [highlight("orphan"), highlight("ok"), entry("sync")],
		});
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValueOnce({ ok: false, status: 409 })
			.mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(3);
		const posted = fetchFn.mock.calls.map(([url]) => url);
		expect(posted).toEqual([
			"https://api.test/api/highlights",
			"https://api.test/api/highlights",
			"https://api.test/api/sync",
		]);
		expect(queueIds(storage)).toEqual([]);
	});

	it("halts on highlight 401 (token problem), keeping the entry and everything after it", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [highlight("h"), entry("after")],
		});
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValue({ ok: false, status: 401 });
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(queueIds(storage)).toEqual(["h", "after"]);
	});

	it("halts on highlight 5xx, keeping the entry for retry", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [highlight("h"), entry("after")],
		});
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValue({ ok: false, status: 503 });
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(queueIds(storage)).toEqual(["h", "after"]);
	});

	it("halts on highlight network error, keeping the entry for retry", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [highlight("h"), entry("after")],
		});
		const fetchFn = vi.fn<FetchLike>().mockRejectedValue(new Error("offline"));
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(queueIds(storage)).toEqual(["h", "after"]);
	});

	it("still halts sync entries on 4xx (409) — poison rule is highlight-only", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [createEntry("live", entry("a").bookmarks), highlight("h")],
		});
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValue({ ok: false, status: 409 });
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		// Both the failed sync entry and the highlight behind it stay queued.
		const queue = storage.data[OUTBOX_KEY] as OutboxEntry[];
		expect(queue).toHaveLength(2);
		expect(queue[1]?.kind).toBe("highlight");
	});
});

// ---------------------------------------------------------------------------
// m19 browse entries (SPEC §8/§13).

describe("browse wire shape", () => {
	it("renames the buffered id to clientEventId and omits absent fields", () => {
		expect(
			toBrowseEventInput(
				browseEvent("evt-1", { kind: "capture_start", bootId: "boot-9" }),
			),
		).toEqual({
			clientEventId: "evt-1",
			bootId: "boot-9",
			kind: "capture_start",
			occurredAtMs: 1_700_000_000_000,
		});
	});

	it("carries every field a kind DOES declare", () => {
		expect(
			toBrowseEventInput(
				browseEvent("evt-2", {
					kind: "nav",
					tabId: 4,
					windowId: 2,
					url: "https://example.com/a",
					transition: "typed|from_address_bar",
					documentLifecycle: "prerender",
				}),
			),
		).toEqual({
			clientEventId: "evt-2",
			bootId: "boot-1",
			kind: "nav",
			occurredAtMs: 1_700_000_000_000,
			tabId: 4,
			windowId: 2,
			url: "https://example.com/a",
			transition: "typed|from_address_bar",
			documentLifecycle: "prerender",
		});
		expect(
			toBrowseEventInput(
				browseEvent("evt-3", { kind: "idle", idleState: "locked" }),
			),
		).toEqual({
			clientEventId: "evt-3",
			bootId: "boot-1",
			kind: "idle",
			occurredAtMs: 1_700_000_000_000,
			idleState: "locked",
		});
		expect(
			toBrowseEventInput(
				browseEvent("evt-4", {
					kind: "tab_activated",
					tabId: 1,
					windowId: 3,
					title: "Example",
				}),
			).title,
		).toBe("Example");
	});

	it("createBrowseEntry assigns unique ids and keeps kind/events", () => {
		const events = [browseEvent("e-1")];
		const one = createBrowseEntry(events);
		const two = createBrowseEntry(events);
		expect(one.kind).toBe("browse");
		expect(one.events).toEqual(events);
		expect(one.id).not.toBe(two.id);
	});
});

describe("enqueueBrowse backlog cap (SPEC §13)", () => {
	it("appends browse entries to the tail of the queue", async () => {
		const storage = fakeStorage({ [OUTBOX_KEY]: [entry("sync-a")] });
		const outbox = createOutbox({ storage, fetchFn: vi.fn<FetchLike>() });
		await outbox.enqueueBrowse([browse("b1"), browse("b2")]);
		expect(queueIds(storage)).toEqual(["sync-a", "b1", "b2"]);
	});

	it("is a no-op for an empty batch", async () => {
		const storage = fakeStorage({ [OUTBOX_KEY]: [entry("sync-a")] });
		await createOutbox({ storage, fetchFn: vi.fn<FetchLike>() }).enqueueBrowse(
			[],
		);
		expect(queueIds(storage)).toEqual(["sync-a"]);
	});

	it("drops the OLDEST browse entries past the cap, never touching sync/highlight", async () => {
		const existing: OutboxEntry[] = [
			entry("sync-first"),
			...Array.from({ length: BROWSE_OUTBOX_ENTRY_CAP }, (_, i) =>
				browse(`old-${i}`),
			),
			highlight("hl"),
			entry("sync-last"),
		];
		const storage = fakeStorage({ [OUTBOX_KEY]: existing });
		const outbox = createOutbox({ storage, fetchFn: vi.fn<FetchLike>() });
		await outbox.enqueueBrowse([browse("new-1"), browse("new-2")]);

		const queue = storage.data[OUTBOX_KEY] as OutboxEntry[];
		const browseIds = queue.filter((e) => e.kind === "browse").map((e) => e.id);
		expect(browseIds).toHaveLength(BROWSE_OUTBOX_ENTRY_CAP);
		// The two oldest browse entries made room for the two new ones.
		expect(browseIds).not.toContain("old-0");
		expect(browseIds).not.toContain("old-1");
		expect(browseIds[0]).toBe("old-2");
		expect(browseIds.slice(-2)).toEqual(["new-1", "new-2"]);
		// Bookmark traffic is untouched, in its original relative order.
		expect(queue.filter((e) => e.kind !== "browse").map((e) => e.id)).toEqual([
			"sync-first",
			"hl",
			"sync-last",
		]);
	});

	it("keeps only the newest cap entries when a single batch overflows it", async () => {
		const storage = fakeStorage({ [OUTBOX_KEY]: [entry("sync-a")] });
		const outbox = createOutbox({ storage, fetchFn: vi.fn<FetchLike>() });
		await outbox.enqueueBrowse(
			Array.from({ length: BROWSE_OUTBOX_ENTRY_CAP + 5 }, (_, i) =>
				browse(`b-${i}`),
			),
		);
		const queue = storage.data[OUTBOX_KEY] as OutboxEntry[];
		expect(queue[0]?.id).toBe("sync-a");
		const browseIds = queue.filter((e) => e.kind === "browse").map((e) => e.id);
		expect(browseIds).toHaveLength(BROWSE_OUTBOX_ENTRY_CAP);
		expect(browseIds[0]).toBe("b-5");
		expect(browseIds.at(-1)).toBe(`b-${BROWSE_OUTBOX_ENTRY_CAP + 4}`);
	});
});

describe("browse flush routing + poison rule (SPEC §13)", () => {
	it("posts browse entries to /api/browse-events with the §8 body", async () => {
		const events = [
			browseEvent("e-1", { kind: "capture_start" }),
			browseEvent("e-2", {
				kind: "nav",
				tabId: 7,
				url: "https://example.com/x",
				transition: "link",
			}),
		];
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [
				createEntry("live", entry("a").bookmarks),
				browse("b", events),
			],
		});
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();

		expect(fetchFn).toHaveBeenCalledTimes(2);
		const [url, init] = fetchFn.mock.calls[1] ?? [];
		expect(url).toBe("https://api.test/api/browse-events");
		expect(init?.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer tok-123",
		});
		// Exactly SPEC §8/§13: {events} with clientEventId keys, no outbox id,
		// no `kind` wrapper, and no undefined-valued keys anywhere.
		const body = jsonBody(init?.body) as Record<string, unknown>;
		expect(body).toEqual({
			events: [
				{
					clientEventId: "e-1",
					bootId: "boot-1",
					kind: "capture_start",
					occurredAtMs: 1_700_000_000_000,
				},
				{
					clientEventId: "e-2",
					bootId: "boot-1",
					kind: "nav",
					occurredAtMs: 1_700_000_000_000,
					tabId: 7,
					url: "https://example.com/x",
					transition: "link",
				},
			],
		});
		expect(init?.body).not.toContain('"id"');
		expect(queueIds(storage)).toEqual([]);
	});

	it("never puts an empty pre-commit url/title on the wire", async () => {
		// End to end: factory-built events from a tab Chrome hasn't committed
		// yet must not carry `url`/`title` keys (server bound is min(1) — one
		// empty string 400s, and poison-drops, the whole batch).
		const factory = createEventFactory({
			uuid: counterUuid("evt"),
			now: () => 1_700_000_000_000,
		});
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [
				browse("b", [
					factory.tabActivated({
						bootId: "boot-1",
						tabId: 1,
						windowId: 2,
						url: "",
						title: "",
					}),
				]),
			],
		});
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();

		const body = String(fetchFn.mock.calls[0]?.[1].body ?? "");
		expect(body).not.toContain('"url"');
		expect(body).not.toContain('"title"');
		expect(JSON.parse(body)).toEqual({
			events: [
				{
					clientEventId: "evt-1",
					bootId: "boot-1",
					kind: "tab_activated",
					occurredAtMs: 1_700_000_000_000,
					tabId: 1,
					windowId: 2,
				},
			],
		});
	});

	it("drops a browse entry on a definitive 4xx and CONTINUES the flush", async () => {
		for (const status of [400, 409, 413, 422]) {
			const storage = fakeStorage({
				...configured,
				[OUTBOX_KEY]: [browse("bad"), entry("after")],
			});
			const fetchFn = vi
				.fn<FetchLike>()
				.mockResolvedValueOnce({ ok: false, status })
				.mockResolvedValue(OK);
			await createOutbox({ storage, fetchFn }).flush();
			expect(fetchFn).toHaveBeenCalledTimes(2);
			expect(queueIds(storage)).toEqual([]);
		}
	});

	it("halts on browse 401 / 5xx / network error, keeping the entry queued", async () => {
		const failures: FetchLike[] = [
			async () => ({ ok: false, status: 401 }),
			async () => ({ ok: false, status: 500 }),
			async () => {
				throw new Error("offline");
			},
		];
		for (const failing of failures) {
			const storage = fakeStorage({
				...configured,
				[OUTBOX_KEY]: [browse("b"), entry("after")],
			});
			const fetchFn = vi.fn<FetchLike>(failing);
			await createOutbox({ storage, fetchFn }).flush();
			expect(fetchFn).toHaveBeenCalledTimes(1);
			expect(queueIds(storage)).toEqual(["b", "after"]);
		}
	});

	it("a poisoned browse entry never blocks the bookmark sync behind it", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [browse("poison"), entry("sync-after"), highlight("hl")],
		});
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValueOnce({ ok: false, status: 400 })
			.mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
			"https://api.test/api/browse-events",
			"https://api.test/api/sync",
			"https://api.test/api/highlights",
		]);
		expect(queueIds(storage)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// m23 screenshot entries (SPEC §15.3).

/** "/9j/" decodes to the JPEG SOI marker bytes the server checks for. */
const JPEG_B64 = "/9j/";
const JPEG_BYTES = [0xff, 0xd8, 0xff];

function screenshot(
	id: string,
	overrides: Partial<ScreenshotOutboxEntry> = {},
): ScreenshotOutboxEntry {
	return {
		id,
		kind: "screenshot",
		url: `https://example.com/${id}`,
		blobKey: `${SCREENSHOT_BLOB_PREFIX}${id}`,
		attempts: 0,
		...overrides,
	};
}

/** Queue + the matching blob side-store for a set of entries. */
function withBlobs(
	entries: OutboxEntry[],
	blob = JPEG_B64,
): Record<string, unknown> {
	const store: Record<string, unknown> = {
		...configured,
		[OUTBOX_KEY]: entries,
	};
	for (const item of entries) {
		if (item.kind === "screenshot") store[item.blobKey] = blob;
	}
	return store;
}

function queueEntries(storage: FakeStorage): OutboxEntry[] {
	return (storage.data[OUTBOX_KEY] as OutboxEntry[] | undefined) ?? [];
}

function attemptsOfFirst(storage: FakeStorage): number {
	return (queueEntries(storage)[0] as ScreenshotOutboxEntry).attempts;
}

describe("screenshot enqueue + blob side-store (SPEC §15.3)", () => {
	it("appends the entry to the tail and stores the JPEG under its own key", async () => {
		const storage = fakeStorage({ [OUTBOX_KEY]: [entry("sync-a")] });
		const outbox = createOutbox({ storage, fetchFn: vi.fn<FetchLike>() });
		await outbox.enqueueScreenshot("https://example.com/x", JPEG_B64);

		const queued = queueEntries(storage);
		expect(queued[0]?.id).toBe("sync-a");
		const added = queued[1] as ScreenshotOutboxEntry;
		expect(added.kind).toBe("screenshot");
		// RAW url (hard rule #3) — the server normalizes it to find the row.
		expect(added.url).toBe("https://example.com/x");
		expect(added.blobKey).toBe(`${SCREENSHOT_BLOB_PREFIX}${added.id}`);
		expect(added.attempts).toBe(0);
		// The bytes are NOT in the queue array.
		expect(JSON.stringify(queued)).not.toContain(JPEG_B64);
		expect(storage.data[added.blobKey]).toBe(JPEG_B64);
	});

	it("writes the ENTRY first and the blob second", async () => {
		// A death between the two leaves an entry whose blob is missing, which
		// the next flush drops — the recoverable half of the window (§15.3).
		const storage = fakeStorage();
		const outbox = createOutbox({ storage, fetchFn: vi.fn<FetchLike>() });
		await outbox.enqueueScreenshot("https://example.com/x", JPEG_B64);
		const { blobKey } = queueEntries(storage)[0] as ScreenshotOutboxEntry;
		expect(storage.writes).toEqual([`set:${OUTBOX_KEY}`, `set:${blobKey}`]);
	});

	it("is a no-op for empty bytes", async () => {
		const storage = fakeStorage();
		const outbox = createOutbox({ storage, fetchFn: vi.fn<FetchLike>() });
		await outbox.enqueueScreenshot("https://example.com/x", "");
		expect(queueEntries(storage)).toEqual([]);
		expect(storage.writes).toEqual([]);
	});
});

describe("screenshot backlog cap (SPEC §15.3)", () => {
	it("drops the OLDEST screenshot entry with its blob, never touching other kinds", async () => {
		const existing: OutboxEntry[] = [
			entry("sync-first"),
			...Array.from({ length: SCREENSHOT_OUTBOX_ENTRY_CAP }, (_, i) =>
				screenshot(`old-${i}`),
			),
			highlight("hl"),
			browse("br"),
			entry("sync-last"),
		];
		const storage = fakeStorage(withBlobs(existing));
		const outbox = createOutbox({ storage, fetchFn: vi.fn<FetchLike>() });
		await outbox.enqueueScreenshot("https://example.com/new", JPEG_B64);

		const queue = queueEntries(storage);
		const shots = queue.filter((e) => e.kind === "screenshot");
		expect(shots).toHaveLength(SCREENSHOT_OUTBOX_ENTRY_CAP);
		expect(shots.map((e) => e.id)).not.toContain("old-0");
		expect(shots[0]?.id).toBe("old-1");
		// The evicted entry's blob went with it; the survivors' blobs remain.
		expect(storage.data[`${SCREENSHOT_BLOB_PREFIX}old-0`]).toBeUndefined();
		expect(storage.data[`${SCREENSHOT_BLOB_PREFIX}old-1`]).toBe(JPEG_B64);
		// Bookmark + telemetry traffic untouched, in its original relative order.
		expect(
			queue.filter((e) => e.kind !== "screenshot").map((e) => e.id),
		).toEqual(["sync-first", "hl", "br", "sync-last"]);
	});

	it("removes an evicted blob BEFORE persisting the shrunken queue", async () => {
		const existing = Array.from(
			{ length: SCREENSHOT_OUTBOX_ENTRY_CAP },
			(_, i) => screenshot(`old-${i}`),
		);
		const storage = fakeStorage(withBlobs(existing));
		const outbox = createOutbox({ storage, fetchFn: vi.fn<FetchLike>() });
		await outbox.enqueueScreenshot("https://example.com/new", JPEG_B64);
		// Blob first, then the queue: the reverse order would leak a blob
		// nothing references any more.
		expect(storage.writes[0]).toBe(`remove:${SCREENSHOT_BLOB_PREFIX}old-0`);
		expect(storage.writes[1]).toBe(`set:${OUTBOX_KEY}`);
	});
});

describe("screenshot flush routing (SPEC §15.3)", () => {
	it("POSTs the raw JPEG to the by-url screenshot route with a Bearer token", async () => {
		const storage = fakeStorage(
			withBlobs([
				createEntry("live", entry("a").bookmarks),
				screenshot("s", { url: "https://example.com/a b#frag" }),
			]),
		);
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();

		expect(fetchFn).toHaveBeenCalledTimes(2);
		const [url, init] = fetchFn.mock.calls[1] ?? [];
		expect(url).toBe(
			"https://api.test/api/bookmarks/by-url/screenshot?url=https%3A%2F%2Fexample.com%2Fa%20b%23frag",
		);
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({
			"Content-Type": "image/jpeg",
			Authorization: "Bearer tok-123",
		});
		// The body is the decoded bytes — not base64, not JSON.
		expect(init?.body).toBeInstanceOf(Uint8Array);
		expect(Array.from(init?.body as Uint8Array)).toEqual(JPEG_BYTES);
		expect(queueIds(storage)).toEqual([]);
	});

	it("removes the blob BEFORE the entry on a 2xx", async () => {
		const storage = fakeStorage(withBlobs([screenshot("s")]));
		await createOutbox({
			storage,
			fetchFn: vi.fn<FetchLike>().mockResolvedValue(OK),
		}).flush();
		expect(storage.writes).toEqual([
			`remove:${SCREENSHOT_BLOB_PREFIX}s`,
			`set:${OUTBOX_KEY}`,
		]);
		expect(storage.data[`${SCREENSHOT_BLOB_PREFIX}s`]).toBeUndefined();
		expect(queueIds(storage)).toEqual([]);
	});

	it("drops an entry whose blob is missing and CONTINUES the flush", async () => {
		// The worker died between the queue write and the blob write.
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [screenshot("orphan"), entry("after")],
		});
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.test/api/sync");
		expect(queueIds(storage)).toEqual([]);
	});

	it("drops an entry whose blob is corrupt rather than retrying it forever", async () => {
		const storage = fakeStorage(withBlobs([screenshot("bad")], "not base64!!"));
		const fetchFn = vi.fn<FetchLike>().mockResolvedValue(OK);
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(queueIds(storage)).toEqual([]);
		expect(storage.data[`${SCREENSHOT_BLOB_PREFIX}bad`]).toBeUndefined();
	});
});

describe("screenshot poison rule + attempt counter (SPEC §15.3)", () => {
	it("drops on a definitive 4xx, blob first, and continues the flush", async () => {
		for (const status of [400, 404, 413, 415, 422]) {
			const storage = fakeStorage(
				withBlobs([screenshot("bad"), entry("after")]),
			);
			const fetchFn = vi
				.fn<FetchLike>()
				.mockResolvedValueOnce({ ok: false, status })
				.mockResolvedValue(OK);
			await createOutbox({ storage, fetchFn }).flush();
			expect(fetchFn).toHaveBeenCalledTimes(2);
			expect(storage.writes.slice(0, 2)).toEqual([
				`remove:${SCREENSHOT_BLOB_PREFIX}bad`,
				`set:${OUTBOX_KEY}`,
			]);
			expect(storage.data[`${SCREENSHOT_BLOB_PREFIX}bad`]).toBeUndefined();
			expect(queueIds(storage)).toEqual([]);
		}
	});

	it("counts a 5xx, persists the count, and halts the flush", async () => {
		const storage = fakeStorage(withBlobs([screenshot("s"), entry("after")]));
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValue({ ok: false, status: 503 });
		const outbox = createOutbox({ storage, fetchFn });
		await outbox.flush();

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(queueIds(storage)).toEqual(["s", "after"]);
		expect(attemptsOfFirst(storage)).toBe(1);
		// The blob survives for the retry.
		expect(storage.data[`${SCREENSHOT_BLOB_PREFIX}s`]).toBe(JPEG_B64);

		await outbox.flush();
		expect(attemptsOfFirst(storage)).toBe(2);
	});

	it("drops the entry on the FIFTH 5xx and continues the flush", async () => {
		const storage = fakeStorage(withBlobs([screenshot("s"), entry("after")]));
		const fetchFn = vi.fn<FetchLike>(async (url) =>
			url.includes("screenshot") ? { ok: false, status: 500 } : OK,
		);
		const outbox = createOutbox({ storage, fetchFn });

		for (let i = 1; i < SCREENSHOT_MAX_ATTEMPTS; i += 1) {
			await outbox.flush();
			expect(attemptsOfFirst(storage)).toBe(i);
			expect(queueIds(storage)).toEqual(["s", "after"]);
		}

		// The fifth 5xx: the screenshot is abandoned and the sync behind it ships.
		await outbox.flush();
		expect(storage.data[`${SCREENSHOT_BLOB_PREFIX}s`]).toBeUndefined();
		expect(queueIds(storage)).toEqual([]);
		expect(fetchFn.mock.calls.at(-1)?.[0]).toBe("https://api.test/api/sync");
	});

	it("does NOT count a 401 — a revoked token is not the screenshot's fault", async () => {
		const storage = fakeStorage(withBlobs([screenshot("s"), entry("after")]));
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValue({ ok: false, status: 401 });
		const outbox = createOutbox({ storage, fetchFn });
		await outbox.flush();
		await outbox.flush();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(attemptsOfFirst(storage)).toBe(0);
		expect(queueIds(storage)).toEqual(["s", "after"]);
		expect(storage.data[`${SCREENSHOT_BLOB_PREFIX}s`]).toBe(JPEG_B64);
	});

	it("does NOT count a network error — an offline stretch is not a failure", async () => {
		const storage = fakeStorage(withBlobs([screenshot("s"), entry("after")]));
		const fetchFn = vi.fn<FetchLike>().mockRejectedValue(new Error("offline"));
		const outbox = createOutbox({ storage, fetchFn });
		await outbox.flush();
		await outbox.flush();
		await outbox.flush();
		expect(attemptsOfFirst(storage)).toBe(0);
		expect(queueIds(storage)).toEqual(["s", "after"]);
	});

	it("keeps a queued screenshot behind a halted sync entry (FIFO)", async () => {
		const storage = fakeStorage(
			withBlobs([createEntry("live", entry("a").bookmarks), screenshot("s")]),
		);
		const fetchFn = vi
			.fn<FetchLike>()
			.mockResolvedValue({ ok: false, status: 500 });
		await createOutbox({ storage, fetchFn }).flush();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(queueEntries(storage)).toHaveLength(2);
		expect((queueEntries(storage)[1] as ScreenshotOutboxEntry).attempts).toBe(
			0,
		);
	});
});
