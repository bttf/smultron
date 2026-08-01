/**
 * Storage-backed FIFO outbox for `/api/sync` POSTs (SPEC §6).
 *
 * All dependencies (key/value storage, fetch) are injected so the module is
 * pure logic — unit tests run against an in-memory store and a mocked fetch,
 * and the background worker wires in `chrome.storage.local` + global fetch.
 *
 * Delivery guarantees — at-least-once, in order:
 * - The queue lives in storage, so it survives service-worker death and
 *   browser restarts by construction; the only in-memory state is the
 *   re-entrancy guard.
 * - flush() removes an entry and persists the shrunken queue immediately
 *   after each successful POST (not once at the end), so a worker dying
 *   mid-flush never re-sends entries that were already acked AND persisted.
 * - The one unavoidable window: the POST succeeded but the worker died
 *   before the deletion persisted. That entry is sent again on the next
 *   flush. This is fine — the server upsert is tolerant of duplicates
 *   (live re-save is a bump, backfill conflict is DO NOTHING), so
 *   at-least-once is the intended contract.
 * - On any failure (network error or non-2xx) flush stops immediately,
 *   preserving FIFO order; the failed entry and everything after it stay
 *   queued for the next flush (event-driven or the 5-minute alarm).
 */

import type {
	ExtensionConfig,
	OutboxEntry,
	SyncBookmark,
	SyncMode,
	SyncPayload,
} from "./types";
import { CONFIG_KEY, DEFAULT_BASE_URL, OUTBOX_KEY } from "./types";

/** Minimal async key/value storage (chrome.storage.local in production). */
export interface KeyValueStorage {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
}

/** The only bits of a Response the outbox looks at. */
export interface MinimalResponse {
	ok: boolean;
	status: number;
}

export type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
) => Promise<MinimalResponse>;

export interface OutboxDeps {
	storage: KeyValueStorage;
	fetchFn: FetchLike;
}

export interface Outbox {
	/** Append an entry to the tail of the queue and persist. */
	enqueue(entry: OutboxEntry): Promise<void>;
	/**
	 * Drain the queue FIFO: POST each entry to `/api/sync`, deleting it from
	 * storage on 2xx; stop on the first failure. No-op when unconfigured
	 * (missing token) or when a flush is already in flight.
	 */
	flush(): Promise<void>;
}

/** Build a new outbox entry with a fresh unique id. */
export function createEntry(
	mode: SyncMode,
	bookmarks: SyncBookmark[],
): OutboxEntry {
	return { id: crypto.randomUUID(), mode, bookmarks };
}

export function createOutbox(deps: OutboxDeps): Outbox {
	const { storage, fetchFn } = deps;

	// Module-level (per-instance) in-flight guard: overlapping flush() calls
	// (bookmark event + alarm firing together) must not double-send. A worker
	// restart resets it, which is safe — the queue itself is in storage.
	let flushing = false;

	const readQueue = async (): Promise<OutboxEntry[]> => {
		const raw = await storage.get(OUTBOX_KEY);
		return Array.isArray(raw) ? (raw as OutboxEntry[]) : [];
	};

	const readConfig = async (): Promise<ExtensionConfig> => {
		const raw = await storage.get(CONFIG_KEY);
		return typeof raw === "object" && raw !== null
			? (raw as ExtensionConfig)
			: {};
	};

	const enqueue = async (entry: OutboxEntry): Promise<void> => {
		const queue = await readQueue();
		queue.push(entry);
		await storage.set(OUTBOX_KEY, queue);
	};

	const flush = async (): Promise<void> => {
		if (flushing) return;
		flushing = true;
		try {
			const config = await readConfig();
			const token = config.token?.trim();
			// Unconfigured: leave the queue intact and do nothing.
			if (token === undefined || token === "") return;
			const baseUrl = (config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(
				/\/+$/,
				"",
			);

			for (;;) {
				// Re-read each iteration so enqueues that raced in mid-flush are
				// neither lost nor skipped.
				const queue = await readQueue();
				const entry = queue[0];
				if (entry === undefined) return;

				const payload: SyncPayload = {
					mode: entry.mode,
					bookmarks: entry.bookmarks,
				};
				let response: MinimalResponse;
				try {
					response = await fetchFn(`${baseUrl}/api/sync`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify(payload),
					});
				} catch {
					// Network error: stop, keep this entry and everything after it.
					return;
				}
				if (!response.ok) return; // Non-2xx: same — retry later, in order.

				// Acked: persist the deletion immediately (see header comment).
				const remaining = (await readQueue()).filter((e) => e.id !== entry.id);
				await storage.set(OUTBOX_KEY, remaining);
			}
		} finally {
			flushing = false;
		}
	};

	return { enqueue, flush };
}
