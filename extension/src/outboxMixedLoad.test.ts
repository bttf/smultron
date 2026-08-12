/**
 * m19 hardening: outbox behavior under realistic MIXED load (SPEC §6 + §13).
 *
 * The unit suites prove sync halt, highlight poison, browse poison, and the
 * browse caps SEPARATELY; these tests interleave all three kinds through one
 * queue with failures and assert the combined invariants: bookmark FIFO is
 * never reordered or dropped, telemetry failures never wedge the queue, and
 * the browse caps hold with sync/highlight entries mixed in — including while
 * a flush is halted.
 */

import { describe, expect, it } from "vitest";
import { createBrowseBuffer, createEventFactory } from "./attention";
import {
	createOutbox,
	type FetchLike,
	type KeyValueStorage,
	type MinimalResponse,
} from "./outbox";
import type {
	BrowseEvent,
	BrowseOutboxEntry,
	HighlightOutboxEntry,
	OutboxEntry,
	SyncOutboxEntry,
} from "./types";
import { BROWSE_OUTBOX_ENTRY_CAP, CONFIG_KEY, OUTBOX_KEY } from "./types";

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

function sync(id: string): SyncOutboxEntry {
	return {
		id,
		kind: "sync",
		mode: "live",
		bookmarks: [
			{ url: `https://example.com/${id}`, title: id, chromeId: `c-${id}` },
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

let eventN = 0;
function browseEvent(): BrowseEvent {
	eventN += 1;
	return {
		id: `evt-${eventN}`,
		bootId: "boot-1",
		kind: "window_blur",
		occurredAtMs: 1_754_900_000_000,
	};
}

function browse(id: string): BrowseOutboxEntry {
	return { id, kind: "browse", events: [browseEvent()] };
}

const configured = {
	[CONFIG_KEY]: { token: "tok-123", baseUrl: "https://api.test" },
};

function queueIds(storage: FakeStorage): string[] {
	const queue = (storage.data[OUTBOX_KEY] as OutboxEntry[] | undefined) ?? [];
	return queue.map((entry) => entry.id);
}

/** Fetch mock scripted per entry id (parsed back out of the request body). */
function scriptedFetch(
	script: Record<string, MinimalResponse | "network-error">,
	calls: Array<{ endpoint: string; id: string }>,
): FetchLike {
	return async (url, init) => {
		const body = JSON.parse(init.body) as {
			bookmarks?: Array<{ title: string }>;
			text?: string;
			events?: Array<{ clientEventId: string }>;
		};
		// Recover which entry this POST carries from its kind-specific body.
		const id =
			body.bookmarks?.[0]?.title ??
			body.text?.replace("Highlight ", "") ??
			body.events?.map((event) => event.clientEventId).join(",") ??
			"?";
		calls.push({ endpoint: url.replace("https://api.test", ""), id });
		const outcome = script[id] ?? OK;
		if (outcome === "network-error") throw new Error("offline");
		return outcome;
	};
}

describe("mixed-kind FIFO with per-kind failure handling", () => {
	it("a browse 400 poison-drops and the flush continues through sync + highlight", async () => {
		const b1 = browse("b1");
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [sync("s1"), b1, highlight("h1"), sync("s2"), browse("b2")],
		});
		const calls: Array<{ endpoint: string; id: string }> = [];
		const poisoned = b1.events[0]?.id ?? "";
		const outbox = createOutbox({
			storage,
			fetchFn: scriptedFetch({ [poisoned]: { ok: false, status: 400 } }, calls),
		});

		await outbox.flush();

		// Everything attempted once, in FIFO order, each to its own endpoint.
		expect(calls.map((call) => call.endpoint)).toEqual([
			"/api/sync",
			"/api/browse-events",
			"/api/highlights",
			"/api/sync",
			"/api/browse-events",
		]);
		// The poisoned browse entry is gone WITH the rest delivered: telemetry
		// loss never blocks bookmarks or later telemetry.
		expect(queueIds(storage)).toEqual([]);
	});

	it("a sync 500 halts EVERYTHING behind it — browse/highlight wait their turn", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [browse("b1"), sync("s1"), highlight("h1"), browse("b2")],
		});
		const calls: Array<{ endpoint: string; id: string }> = [];
		const script: Record<string, MinimalResponse | "network-error"> = {
			s1: { ok: false, status: 500 },
		};
		const outbox = createOutbox({
			storage,
			fetchFn: scriptedFetch(script, calls),
		});

		await outbox.flush();
		// b1 delivered; s1 failed; NOTHING after s1 was attempted (bookmark FIFO
		// is order-preserving — a browse poison rule must not leapfrog a halted
		// sync).
		expect(calls).toHaveLength(2);
		expect(queueIds(storage)).toEqual(["s1", "h1", "b2"]);

		// Server recovers: the next flush resumes from s1 in order.
		script.s1 = OK;
		await outbox.flush();
		expect(calls.slice(2).map((call) => call.endpoint)).toEqual([
			"/api/sync",
			"/api/highlights",
			"/api/browse-events",
		]);
		expect(queueIds(storage)).toEqual([]);
	});

	it("a poisoned browse entry directly ahead of a halted sync is dropped exactly once", async () => {
		const b1 = browse("b1");
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [b1, sync("s1")],
		});
		const calls: Array<{ endpoint: string; id: string }> = [];
		const poisoned = b1.events[0]?.id ?? "";
		const script: Record<string, MinimalResponse | "network-error"> = {
			[poisoned]: { ok: false, status: 400 },
			s1: { ok: false, status: 503 },
		};
		const outbox = createOutbox({
			storage,
			fetchFn: scriptedFetch(script, calls),
		});

		await outbox.flush();
		expect(queueIds(storage)).toEqual(["s1"]);

		// Next flush: the poisoned entry is GONE (never re-sent), s1 retries.
		script.s1 = OK;
		await outbox.flush();
		expect(calls.filter((call) => call.id === poisoned)).toHaveLength(1);
		expect(calls.filter((call) => call.id === "s1")).toHaveLength(2);
		expect(queueIds(storage)).toEqual([]);
	});

	it("browse entries enqueued mid-flush are picked up in the same pass", async () => {
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [sync("s1")],
		});
		const calls: Array<{ endpoint: string; id: string }> = [];
		const late = browse("late");
		let enqueuedLate = false;
		const outbox = createOutbox({
			storage,
			fetchFn: async (url, _init) => {
				calls.push({ endpoint: url.replace("https://api.test", ""), id: "" });
				if (!enqueuedLate) {
					enqueuedLate = true;
					// A drain races in while s1's POST is in flight.
					await outbox.enqueueBrowse([late]);
				}
				return OK;
			},
		});

		await outbox.flush();
		// The flush re-reads the queue per iteration, so the racing browse entry
		// ships in the SAME pass instead of waiting for the next alarm.
		expect(calls.map((call) => call.endpoint)).toEqual([
			"/api/sync",
			"/api/browse-events",
		]);
		expect(queueIds(storage)).toEqual([]);
	});
});

describe("browse caps under mixed backlog (halted flush)", () => {
	it("drop-oldest keeps sync + highlight intact and delivers the newest browse entries in order", async () => {
		// A halted queue: s1 at the head keeps 500ing (e.g. server down).
		const storage = fakeStorage({
			...configured,
			[OUTBOX_KEY]: [sync("s1"), highlight("h1")],
		});
		const calls: Array<{ endpoint: string; id: string }> = [];
		const script: Record<string, MinimalResponse | "network-error"> = {
			s1: { ok: false, status: 500 },
		};
		const outbox = createOutbox({
			storage,
			fetchFn: scriptedFetch(script, calls),
		});

		// Telemetry keeps draining into the wedged queue, well past the cap.
		const batches = BROWSE_OUTBOX_ENTRY_CAP + 5;
		for (let i = 1; i <= batches; i += 1) {
			await outbox.enqueueBrowse([browse(`b${i}`)]);
			await outbox.flush(); // halts at s1 every time
		}

		// Cap held: the OLDEST browse entries fell off; sync + highlight kept
		// their entries AND their position at the head of the queue.
		const expectedBrowse = Array.from(
			{ length: BROWSE_OUTBOX_ENTRY_CAP },
			(_, i) => `b${i + 6}`,
		);
		expect(queueIds(storage)).toEqual(["s1", "h1", ...expectedBrowse]);

		// Recovery: everything left delivers in FIFO order.
		script.s1 = OK;
		await outbox.flush();
		expect(queueIds(storage)).toEqual([]);
		const delivered = calls.filter((call) => call.id !== "s1");
		expect(delivered.map((call) => call.endpoint)).toEqual([
			"/api/highlights",
			...expectedBrowse.map(() => "/api/browse-events"),
		]);
	});

	it("buffer → outbox → wire: a poison batch loses only its own events", async () => {
		// Full integration of the extension-side pipeline: 1200 buffered events
		// drain into ≤500-event entries; the middle entry is poisoned by the
		// server; the rest deliver.
		const storage = fakeStorage(configured);
		const factory = createEventFactory({
			uuid: (() => {
				let n = 0;
				return () => `wire-${++n}`;
			})(),
			now: () => 1_754_900_000_000,
		});
		let entryN = 0;
		const posted: string[][] = [];
		let failSecond = true;
		const outbox = createOutbox({
			storage,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body) as {
					events: Array<{ clientEventId: string }>;
				};
				const ids = body.events.map((event) => event.clientEventId);
				if (failSecond && ids[0] === "wire-501") {
					failSecond = false;
					return { ok: false, status: 400 };
				}
				posted.push(ids);
				return OK;
			},
		});
		const buffer = createBrowseBuffer({
			storage,
			enqueueBrowse: (entries) => outbox.enqueueBrowse(entries),
			uuid: () => `entry-${++entryN}`,
		});

		for (let i = 0; i < 1_200; i += 1) {
			await buffer.append(factory.windowBlur({ bootId: "boot-1" }));
		}
		await buffer.drain();
		await outbox.flush();

		// Batches of [500, 500, 200]; the poisoned middle 500 dropped, the
		// surrounding 700 events delivered exactly once, in order.
		expect(posted.map((ids) => ids.length)).toEqual([500, 200]);
		expect(posted[0]?.[0]).toBe("wire-1");
		expect(posted[0]?.at(-1)).toBe("wire-500");
		expect(posted[1]?.[0]).toBe("wire-1001");
		expect(posted[1]?.at(-1)).toBe("wire-1200");
		expect(queueIds(storage)).toEqual([]);
		expect(await buffer.size()).toBe(0);
	});
});
