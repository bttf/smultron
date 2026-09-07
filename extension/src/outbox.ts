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
 *   - Screenshot entries (m23, SPEC §15.3) → `/api/bookmarks/by-url/screenshot`
 *     with a BINARY body, the same poison rule, and an attempt counter on top:
 *     a 5xx increments `attempts` and halts (like any 5xx), and the fifth one
 *     drops the entry so a persistent Storage-side failure can hold bookmark
 *     syncs behind it for five retry alarms at most. 401 and network errors
 *     halt WITHOUT counting. Their JPEG lives in a blob side-store, one
 *     `chrome.storage.local` key per entry; see enqueueScreenshot.
 */

import { base64ToBytes } from "./screenshot";
import type {
	BlobKeyValueStorage,
	BrowseEvent,
	BrowseEventInput,
	BrowseEventsPayload,
	BrowseOutboxEntry,
	ExtensionConfig,
	HighlightOutboxEntry,
	HighlightPayload,
	OutboxEntry,
	ScreenshotOutboxEntry,
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
	SCREENSHOT_BLOB_PREFIX,
	SCREENSHOT_MAX_ATTEMPTS,
	SCREENSHOT_OUTBOX_ENTRY_CAP,
} from "./types";

export type { BlobKeyValueStorage, KeyValueStorage } from "./types";

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
		/**
		 * JSON for every kind but `screenshot`, whose body is the raw JPEG.
		 * The `<ArrayBuffer>` argument is required for assignability to the
		 * DOM's `BodyInit`, which does not accept a view over the wider
		 * `ArrayBufferLike` (`SharedArrayBuffer` cannot be sent).
		 */
		body: string | Uint8Array<ArrayBuffer>;
	},
) => Promise<MinimalResponse>;

export interface OutboxDeps {
	/** Needs `remove`: the screenshot blob side-store deletes keys (§15.3). */
	storage: BlobKeyValueStorage;
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
	 * Queue one page screenshot (m23, §15.3): `base64` is the JPEG with no
	 * `data:` prefix.
	 *
	 * Write order is load-bearing — a worker death between any two steps must
	 * leave no orphan blob and no phantom entry, so every window resolves to
	 * "entry whose blob is missing", which the next flush drops:
	 *   1. blobs of entries the cap evicts are removed FIRST,
	 *   2. the capped queue (new entry appended) is persisted,
	 *   3. the new entry's blob is written LAST.
	 * The cap (SCREENSHOT_OUTBOX_ENTRY_CAP, drop-oldest) counts `screenshot`
	 * entries only; sync, highlight and browse entries and their relative
	 * order are untouched.
	 */
	enqueueScreenshot(url: string, base64: string): Promise<void>;
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

/**
 * Build a new screenshot outbox entry with a fresh unique id (m23, §15.3).
 * `url` is the RAW bookmark URL (hard rule #3) and `blobKey` is derived from
 * the id, so entry and blob can never be mismatched.
 */
export function createScreenshotEntry(url: string): ScreenshotOutboxEntry {
	const id = crypto.randomUUID();
	return {
		id,
		kind: "screenshot",
		url,
		blobKey: `${SCREENSHOT_BLOB_PREFIX}${id}`,
		attempts: 0,
	};
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

/**
 * Apply the screenshot backlog cap to a queue: keep the newest
 * SCREENSHOT_OUTBOX_ENTRY_CAP screenshot entries and report the older ones so
 * the caller can delete their blobs. Every other entry survives in its
 * original relative position (SPEC §15.3).
 */
function capScreenshotEntries(queue: OutboxEntry[]): {
	kept: OutboxEntry[];
	dropped: ScreenshotOutboxEntry[];
} {
	const screenshots = queue.filter(
		(entry): entry is ScreenshotOutboxEntry => entry.kind === "screenshot",
	);
	let toDrop = screenshots.length - SCREENSHOT_OUTBOX_ENTRY_CAP;
	if (toDrop <= 0) return { kept: queue, dropped: [] };
	const dropped: ScreenshotOutboxEntry[] = [];
	const kept = queue.filter((entry) => {
		if (entry.kind !== "screenshot" || toDrop <= 0) return true;
		toDrop -= 1;
		dropped.push(entry);
		return false;
	});
	return { kept, dropped };
}

/** Persisted attempts, defensively coerced — a corrupt count must not wedge. */
function attemptsOf(entry: ScreenshotOutboxEntry): number {
	return Number.isFinite(entry.attempts) ? entry.attempts : 0;
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

	const enqueueScreenshot = async (
		url: string,
		base64: string,
	): Promise<void> => {
		if (base64 === "") return;
		const entry = createScreenshotEntry(url);
		const queue = await readQueue();
		queue.push(entry);
		const { kept, dropped } = capScreenshotEntries(queue);
		// Blob before entry on every removal (see the interface comment).
		for (const evicted of dropped) await storage.remove(evicted.blobKey);
		await storage.set(OUTBOX_KEY, kept);
		// Entry before blob on the append: a death here leaves an entry whose
		// blob is missing, which the next flush drops — the recoverable half.
		await storage.set(entry.blobKey, base64);
	};

	/** Persist the queue without `id`, re-read so concurrent enqueues survive. */
	const removeEntry = async (id: string): Promise<void> => {
		const rest = (await readQueue()).filter((e) => e.id !== id);
		await storage.set(OUTBOX_KEY, rest);
	};

	/**
	 * Retire a screenshot entry — acked, poisoned, or out of attempts. Blob
	 * FIRST: the reverse order would leak a blob nothing references any more,
	 * while this order can only leave an entry whose blob is gone, which the
	 * next flush drops (SPEC §15.3).
	 */
	const removeScreenshot = async (
		entry: ScreenshotOutboxEntry,
	): Promise<void> => {
		await storage.remove(entry.blobKey);
		await removeEntry(entry.id);
	};

	/** Persist one more 5xx against a screenshot entry (SPEC §15.3). */
	const bumpAttempts = async (
		entry: ScreenshotOutboxEntry,
		attempts: number,
	): Promise<void> => {
		const queue = await readQueue();
		await storage.set(
			OUTBOX_KEY,
			queue.map((e) =>
				e.id === entry.id && e.kind === "screenshot" ? { ...e, attempts } : e,
			),
		);
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

				// Route by kind. Anything without `kind: "highlight"` /
				// `"browse"` / `"screenshot"` — including legacy entries persisted
				// before the field existed — is sync.
				const droppable =
					entry.kind === "highlight" ||
					entry.kind === "browse" ||
					entry.kind === "screenshot";
				let endpoint: string;
				let contentType = "application/json";
				let body: string | Uint8Array<ArrayBuffer>;
				let payload: SyncPayload | HighlightPayload | BrowseEventsPayload;
				if (entry.kind === "highlight") {
					endpoint = `${baseUrl}/api/highlights`;
					// Body is exactly SPEC §8 — no outbox id, no kind.
					payload = { url: entry.url, text: entry.text };
					body = JSON.stringify(payload);
				} else if (entry.kind === "browse") {
					endpoint = `${baseUrl}/api/browse-events`;
					// Body is exactly SPEC §8/§13 — the buffered `id` becomes
					// `clientEventId`; no outbox id, no kind.
					payload = { events: entry.events.map(toBrowseEventInput) };
					body = JSON.stringify(payload);
				} else if (entry.kind === "screenshot") {
					// The bookmark is addressed by its RAW url in the query string
					// (§15.2); the body is the JPEG itself (§15.3).
					const stored = await storage.get(entry.blobKey);
					let bytes: Uint8Array<ArrayBuffer> | undefined;
					if (typeof stored === "string" && stored !== "") {
						try {
							bytes = base64ToBytes(stored);
						} catch {
							// Corrupt base64 — undeliverable, like a missing blob.
							bytes = undefined;
						}
					}
					if (bytes === undefined || bytes.length === 0) {
						// The blob is gone (a worker died mid-enqueue, or storage was
						// cleared): nothing to upload, ever. Drop and continue.
						await removeScreenshot(entry);
						continue;
					}
					endpoint = `${baseUrl}/api/bookmarks/by-url/screenshot?url=${encodeURIComponent(entry.url)}`;
					contentType = "image/jpeg";
					body = bytes;
				} else {
					endpoint = `${baseUrl}/api/sync`;
					payload = { mode: entry.mode, bookmarks: entry.bookmarks };
					body = JSON.stringify(payload);
				}

				let response: MinimalResponse;
				try {
					response = await fetchFn(endpoint, {
						method: "POST",
						headers: {
							"Content-Type": contentType,
							Authorization: `Bearer ${token}`,
						},
						body,
					});
				} catch {
					// Network error: stop, keep this entry and everything after it.
					// Screenshot attempts are NOT counted here — being offline is
					// not the entry's fault (§15.3).
					return;
				}
				if (!response.ok) {
					// Poison rule (highlight + browse + screenshot entries ONLY,
					// SPEC §6/§13/§15.3): a definitive 4xx other than 401 will never
					// succeed — drop the entry, persist the drop, and continue with
					// the rest of the queue.
					if (
						droppable &&
						response.status !== 401 &&
						response.status >= 400 &&
						response.status < 500
					) {
						if (entry.kind === "screenshot") await removeScreenshot(entry);
						else await removeEntry(entry.id);
						continue;
					}
					// A screenshot's 5xx is counted (§15.3): the fifth one drops the
					// entry rather than letting a persistent Storage failure hold
					// bookmark syncs behind it. 401 falls through uncounted.
					if (entry.kind === "screenshot" && response.status >= 500) {
						const attempts = attemptsOf(entry) + 1;
						if (attempts >= SCREENSHOT_MAX_ATTEMPTS) {
							await removeScreenshot(entry);
							continue;
						}
						await bumpAttempts(entry, attempts);
						return;
					}
					// Everything else (sync failures, 401s, uncounted non-2xx): stop,
					// keep this entry and everything after it — retry later.
					return;
				}

				// Acked: persist the deletion immediately (see header comment).
				if (entry.kind === "screenshot") await removeScreenshot(entry);
				else await removeEntry(entry.id);
			}
		} finally {
			flushing = false;
		}
	};

	return { enqueue, enqueueBrowse, enqueueScreenshot, flush };
}
