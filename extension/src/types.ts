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

/** One outbox entry = one future POST to `/api/sync`. */
export interface OutboxEntry {
	id: string;
	mode: SyncMode;
	bookmarks: SyncBookmark[];
}

/** Config persisted from the options page. */
export interface ExtensionConfig {
	token?: string;
	baseUrl?: string;
}

export const DEFAULT_BASE_URL = "https://smultron.redpine.software";

/** Max bookmarks per `/api/sync` request (SPEC §8). */
export const SYNC_BATCH_LIMIT = 500;

/** `chrome.storage.local` keys. */
export const CONFIG_KEY = "config";
export const OUTBOX_KEY = "outbox";

/** Name of the periodic retry alarm. */
export const FLUSH_ALARM = "outbox-flush";
