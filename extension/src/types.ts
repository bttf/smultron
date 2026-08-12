/**
 * Shared types mirroring the SPEC §8 `/api/sync` contract exactly.
 *
 * The extension sends RAW urls and Chrome's `dateAdded` (ms epoch) as-is;
 * all normalization happens server-side (AGENTS.md hard rule #3).
 */

export type SyncMode = "live" | "backfill";

/** One bookmark in a `/api/sync` payload (SPEC §8). */
export interface SyncBookmark {
	url: string;
	title: string;
	chromeId: string;
	dateAddedMs?: number;
	folderPath?: string;
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
	| BrowseOutboxEntry;

/**
 * Minimal async key/value storage (`chrome.storage.local` — or
 * `chrome.storage.session` for the capture session — in production).
 * Injected everywhere so `src/` stays Chrome-free and unit-testable.
 */
export interface KeyValueStorage {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
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

/** Max representable JS Date, the server's `occurredAtMs` upper bound (§13). */
export const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

/** `chrome.storage.local` keys. */
export const CONFIG_KEY = "config";
export const OUTBOX_KEY = "outbox";
/** m19: the opt-in toggle — its OWN key, never the options-page config
 * object (which is rewritten wholesale on save). Missing = disabled. */
export const ATTENTION_KEY = "attention";
/** m19: the browse-event buffer awaiting a drain into the outbox. */
export const BROWSE_BUFFER_KEY = "browseBuffer";

/** `chrome.storage.session` key holding the capture session's `bootId`. */
export const BOOT_ID_KEY = "bootId";

/** Name of the periodic retry alarm. */
export const FLUSH_ALARM = "outbox-flush";
/** Name of the periodic browse-buffer drain alarm (m19, 1 minute). */
export const BROWSE_DRAIN_ALARM = "browse-drain";
