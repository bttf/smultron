// Web-add metadata fill (m17, SPEC §5) — the page title, favicon and note
// seed that a manually added bookmark can't know at insert time.
//
// A Chrome capture arrives with the tab's real title; a URL typed into the Add
// composer (or shared from Android) arrives with nothing but the hostname. So
// after the row lands, we ask Firecrawl what the page actually is and write
// the title + favicon onto the bookmark, seeding its note with the scrape's
// summary so a web add is immediately findable by content (m10 note search).
//
// Three invariants this module exists to hold:
//
//   1. It NEVER bumps `bookmarks.updated_at` (Hard rule #1). Enrichment is a
//      site-side fill, not a live capture — the same reasoning that keeps the
//      article pipeline (SPEC §10) off that column. The bump belongs to the
//      add itself, which already happened.
//   2. It NEVER clobbers text the user owns — neither a title they (or Chrome)
//      set nor a note they wrote. Only a row still carrying the hostname
//      placeholder (or an empty title) is title-eligible, and only a NULL note
//      is seeded; both guards are re-checked IN the UPDATE, so an edit made
//      while the fetch was in flight wins.
//   3. It NEVER rejects. Since m18 it runs only fire-and-forget in `after()`
//      (SPEC §5 — nothing waits on the fill), where a rejection would be
//      swallowed. A failed fetch simply leaves the bookmark with its hostname
//      title, which the UI treats exactly like a slow one.
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

/** The note's own ceiling, matching what the PATCH routes accept (SPEC §8). */
const MAX_NOTE_CHARS = 10_000;

/**
 * Whether the row still wants anything Firecrawl could tell us. False for a
 * bookmark that already has a real title and a favicon — a re-add of an
 * enriched URL must not spend a scrape (or make the user wait) to learn what
 * we already know.
 *
 * A missing NOTE deliberately does not count (SPEC §5): note seeding is
 * opportunistic on scrapes that happen anyway, which is what keeps a seeded
 * note the user DELETED from reappearing when the URL is re-added.
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
 * Fills `title`, `favicon_url` and a seeded `note` on one bookmark from the
 * page itself.
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
		const summary = metadata.summary?.trim().slice(0, MAX_NOTE_CHARS) || null;
		const nextTitle = wanted.title ? title : null;
		const nextFavicon = wanted.favicon ? metadata.faviconUrl : null;
		// Seeded only into an empty note — anything already there is the user's.
		const nextNote = row.note === null ? summary : null;
		if (nextTitle === null && nextFavicon === null && nextNote === null) {
			return row;
		}

		// CRITICAL: `updated_at` is absent from this SET and must stay absent
		// (Hard rule #1). The CASE guards re-check, at write time, that nobody
		// edited the title, wrote a note, or resolved a favicon while the fetch
		// was in flight.
		const set: Record<string, unknown> = {};
		if (nextTitle !== null) {
			set.title = sql`case when ${bookmarks.title} = ${row.title} then ${nextTitle} else ${bookmarks.title} end`;
		}
		if (nextFavicon !== null) {
			set.faviconUrl = sql`coalesce(${bookmarks.faviconUrl}, ${nextFavicon})`;
		}
		if (nextNote !== null) {
			set.note = sql`case when ${bookmarks.note} is null then ${nextNote} else ${bookmarks.note} end`;
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
