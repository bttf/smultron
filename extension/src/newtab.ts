/**
 * New tab page logic (m20, SPEC §6) — Chrome-free so it can be unit-tested:
 * the read against `GET /api/bookmarks` (Bearer token, SPEC §8), the
 * `chrome.storage.local` render snapshot that lets the page paint before any
 * network work, and the latest-wins sequencer the search box needs.
 *
 * Everything here is READ-ONLY. The new tab page never enqueues an outbox
 * entry, never writes a bookmark, and never touches sync state; the snapshot
 * is a render cache and nothing else. The page's one write — the m21 shelf
 * reorder (`PUT /api/bookmarks/pinned`) — deliberately lives in `pinOrder.ts`
 * so that stays true here.
 */

import { type KeyValueStorage, NEWTAB_KEY } from "./types";

/** The subset of the SPEC §8 bookmark JSON the new tab renders. */
export interface NewTabBookmark {
	id: number;
	url: string;
	title: string;
	/** m17 stored favicon; null → the page falls back to a hostname icon. */
	faviconUrl: string | null;
	tags: string[];
	updatedAt: string;
	/**
	 * m13 pin timestamp; null = not pinned. Since m22 the listing's log
	 * includes pinned rows, so a recent row has to say whether it is one — the
	 * log marks it with a `★` (SPEC §9).
	 */
	pinnedAt: string | null;
}

/** One painted view: the pinned shelf plus the log below it. */
export interface NewTabPage {
	pinned: NewTabBookmark[];
	recent: NewTabBookmark[];
}

/** A page plus the clock reading that produced it (drives the `offline` mark). */
export interface NewTabSnapshot extends NewTabPage {
	fetchedAtMs: number;
}

export type NewTabFetchResult =
	| { ok: true; value: NewTabPage }
	| { ok: false; status: number }
	| { ok: false; status: null; message: string };

export interface NewTabConfig {
	token: string;
	/** Already trailing-slash-trimmed by the caller. */
	baseUrl: string;
}

/**
 * Recent rows kept in the snapshot. The log shows fewer than this; the cap
 * exists so a 50-row page (plus every pin) can't grow the cached value
 * without bound in `chrome.storage.local`.
 */
export const NEWTAB_SNAPSHOT_RECENT_CAP = 30;

// ---------------------------------------------------------------------------
// Wire parsing.
//
// Defensive by design: this page paints whatever it gets on EVERY new tab, so
// one unexpected row must degrade to "that row is missing", never to a thrown
// error over the whole page.

function asBookmark(raw: unknown): NewTabBookmark | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const row = raw as Record<string, unknown>;
	if (typeof row.id !== "number") return undefined;
	if (typeof row.url !== "string" || row.url === "") return undefined;
	return {
		id: row.id,
		url: row.url,
		title: typeof row.title === "string" ? row.title : "",
		faviconUrl: typeof row.faviconUrl === "string" ? row.faviconUrl : null,
		tags: Array.isArray(row.tags)
			? row.tags.filter((tag): tag is string => typeof tag === "string")
			: [],
		updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
		pinnedAt: typeof row.pinnedAt === "string" ? row.pinnedAt : null,
	};
}

/**
 * Tolerant row-array reader, shared with `pinOrder.ts` so the reorder
 * response's shelf is parsed exactly like the listing's (m21, SPEC §8).
 */
export function asBookmarkList(raw: unknown): NewTabBookmark[] {
	if (!Array.isArray(raw)) return [];
	const rows: NewTabBookmark[] = [];
	for (const entry of raw) {
		const row = asBookmark(entry);
		if (row !== undefined) rows.push(row);
	}
	return rows;
}

/** `{bookmarks, pinned}` of a SPEC §8 listing response → a paintable page. */
export function parseBookmarksResponse(body: unknown): NewTabPage {
	const parsed = (body ?? {}) as Record<string, unknown>;
	return {
		pinned: asBookmarkList(parsed.pinned),
		recent: asBookmarkList(parsed.bookmarks),
	};
}

// ---------------------------------------------------------------------------
// Fetch.

/**
 * One `GET /api/bookmarks` with the pairing token (SPEC §8). No `q` reads the
 * live feed's first page; a non-empty `q` returns the ranked search page —
 * either way the response's `pinned` shelf is the same, so the shelf survives
 * a search unchanged.
 *
 * `fetchImpl` is injected so tests never touch the network.
 */
export async function fetchBookmarksPage(
	config: NewTabConfig,
	fetchImpl: typeof fetch,
	options: { q?: string; signal?: AbortSignal } = {},
): Promise<NewTabFetchResult> {
	const q = options.q?.trim() ?? "";
	const path =
		q === "" ? "/api/bookmarks" : `/api/bookmarks?q=${encodeURIComponent(q)}`;
	try {
		const response = await fetchImpl(`${config.baseUrl}${path}`, {
			method: "GET",
			headers: { Authorization: `Bearer ${config.token}` },
			signal: options.signal,
		});
		if (!response.ok) return { ok: false, status: response.status };
		return { ok: true, value: parseBookmarksResponse(await response.json()) };
	} catch (error) {
		return {
			ok: false,
			status: null,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

// ---------------------------------------------------------------------------
// Render snapshot.

/**
 * The last painted page, or undefined when there is nothing usable to paint.
 *
 * TOTAL by contract: a missing key, a value written by an older build, junk,
 * or a storage failure all mean "no cache". A new tab must never fail to
 * open because of what is (only) a render cache.
 */
export async function readSnapshot(
	storage: KeyValueStorage,
): Promise<NewTabSnapshot | undefined> {
	let raw: unknown;
	try {
		raw = await storage.get(NEWTAB_KEY);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as Record<string, unknown>;
	if (typeof value.fetchedAtMs !== "number") return undefined;
	if (!Array.isArray(value.pinned) || !Array.isArray(value.recent)) {
		return undefined;
	}
	return {
		pinned: asBookmarkList(value.pinned),
		recent: asBookmarkList(value.recent),
		fetchedAtMs: value.fetchedAtMs,
	};
}

/**
 * Cache a freshly fetched page for the NEXT new tab. Only ever called with a
 * feed page (never a search result) — the cache stands in for the default
 * view, not for one query's answer. Write failures are swallowed: a page that
 * rendered fine must not surface a cache-write error.
 */
export async function writeSnapshot(
	storage: KeyValueStorage,
	page: NewTabPage,
	nowMs: number,
): Promise<void> {
	const snapshot: NewTabSnapshot = {
		pinned: page.pinned,
		recent: page.recent.slice(0, NEWTAB_SNAPSHOT_RECENT_CAP),
		fetchedAtMs: nowMs,
	};
	try {
		await storage.set(NEWTAB_KEY, snapshot);
	} catch {
		// Render cache only — nothing downstream depends on this landing.
	}
}

// ---------------------------------------------------------------------------
// Latest-wins sequencing.

/**
 * Guards a stream of overlapping requests (the search box) so only the most
 * recently STARTED one may paint. A task that has been superseded by the time
 * it settles resolves to `undefined` — an earlier, slower response can never
 * overwrite the answer to what the user is typing now.
 *
 * Superseded tasks are not cancelled here; the caller may also pass an
 * AbortSignal. Rejections propagate to their own caller only.
 */
export function createLatestOnly<T>(): (
	task: () => Promise<T>,
) => Promise<T | undefined> {
	let latest = 0;
	return async (task) => {
		latest += 1;
		const ticket = latest;
		const value = await task();
		return ticket === latest ? value : undefined;
	};
}

// ---------------------------------------------------------------------------
// Display helpers.

/** `example.com/a/b` for the row's URL line; the raw string if unparseable. */
export function displayUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		const path = url.pathname === "/" ? "" : url.pathname;
		return `${url.host}${path}`;
	} catch {
		return rawUrl;
	}
}

/** Bare hostname for the shelf cards; the raw string if unparseable. */
export function displayHost(rawUrl: string): string {
	try {
		return new URL(rawUrl).host;
	} catch {
		return rawUrl;
	}
}

/**
 * The row's icon: the m17 stored favicon when the fill resolved one, else
 * Google's s2 service by hostname — the same fallback order the feed uses
 * (SPEC §9). Undefined when the URL has no hostname to ask about.
 */
export function faviconUrlFor(bookmark: NewTabBookmark): string | undefined {
	if (bookmark.faviconUrl !== null && bookmark.faviconUrl !== "") {
		return bookmark.faviconUrl;
	}
	let hostname: string;
	try {
		hostname = new URL(bookmark.url).hostname;
	} catch {
		return undefined;
	}
	if (hostname === "") return undefined;
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
}
