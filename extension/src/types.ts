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

/**
 * A queued outbox entry, routed by `kind` at flush time. Discriminate with
 * `entry.kind === "highlight"` — never with `=== "sync"`, which would
 * misclassify legacy entries missing the field.
 */
export type OutboxEntry = SyncOutboxEntry | HighlightOutboxEntry;

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

/** `chrome.storage.local` keys. */
export const CONFIG_KEY = "config";
export const OUTBOX_KEY = "outbox";

/** Name of the periodic retry alarm. */
export const FLUSH_ALARM = "outbox-flush";
