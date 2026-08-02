// Highlight write core — SPEC §5 (highlight semantics) + §8
// (POST /api/highlights, DELETE /api/highlights/:id). Pure functions over an
// injected Drizzle db (PGlite-testable, same pattern as sync.ts /
// bookmarks.ts). Callers (route handlers) own auth + Zod validation.
//
// A highlight insert is a LIVE CAPTURE: together with live sync (applySync)
// it is one of only TWO paths allowed to bump a bookmark's `updated_at`
// (AGENTS.md Hard rule #1). Highlights themselves are HARD-deleted — the
// soft-delete rule is scoped to bookmarks (Hard rule #4, SPEC §3).
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { bookmarks, highlights } from "../db/schema";
import { normalizeUrl } from "./normalizeUrl";

// Accept any Drizzle Postgres database or transaction (postgres-js in prod,
// PGlite in tests) — same pattern as SyncDb (sync.ts) / BookmarksDb
// (bookmarks.ts).
// biome-ignore lint/suspicious/noExplicitAny: variance of Drizzle's driver-specific generics requires it; the schema/relations generics are irrelevant here.
export type HighlightsDb = PgDatabase<PgQueryResultHKT, any, any>;

/** The created highlight, as returned by POST /api/highlights (SPEC §8). */
export type Highlight = {
	id: number;
	bookmarkId: number;
	text: string;
	createdAt: Date;
};

export type ApplyHighlightInput = {
	/** RAW page URL as sent by the extension; normalized here (Hard rule #3). */
	url: string;
	/** Immutable snippet; length limits are the route's (Zod) concern. */
	text: string;
};

/**
 * Applies §5 highlight semantics: normalize the raw URL, look up the user's
 * bookmark by `(user_id, url_normalized)`, and
 *
 * - **found**: insert the highlight row AND bump the bookmark
 *   (`updated_at = now()`, `archived_at = null` — resurface + unarchive
 *   exactly like a live re-save; title/tags/created_at untouched). Both
 *   writes happen in one transaction — never one without the other.
 * - **missing**: return `null` (no rows written anywhere); the route turns
 *   this into a `409 no_bookmark` and the extension drops the event (§6
 *   poison rule).
 */
export async function applyHighlight(
	db: HighlightsDb,
	userId: string,
	input: ApplyHighlightInput,
): Promise<Highlight | null> {
	const urlNormalized = normalizeUrl(input.url);

	return db.transaction(async (tx) => {
		const found = await tx
			.select({ id: bookmarks.id })
			.from(bookmarks)
			.where(
				and(
					eq(bookmarks.userId, userId),
					eq(bookmarks.urlNormalized, urlNormalized),
				),
			)
			.limit(1);

		const bookmark = found[0];
		if (!bookmark) {
			return null;
		}

		const inserted = await tx
			.insert(highlights)
			.values({ userId, bookmarkId: bookmark.id, text: input.text })
			.returning({
				id: highlights.id,
				bookmarkId: highlights.bookmarkId,
				text: highlights.text,
				createdAt: highlights.createdAt,
			});

		const created = inserted[0];
		if (!created) {
			// Unreachable: a VALUES insert always returns its row.
			throw new Error("highlight insert returned no row");
		}

		// Live capture: bump + unarchive, keyed on the id found above.
		await tx
			.update(bookmarks)
			.set({ updatedAt: sql`now()`, archivedAt: null })
			.where(eq(bookmarks.id, bookmark.id));

		return created;
	});
}

/**
 * Ownership-checked HARD delete (allowed for highlights — SPEC §3). Returns
 * whether a row was deleted; false (wrong id or wrong owner) → route 404s.
 */
export async function deleteHighlight(
	db: HighlightsDb,
	userId: string,
	id: number,
): Promise<boolean> {
	const deleted = await db
		.delete(highlights)
		.where(and(eq(highlights.id, id), eq(highlights.userId, userId)))
		.returning({ id: highlights.id });

	return deleted.length > 0;
}
