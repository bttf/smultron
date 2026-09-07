/**
 * Shared types mirroring the SPEC §8 `/api/sync` contract exactly.
 *
 * The extension sends RAW urls and Chrome's `dateAdded` (ms epoch) as-is;
 * all normalization happens server-side (AGENTS.md hard rule #3).
 */

export type SyncMode = "live" | "backfill";

/**
 * One bookmark in a `/api/sync` payload (SPEC §8).
 *
 * `faviconUrl` is the open tab's `favIconUrl` and rides ONLY on live captures
 * (SPEC §5) — `flattenTree` never sets it, so backfill batches never carry it.
 */
export interface SyncBookmark {
	url: string;
	title: string;
	chromeId: string;
	dateAddedMs?: number;
	folderPath?: string;
	faviconUrl?: string;
}

/** Body of `POST {baseUrl}/api/sync`. Max SYNC_BATCH_LIMIT bookmarks. */
export interface SyncPayload {
	mode: SyncMode;
	bookmarks: SyncBookmark[];
}

/** Body of `POST {baseUrl}/api/highlights` (SPEC §8). */
export interface HighlightPayload {
	url: string;
	text: string;
}

/**
 * One outbox entry = one future POST to `/api/sync`.
 *
 * `kind` is optional for backward compatibility: entries persisted to
 * `chrome.storage.local` before highlights shipped have no `kind` field.
 * Everywhere in the codebase, anything without `kind: "highlight"` is a
 * sync entry (SPEC §6).
 */
export interface SyncOutboxEntry {
	id: string;
	kind?: "sync";
	mode: SyncMode;
	bookmarks: SyncBookmark[];
}

/** One outbox entry = one future POST to `/api/highlights`. */
export interface HighlightOutboxEntry {
	id: string;
	kind: "highlight";
	url: string;
	text: string;
}

/**
 * One outbox entry = one future POST to
 * `/api/bookmarks/by-url/screenshot?url=…` (m23, SPEC §15.3).
 *
 * `url` is the RAW bookmark URL (hard rule #3 — the server normalizes it to
 * find the row). The JPEG itself is deliberately NOT in the entry: it lives
 * base64-encoded (no `data:` prefix) under `blobKey` as its own
 * `chrome.storage.local` key, so the outbox array stays small — every sync
 * enqueue and every flush step re-reads the whole queue, and dragging
 * megabytes of image data through those reads would tax bookmark capture.
 *
 * `attempts` counts 5xx responses only (§15.3): at SCREENSHOT_MAX_ATTEMPTS the
 * entry is dropped so a persistent Storage-side failure cannot hold bookmark
 * syncs behind it forever.
 */
export interface ScreenshotOutboxEntry {
	id: string;
	kind: "screenshot";
	url: string;
	blobKey: string;
	attempts: number;
}

// ---------------------------------------------------------------------------
// Attention tracking (m19, SPEC §13).

/** The browse-event kinds of SPEC §13. */
export type BrowseEventKind =
	| "nav"
	| "tab_activated"
	| "window_focus"
	| "window_blur"
	| "idle"
	| "capture_start"
	| "capture_stop";

/** `chrome.idle` states, as recorded on `idle` events (SPEC §13). */
export type IdleState = "active" | "idle" | "locked";

/**
 * One captured browse event, as buffered in `chrome.storage.local` and
 * carried by a `browse` outbox entry.
 *
 * `id` IS the wire's `clientEventId` (the server's idempotency key) — the
 * field is named `id` in storage so buffer/outbox code can dedupe by id like
 * every other entry; `toBrowseEventInput` renames it at the wire boundary.
 * Optional fields are ABSENT (never `undefined`/`null`) when they don't apply:
 * the server rejects fields a kind doesn't declare (SPEC §13).
 */
export interface BrowseEvent {
	id: string;
	bootId: string;
	kind: BrowseEventKind;
	occurredAtMs: number;
	url?: string;
	title?: string;
	tabId?: number;
	windowId?: number;
	idleState?: IdleState;
	transition?: string;
	documentLifecycle?: string;
}

/** One event in a `POST /api/browse-events` body (SPEC §8/§13). */
export interface BrowseEventInput {
	clientEventId: string;
	bootId: string;
	kind: BrowseEventKind;
	occurredAtMs: number;
	url?: string;
	title?: string;
	tabId?: number;
	windowId?: number;
	idleState?: IdleState;
	transition?: string;
	documentLifecycle?: string;
}

/** Body of `POST {baseUrl}/api/browse-events`. Max BROWSE_BATCH_LIMIT events. */
export interface BrowseEventsPayload {
	events: BrowseEventInput[];
}

/** One outbox entry = one future POST to `/api/browse-events`. */
export interface BrowseOutboxEntry {
	id: string;
	kind: "browse";
	events: BrowseEvent[];
}

/** The `attention` storage value (SPEC §13). A missing key = disabled. */
export interface AttentionSettings {
	enabled: boolean;
}

/**
 * A queued outbox entry, routed by `kind` at flush time. Discriminate with
 * `entry.kind === "highlight"` / `=== "browse"` — never with `=== "sync"`,
 * which would misclassify legacy entries missing the field.
 */
export type OutboxEntry =
	| SyncOutboxEntry
	| HighlightOutboxEntry
	| BrowseOutboxEntry
	| ScreenshotOutboxEntry;

/**
 * Minimal async key/value storage (`chrome.storage.local` — or
 * `chrome.storage.session` for the capture session — in production).
 * Injected everywhere so `src/` stays Chrome-free and unit-testable.
 *
 * `remove` (m23, SPEC §15.3) is optional here because most consumers only
 * read and write; the outbox, which owns the screenshot blob side-store,
 * demands it through `BlobKeyValueStorage` below.
 */
export interface KeyValueStorage {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	remove?(key: string): Promise<void>;
}

/**
 * Storage that can also DELETE a key — what the outbox needs for the
 * screenshot blob side-store (SPEC §15.3), where an orphan blob must never
 * outlive its entry.
 */
export interface BlobKeyValueStorage extends KeyValueStorage {
	remove(key: string): Promise<void>;
}

/** Config persisted from the options page. */
export interface ExtensionConfig {
	token?: string;
	baseUrl?: string;
}

export const DEFAULT_BASE_URL = "https://smultron.redpine.software";

/** Max bookmarks per `/api/sync` request (SPEC §8). */
export const SYNC_BATCH_LIMIT = 500;

/** Max highlight text length in chars (SPEC §6/§8): selections are truncated. */
export const HIGHLIGHT_TEXT_LIMIT = 10_000;

/** Max events per `/api/browse-events` request (SPEC §8/§13). */
export const BROWSE_BATCH_LIMIT = 500;

/**
 * Backlog caps (drop-oldest, telemetry ONLY — SPEC §13). Beyond either, the
 * OLDEST browse data is dropped; sync/highlight entries are never touched.
 */
export const BROWSE_BUFFER_CAP = 2_000;
export const BROWSE_OUTBOX_ENTRY_CAP = 20;

/**
 * Screenshot backlog cap (m23, SPEC §15.3): drop-oldest among `screenshot`
 * entries ONLY, applied at enqueue time exactly like the browse cap — sync,
 * highlight and browse entries and their relative order are never touched, and
 * a dropped entry's blob is removed with it. Worst case queued image data is
 * 10 × 1 MiB × 4/3 (base64) ≈ 13.3 MiB, which is why the manifest asks for
 * `unlimitedStorage` (SPEC §6).
 */
export const SCREENSHOT_OUTBOX_ENTRY_CAP = 10;

/**
 * 5xx responses a screenshot entry may collect before it is dropped
 * (SPEC §15.3). 401s and network errors never count — a revoked token or an
 * offline stretch is not the screenshot's fault.
 */
export const SCREENSHOT_MAX_ATTEMPTS = 5;

/** Prefix of the `chrome.storage.local` key holding one entry's JPEG bytes. */
export const SCREENSHOT_BLOB_PREFIX = "screenshot:";

/** Buffered-event count that triggers a drain right after an append (§13). */
export const BROWSE_DRAIN_THRESHOLD = 50;

/**
 * Server-side length bounds for browse-event string fields (SPEC §13). The
 * extension clamps to them so one pathological value can never 400 — and
 * therefore poison-drop — a whole 500-event batch.
 */
export const BROWSE_URL_LIMIT = 8_192;
export const BROWSE_TITLE_LIMIT = 4_096;
export const BROWSE_TRANSITION_LIMIT = 256;
export const BROWSE_DOCUMENT_LIFECYCLE_LIMIT = 64;

/**
 * The server's `occurredAtMs` upper bound (SPEC §13): the last millisecond of
 * year 9999. Deliberately NOT the max representable JS Date
 * (8_640_000_000_000_000) — from year 10000 on, `toISOString()` emits
 * expanded-year form Postgres rejects, so the server 400s anything above this
 * and the outbox poison rule would drop the whole batch. MUST stay equal to
 * `MAX_OCCURRED_AT_MS` in web's browseEvents.ts (pinned by
 * web/src/lib/browseEventsWire.test.ts).
 */
export const MAX_TIMESTAMP_MS = 253_402_300_799_999;

/** `chrome.storage.local` keys. */
export const CONFIG_KEY = "config";
export const OUTBOX_KEY = "outbox";
/** m19: the opt-in toggle — its OWN key, never the options-page config
 * object (which is rewritten wholesale on save). Missing = disabled. */
export const ATTENTION_KEY = "attention";
/** m19: the browse-event buffer awaiting a drain into the outbox. */
export const BROWSE_BUFFER_KEY = "browseBuffer";
/** m20: the new tab page's render snapshot — a paint cache, never a write
 * path. Its own key, like `attention`: the options-page config object is
 * rewritten wholesale on save. */
export const NEWTAB_KEY = "newtab";

/** `chrome.storage.session` key holding the capture session's `bootId`. */
export const BOOT_ID_KEY = "bootId";

/** Name of the periodic retry alarm. */
export const FLUSH_ALARM = "outbox-flush";
/** Name of the periodic browse-buffer drain alarm (m19, 1 minute). */
export const BROWSE_DRAIN_ALARM = "browse-drain";
