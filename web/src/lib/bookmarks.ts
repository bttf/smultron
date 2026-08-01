// Bookmark feed/search/edit query core — SPEC §8 (GET/PATCH /api/bookmarks*).
// Pure functions over an injected Drizzle db (PGlite-testable, same pattern
// as sync.ts / pairing.ts). Callers (route handlers) own auth + Zod
// validation; this module owns the actual queries.
//
// Decisions not fully pinned down by SPEC (documented here per orchestrator
// instructions):
//   - `archived=1` means the ARCHIVED VIEW: only archived rows. Without it,
//     only live (non-archived) rows. This is the natural "toggle to the
//     archived view" reading of SPEC §9 ("Archived view toggle; unarchive
//     from there") and matches the UI's Archived toggle being a binary
//     switch between the live feed and the archive, not an "include
//     archived" flag.
//   - Search (`q` present) has NO cursor pagination — SPEC §8 only defines
//     cursor pagination for the feed ("No `q`: ... cursor-paginated"); the
//     search branch always returns `nextCursor: null` and caps at one page
//     (PAGE_SIZE rows), ranked by ts_rank then recency. Good enough for a
//     single-user tool's search box; deeper search paging is out of scope.
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { bookmarks } from "../db/schema";

// Accept any Drizzle Postgres database or transaction (postgres-js in prod,
// PGlite in tests) — same pattern as SyncDb (sync.ts) / PairingDb (pairing.ts).
// biome-ignore lint/suspicious/noExplicitAny: variance of Drizzle's driver-specific generics requires it; the schema/relations generics are irrelevant here.
export type BookmarksDb = PgDatabase<PgQueryResultHKT, any, any>;

export type Bookmark = {
	id: number;
	url: string;
	urlNormalized: string;
	title: string;
	tags: string[];
	createdAt: Date;
	updatedAt: Date;
	archivedAt: Date | null;
};

const BOOKMARK_COLUMNS = {
	id: bookmarks.id,
	url: bookmarks.url,
	urlNormalized: bookmarks.urlNormalized,
	title: bookmarks.title,
	tags: bookmarks.tags,
	createdAt: bookmarks.createdAt,
	updatedAt: bookmarks.updatedAt,
	archivedAt: bookmarks.archivedAt,
};

export const PAGE_SIZE = 50;

/** Thrown by `listBookmarks` when `cursor` isn't a value it produced. */
export class InvalidCursorError extends Error {
	constructor() {
		super("invalid cursor");
		this.name = "InvalidCursorError";
	}
}

type CursorPayload = { u: string; id: number };

/** Opaque base64url cursor over the feed's keyset (`updated_at`, `id`). */
function encodeCursor(updatedAt: Date, id: number): string {
	const payload: CursorPayload = { u: updatedAt.toISOString(), id };
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload {
	let json: string;
	try {
		json = Buffer.from(raw, "base64url").toString("utf8");
	} catch {
		throw new InvalidCursorError();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new InvalidCursorError();
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as CursorPayload).u !== "string" ||
		typeof (parsed as CursorPayload).id !== "number" ||
		!Number.isInteger((parsed as CursorPayload).id) ||
		Number.isNaN(new Date((parsed as CursorPayload).u).getTime())
	) {
		throw new InvalidCursorError();
	}

	return parsed as CursorPayload;
}

export type ListBookmarksOptions = {
	/** Search text. Empty/whitespace-only is treated as "no q" (feed). */
	q?: string;
	/** Opaque cursor from a previous `nextCursor`. Feed only; ignored for search. */
	cursor?: string;
	/** true = ONLY archived rows (the archive view); false/omitted = live feed. */
	archived?: boolean;
};

export type ListBookmarksResult = {
	bookmarks: Bookmark[];
	nextCursor: string | null;
};

/**
 * Feed (no `q`): `user_id` + archived-state filter, ordered
 * `updated_at desc, id desc`, keyset-paginated 50/page.
 *
 * Search (`q`): same filters, matched via FTS (`websearch_to_tsquery`) OR
 * trigram similarity / ILIKE substring on `title` + `url_normalized`,
 * ordered by `ts_rank` desc then recency. Single page, `nextCursor: null`.
 */
export async function listBookmarks(
	db: BookmarksDb,
	userId: string,
	options: ListBookmarksOptions = {},
): Promise<ListBookmarksResult> {
	const archivedCond = options.archived
		? isNotNull(bookmarks.archivedAt)
		: isNull(bookmarks.archivedAt);

	const q = options.q?.trim();

	if (!q) {
		const conditions = [eq(bookmarks.userId, userId), archivedCond];

		if (options.cursor) {
			const cursor = decodeCursor(options.cursor);
			// Keyset pagination: strictly "after" the cursor row in the
			// (updated_at desc, id desc) ordering. Row-comparison is
			// lexicographic, which matches that ordering exactly.
			conditions.push(
				sql`(${bookmarks.updatedAt}, ${bookmarks.id}) < (${new Date(cursor.u)}, ${cursor.id})`,
			);
		}

		const rows = await db
			.select(BOOKMARK_COLUMNS)
			.from(bookmarks)
			.where(and(...conditions))
			.orderBy(desc(bookmarks.updatedAt), desc(bookmarks.id))
			.limit(PAGE_SIZE + 1);

		const hasMore = rows.length > PAGE_SIZE;
		const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
		const last = page.at(-1);
		const nextCursor =
			hasMore && last ? encodeCursor(last.updatedAt, last.id) : null;

		return { bookmarks: page, nextCursor };
	}

	// Search: FTS OR trgm similarity OR ILIKE substring, on title +
	// url_normalized. `sql` template params are parameterized, so `q` is
	// safe to interpolate directly (no manual escaping).
	const tsVector = sql`to_tsvector('simple', ${bookmarks.title} || ' ' || ${bookmarks.urlNormalized})`;
	const tsQuery = sql`websearch_to_tsquery('simple', ${q})`;
	const like = `%${q}%`;

	const matchCond = sql`(
		(${tsVector}) @@ (${tsQuery})
		OR ${bookmarks.title} % ${q}
		OR ${bookmarks.urlNormalized} % ${q}
		OR ${bookmarks.title} ILIKE ${like}
		OR ${bookmarks.urlNormalized} ILIKE ${like}
	)`;

	const rows = await db
		.select(BOOKMARK_COLUMNS)
		.from(bookmarks)
		.where(and(eq(bookmarks.userId, userId), archivedCond, matchCond))
		.orderBy(
			sql`ts_rank((${tsVector}), (${tsQuery})) desc`,
			desc(bookmarks.updatedAt),
			desc(bookmarks.id),
		)
		.limit(PAGE_SIZE);

	return { bookmarks: rows, nextCursor: null };
}

export type PatchBookmarkInput = {
	title?: string;
	tags?: string[];
	archived?: boolean;
};

/**
 * Updates ONLY the provided fields, scoped to `user_id` for ownership.
 * `archived: true` sets `archived_at = now()`; `false` clears it to null.
 *
 * CRITICAL (AGENTS.md Hard rule #1): never touches `updated_at` — only live
 * sync (`applySync`, sync.ts) bumps it. Returns null when no row matches
 * (wrong id or wrong owner) — the route turns that into a 404.
 */
export async function patchBookmark(
	db: BookmarksDb,
	userId: string,
	id: number,
	input: PatchBookmarkInput,
): Promise<Bookmark | null> {
	const set: { title?: string; tags?: string[]; archivedAt?: Date | null } = {};
	if (input.title !== undefined) {
		set.title = input.title;
	}
	if (input.tags !== undefined) {
		set.tags = input.tags;
	}
	if (input.archived !== undefined) {
		set.archivedAt = input.archived ? new Date() : null;
	}

	if (Object.keys(set).length === 0) {
		// Nothing to change (callers should reject this earlier via Zod) —
		// just report the current row, ownership-checked, or null.
		const rows = await db
			.select(BOOKMARK_COLUMNS)
			.from(bookmarks)
			.where(and(eq(bookmarks.id, id), eq(bookmarks.userId, userId)))
			.limit(1);
		return rows[0] ?? null;
	}

	const rows = await db
		.update(bookmarks)
		.set(set)
		.where(and(eq(bookmarks.id, id), eq(bookmarks.userId, userId)))
		.returning(BOOKMARK_COLUMNS);

	return rows[0] ?? null;
}
