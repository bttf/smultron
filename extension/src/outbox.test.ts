import { describe, expect, it, vi } from "vitest";
import {
	createEntry,
	createOutbox,
	type FetchLike,
	type KeyValueStorage,
	type MinimalResponse,
} from "./outbox";
import type { OutboxEntry } from "./types";
import { CONFIG_KEY, OUTBOX_KEY } from "./types";

const OK: MinimalResponse = { ok: true, status: 200 };

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

function entry(id: string, mode: "live" | "backfill" = "live"): OutboxEntry {
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
		expect(one.bookmarks).toEqual(bookmarks);
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
		expect(JSON.parse(init?.body ?? "")).toEqual({
			mode: "live",
			bookmarks: entry("a").bookmarks,
		});
		expect(JSON.parse(fetchFn.mock.calls[1]?.[1].body ?? "")).toEqual({
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
			([, init]) => JSON.parse(init.body).bookmarks[0].chromeId,
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
			([, init]) => JSON.parse(init.body).bookmarks[0].chromeId,
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
			([, init]) => JSON.parse(init.body).bookmarks[0].chromeId,
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
