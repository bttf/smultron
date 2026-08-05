// Web-add metadata fill (m15, SPEC §5) — the page title and favicon that a
// manually added bookmark can't know at insert time.
//
// A Chrome capture arrives with the tab's real title; a URL typed into the Add
// composer (or shared from Android) arrives with nothing but the hostname. So
// after the row lands, we ask Firecrawl what the page actually is and write
// the title + favicon onto the bookmark.
//
// Three invariants this module exists to hold:
//
//   1. It NEVER bumps `bookmarks.updated_at` (Hard rule #1). Enrichment is a
//      site-side fill, not a live capture — the same reasoning that keeps the
//      article pipeline (SPEC §10) off that column. The bump belongs to the
//      add itself, which already happened.
//   2. It NEVER clobbers a title the user owns. Only a row still carrying the
//      hostname placeholder (or an empty title) is eligible; the guard is
//      re-checked IN the UPDATE, so an edit made while the fetch was in
//      flight wins.
//   3. It NEVER rejects. It runs both inside a request the user is waiting on
//      and fire-and-forget in `after()`, where a rejection would be swallowed.
//      A failed fetch simply leaves the bookmark with its hostname title.
//
// The fetcher is injected (same pattern as `runArticleJob`) so the semantics
// tests run offline against PGlite with no Firecrawl account in sight.
import { and, eq, sql } from "drizzle-orm";
import { bookmarks } from "../db/schema";
import {
	BOOKMARK_COLUMNS,
	type BookmarkRow,
	type BookmarksDb,
	hostnameTitle,
} from "./bookmarks";
import type { PageMetadata } from "./firecrawl";

/** `scrapePageMetadata` in prod; a stub in tests. May throw — we catch. */
export type MetadataFetcher = (url: string) => Promise<PageMetadata>;

/** Titles land in a feed row; anything longer than this is page junk. */
const MAX_TITLE_CHARS = 500;

/**
 * How long POST /api/bookmarks holds the add request open waiting for the
 * fill (SPEC §5). Long enough that the common case — the composer closing
 * onto a row with its real title — is what the user sees; short enough that a
 * slow page doesn't turn a save into a stare. Past it the response ships the
 * un-filled row and the fill finishes in `after()`, landing on the next SWR
 * poll (~10s).
 */
export const METADATA_WAIT_MS = 12_000;

/**
 * Resolves with `promise`'s value, or `undefined` once `ms` have passed —
 * whichever comes first. The promise itself keeps running; the caller hands
 * it to `after()` so its write still happens.
 */
export function settleWithin<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				// enrichBookmarkMetadata never rejects; belt-and-braces so a
				// future caller can't hang the request on a rejection.
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

/**
 * Whether the row still wants anything Firecrawl could tell us. False for a
 * bookmark that already has a real title and a favicon — a re-add of an
 * enriched URL must not spend a scrape (or make the user wait) to learn what
 * we already know.
 */
function needsMetadata(row: BookmarkRow): {
	title: boolean;
	favicon: boolean;
	any: boolean;
} {
	// Only the hostname placeholder (or nothing at all) is ours to overwrite;
	// a Chrome-captured or user-edited title is not.
	const title = row.title.trim() === "" || row.title === hostnameTitle(row.url);
	const favicon = row.faviconUrl === null;
	return { title, favicon, any: title || favicon };
}

/**
 * Fills `title` and `favicon_url` on one bookmark from the page itself.
 *
 * Returns the row as it now stands — enriched, or unchanged when there was
 * nothing to fill, the fetch failed, or the page offered nothing. Returns null
 * only when the bookmark doesn't exist for this user (the caller then keeps
 * whatever row it already had).
 */
export async function enrichBookmarkMetadata(
	db: BookmarksDb,
	fetchMetadata: MetadataFetcher,
	target: { userId: string; bookmarkId: number },
): Promise<BookmarkRow | null> {
	const ownership = and(
		eq(bookmarks.id, target.bookmarkId),
		eq(bookmarks.userId, target.userId),
	);

	try {
		const existing = await db
			.select(BOOKMARK_COLUMNS)
			.from(bookmarks)
			.where(ownership)
			.limit(1);

		const row = existing[0];
		if (!row) {
			return null;
		}

		const wanted = needsMetadata(row);
		if (!wanted.any) {
			return row;
		}

		let metadata: PageMetadata;
		try {
			metadata = await fetchMetadata(row.url);
		} catch {
			// Scrape failures are not the user's problem: the bookmark is saved,
			// it just keeps its hostname title. (PipelineError carries a message
			// meant for the article reader's UI; there is no surface for it here.)
			return row;
		}

		const title = metadata.title?.trim().slice(0, MAX_TITLE_CHARS) || null;
		const nextTitle = wanted.title ? title : null;
		const nextFavicon = wanted.favicon ? metadata.faviconUrl : null;
		if (nextTitle === null && nextFavicon === null) {
			return row;
		}

		// CRITICAL: `updated_at` is absent from this SET and must stay absent
		// (Hard rule #1). The CASE guards re-check, at write time, that nobody
		// edited the title or resolved a favicon while the fetch was in flight.
		const set: Record<string, unknown> = {};
		if (nextTitle !== null) {
			set.title = sql`case when ${bookmarks.title} = ${row.title} then ${nextTitle} else ${bookmarks.title} end`;
		}
		if (nextFavicon !== null) {
			set.faviconUrl = sql`coalesce(${bookmarks.faviconUrl}, ${nextFavicon})`;
		}

		const updated = await db
			.update(bookmarks)
			.set(set)
			.where(ownership)
			.returning(BOOKMARK_COLUMNS);

		return updated[0] ?? row;
	} catch {
		// DB trouble (or anything else unforeseen): the add itself already
		// succeeded, so swallow it — see invariant 3 in the header.
		return null;
	}
}
