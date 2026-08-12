/**
 * Storage-backed FIFO outbox for `/api/sync` and `/api/highlights` POSTs
 * (SPEC §6). Entries route by `kind`: highlight entries go to
 * `/api/highlights`; everything else — including legacy persisted entries
 * that predate the `kind` field — is a sync entry and goes to `/api/sync`.
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
 *   (live re-save is a bump, backfill conflict is DO NOTHING, a duplicate
 *   highlight row is allowed and low-stakes), so at-least-once is the
 *   intended contract.
 * - Failure handling (SPEC §6):
 *   - Sync entries: ANY failure (network error or non-2xx) stops the flush
 *     immediately, preserving FIFO order; the failed entry and everything
 *     after it stay queued for the next flush (event-driven or the
 *     5-minute alarm).
 *   - Highlight entries — poison rule: a definitive 4xx (anything except
 *     401) means the server rejected this exact payload and always will
 *     (e.g. 409: no bookmark matches the URL), so the entry is DROPPED,
 *     the deletion is persisted, and the flush CONTINUES with the next
 *     entry. 401 (token problem — applies to every entry behind it), 5xx,
 *     and network errors halt the flush with the entry retained, exactly
 *     like sync entries.
 *   - Browse entries (m19, SPEC §13) → `/api/browse-events`, with EXACTLY
 *     the highlight rule: telemetry must never wedge the queue ahead of
 *     bookmark syncs. They also carry a drop-oldest cap (20 entries) applied
 *     at enqueue time, which never touches sync/highlight entries.
 */

import type {
	BrowseEvent,
	BrowseEventInput,
	BrowseEventsPayload,
	BrowseOutboxEntry,
	ExtensionConfig,
	HighlightOutboxEntry,
	HighlightPayload,
	KeyValueStorage,
	OutboxEntry,
	SyncBookmark,
	SyncMode,
	SyncOutboxEntry,
	SyncPayload,
} from "./types";
import {
	BROWSE_OUTBOX_ENTRY_CAP,
	CONFIG_KEY,
	DEFAULT_BASE_URL,
	OUTBOX_KEY,
} from "./types";

export type { KeyValueStorage } from "./types";

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
	 * Append `browse` entries (m19) and enforce the telemetry backlog cap:
	 * beyond BROWSE_OUTBOX_ENTRY_CAP browse entries the OLDEST browse ones
	 * are dropped. Sync and highlight entries — and their relative order —
	 * are never touched (SPEC §13).
	 */
	enqueueBrowse(entries: BrowseOutboxEntry[]): Promise<void>;
	/**
	 * Drain the queue FIFO: POST each entry to its endpoint by kind, deleting
	 * it from storage on 2xx; stop or drop-and-continue on failure per the
	 * header comment. No-op when unconfigured (missing token) or when a flush
	 * is already in flight.
	 */
	flush(): Promise<void>;
}

/** Build a new sync outbox entry with a fresh unique id. */
export function createEntry(
	mode: SyncMode,
	bookmarks: SyncBookmark[],
): SyncOutboxEntry {
	return { id: crypto.randomUUID(), kind: "sync", mode, bookmarks };
}

/** Build a new highlight outbox entry with a fresh unique id. */
export function createHighlightEntry(
	url: string,
	text: string,
): HighlightOutboxEntry {
	return { id: crypto.randomUUID(), kind: "highlight", url, text };
}

/** Build a new browse outbox entry with a fresh unique id (m19). */
export function createBrowseEntry(events: BrowseEvent[]): BrowseOutboxEntry {
	return { id: crypto.randomUUID(), kind: "browse", events };
}

/**
 * Serialize a buffered event to its `/api/browse-events` wire shape
 * (SPEC §8/§13): the buffer's `id` IS the server's `clientEventId`, the
 * outbox entry id is never sent, and fields that don't apply to the kind are
 * OMITTED entirely (the server rejects undeclared fields).
 */
export function toBrowseEventInput(event: BrowseEvent): BrowseEventInput {
	const input: BrowseEventInput = {
		clientEventId: event.id,
		bootId: event.bootId,
		kind: event.kind,
		occurredAtMs: event.occurredAtMs,
	};
	if (event.url !== undefined) input.url = event.url;
	if (event.title !== undefined) input.title = event.title;
	if (event.tabId !== undefined) input.tabId = event.tabId;
	if (event.windowId !== undefined) input.windowId = event.windowId;
	if (event.idleState !== undefined) input.idleState = event.idleState;
	if (event.transition !== undefined) input.transition = event.transition;
	if (event.documentLifecycle !== undefined)
		input.documentLifecycle = event.documentLifecycle;
	return input;
}

/**
 * Apply the browse backlog cap to a queue: keep the newest
 * BROWSE_OUTBOX_ENTRY_CAP browse entries, dropping older ones. Every
 * non-browse entry survives in its original relative position — a halted
 * flush must degrade telemetry, never bookmark capture (SPEC §13).
 */
function capBrowseEntries(queue: OutboxEntry[]): OutboxEntry[] {
	const browseCount = queue.reduce(
		(count, entry) => (entry.kind === "browse" ? count + 1 : count),
		0,
	);
	let toDrop = browseCount - BROWSE_OUTBOX_ENTRY_CAP;
	if (toDrop <= 0) return queue;
	return queue.filter((entry) => {
		if (entry.kind !== "browse" || toDrop <= 0) return true;
		toDrop -= 1;
		return false;
	});
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

	const enqueueBrowse = async (entries: BrowseOutboxEntry[]): Promise<void> => {
		if (entries.length === 0) return;
		const queue = await readQueue();
		queue.push(...entries);
		await storage.set(OUTBOX_KEY, capBrowseEntries(queue));
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

				// Route by kind. Anything without `kind: "highlight"` / `"browse"`
				// — including legacy entries persisted before the field existed —
				// is sync.
				const droppable = entry.kind === "highlight" || entry.kind === "browse";
				let endpoint: string;
				let payload: SyncPayload | HighlightPayload | BrowseEventsPayload;
				if (entry.kind === "highlight") {
					endpoint = `${baseUrl}/api/highlights`;
					// Body is exactly SPEC §8 — no outbox id, no kind.
					payload = { url: entry.url, text: entry.text };
				} else if (entry.kind === "browse") {
					endpoint = `${baseUrl}/api/browse-events`;
					// Body is exactly SPEC §8/§13 — the buffered `id` becomes
					// `clientEventId`; no outbox id, no kind.
					payload = { events: entry.events.map(toBrowseEventInput) };
				} else {
					endpoint = `${baseUrl}/api/sync`;
					payload = { mode: entry.mode, bookmarks: entry.bookmarks };
				}

				let response: MinimalResponse;
				try {
					response = await fetchFn(endpoint, {
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
				if (!response.ok) {
					// Poison rule (highlight + browse entries ONLY, SPEC §6/§13):
					// a definitive 4xx other than 401 will never succeed — drop the
					// entry, persist the drop, and continue with the rest of the
					// queue.
					if (
						droppable &&
						response.status !== 401 &&
						response.status >= 400 &&
						response.status < 500
					) {
						const rest = (await readQueue()).filter((e) => e.id !== entry.id);
						await storage.set(OUTBOX_KEY, rest);
						continue;
					}
					// Everything else (sync failures, highlight/browse 401/5xx): stop,
					// keep this entry and everything after it — retry later.
					return;
				}

				// Acked: persist the deletion immediately (see header comment).
				const remaining = (await readQueue()).filter((e) => e.id !== entry.id);
				await storage.set(OUTBOX_KEY, remaining);
			}
		} finally {
			flushing = false;
		}
	};

	return { enqueue, enqueueBrowse, flush };
}
