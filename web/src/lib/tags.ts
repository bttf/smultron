// GET /api/tags query core — SPEC §8 (m14). Pure function over an injected
// Drizzle db (PGlite-testable), same shape as the bookmarks/sync libs; the
// route handler owns auth.
import { eq, sql } from "drizzle-orm";
import { bookmarks } from "../db/schema";
import type { BookmarksDb } from "./bookmarks";

/**
 * The user's distinct tags across ALL their bookmark rows, ordered by usage
 * count desc then tag asc (same ordering as the feed's facets).
 *
 * Archived rows are deliberately INCLUDED (SPEC §8): a tag the user has
 * already used stays autocomplete-worthy even if every bookmark carrying it
 * has been archived. Uncapped — personal scale, like facets.
 */
export async function listTags(
	db: BookmarksDb,
	userId: string,
): Promise<string[]> {
	// `unnest(tags)` in FROM (implicit LATERAL) — the facet idiom in
	// bookmarks.ts, grouped per tag.
	const rows = await db
		.select({ tag: sql<string>`t.tag` })
		.from(sql`${bookmarks}, unnest(${bookmarks.tags}) as t(tag)`)
		.where(eq(bookmarks.userId, userId))
		.groupBy(sql`t.tag`)
		.orderBy(sql`count(*) desc`, sql`t.tag asc`);

	return rows.map((row) => row.tag);
}
