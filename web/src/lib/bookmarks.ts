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
//   - m9 log view: `tags` filters with AND semantics (`tags @> ARRAY[...]`,
//     exact strings). Every response carries view aggregates — `total`
//     (view only), `matching` (view + q + tags, uncapped), `facets`
//     (view + q, IGNORING the active tag filter so a selected tag keeps
//     its count; ordered count desc, tag asc; uncapped) — computed with
//     three aggregate queries per request (personal-scale data, no new
//     indexes needed).
import {
	and,
	arrayContains,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	type SQL,
	sql,
} from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { bookmarks, highlights } from "../db/schema";
import { normalizeUrl } from "./normalizeUrl";

// Accept any Drizzle Postgres database or transaction (postgres-js in prod,
// PGlite in tests) — same pattern as SyncDb (sync.ts) / PairingDb (pairing.ts).
// biome-ignore lint/suspicious/noExplicitAny: variance of Drizzle's driver-specific generics requires it; the schema/relations generics are irrelevant here.
export type BookmarksDb = PgDatabase<PgQueryResultHKT, any, any>;

/** A bookmark's nested highlight, as returned by GET /api/bookmarks (SPEC §8). */
export type BookmarkHighlight = {
	id: number;
	text: string;
	createdAt: Date;
};

export type Bookmark = {
	id: number;
	url: string;
	urlNormalized: string;
	title: string;
	tags: string[];
	/** User note (m10); null = none. */
	note: string | null;
	createdAt: Date;
	updatedAt: Date;
	archivedAt: Date | null;
	/** Ordered `created_at asc` (SPEC §8); `[]` when none. */
	highlights: BookmarkHighlight[];
};

const BOOKMARK_COLUMNS = {
	id: bookmarks.id,
	url: bookmarks.url,
	urlNormalized: bookmarks.urlNormalized,
	title: bookmarks.title,
	tags: bookmarks.tags,
	note: bookmarks.note,
	createdAt: bookmarks.createdAt,
	updatedAt: bookmarks.updatedAt,
	archivedAt: bookmarks.archivedAt,
};

export const PAGE_SIZE = 50;

/** A page row before its highlights are attached. */
type BookmarkRow = Omit<Bookmark, "highlights">;

/**
 * Attaches each row's highlights (SPEC §8: nested, `created_at asc`) with a
 * single `IN (bookmarkIds)` query for the whole page — no per-row N+1.
 * Ownership needs no extra filter: the rows are already scoped to the
 * requesting user, and a highlight's owner always matches its bookmark's.
 */
async function withHighlights(
	db: BookmarksDb,
	rows: BookmarkRow[],
): Promise<Bookmark[]> {
	if (rows.length === 0) {
		return [];
	}

	const highlightRows = await db
		.select({
			id: highlights.id,
			bookmarkId: highlights.bookmarkId,
			text: highlights.text,
			createdAt: highlights.createdAt,
		})
		.from(highlights)
		.where(
			inArray(
				highlights.bookmarkId,
				rows.map((r) => r.id),
			),
		)
		// id asc as a deterministic tiebreak when created_at collides.
		.orderBy(asc(highlights.createdAt), asc(highlights.id));

	const byBookmark = new Map<number, BookmarkHighlight[]>();
	for (const h of highlightRows) {
		let list = byBookmark.get(h.bookmarkId);
		if (!list) {
			list = [];
			byBookmark.set(h.bookmarkId, list);
		}
		list.push({ id: h.id, text: h.text, createdAt: h.createdAt });
	}

	return rows.map((row) => ({
		...row,
		highlights: byBookmark.get(row.id) ?? [],
	}));
}

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
		// Safe-integer (not just integer): a forged id like 1e19 would either
		// overflow int8 or serialize as "1e+19" — both Postgres errors that
		// would escape the InvalidCursorError → 400 mapping.
		!Number.isSafeInteger((parsed as CursorPayload).id) ||
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
	/**
	 * Tag filter, AND semantics: a row matches only if its `tags` array
	 * contains EVERY requested tag (`tags @> ARRAY[...]`, exact string
	 * match). Empty/absent = no filter. Applies to feed and search alike.
	 */
	tags?: string[];
};

/** One entry of `ListBookmarksResult.facets`. */
export type TagFacet = { tag: string; count: number };

export type ListBookmarksResult = {
	bookmarks: Bookmark[];
	nextCursor: string | null;
	/** Rows in the current view (user + archived state), ignoring q and tags. */
	total: number;
	/**
	 * Rows in the current view matching q AND the tag filter — the FULL
	 * count, not capped at PAGE_SIZE. Equals `total` when no q and no tags.
	 */
	matching: number;
	/**
	 * Per-tag counts over the current view matching q (when present) but
	 * IGNORING the tags filter, so an active tag keeps its count. Ordered
	 * count desc, then tag asc. Every tag that appears is included (no cap
	 * — personal-scale data); rows with empty tags contribute nothing.
	 */
	facets: TagFacet[];
};

/** `count(*)` over `bookmarks` under `cond`. */
async function countBookmarks(
	db: BookmarksDb,
	cond: SQL | undefined,
): Promise<number> {
	const rows = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(bookmarks)
		.where(cond);
	return rows[0]?.count ?? 0;
}

/**
 * Per-tag counts under `cond` via `unnest(tags)` in FROM (implicit LATERAL).
 * Ordering: count desc, tag asc — deterministic for the UI's facet list.
 */
async function tagFacets(
	db: BookmarksDb,
	cond: SQL | undefined,
): Promise<TagFacet[]> {
	return db
		.select({
			tag: sql<string>`t.tag`,
			count: sql<number>`count(*)::int`,
		})
		.from(sql`${bookmarks}, unnest(${bookmarks.tags}) as t(tag)`)
		.where(cond)
		.groupBy(sql`t.tag`)
		.orderBy(sql`count(*) desc`, sql`t.tag asc`);
}

/**
 * Feed (no `q`): `user_id` + archived-state filter (+ tag filter), ordered
 * `updated_at desc, id desc`, keyset-paginated 50/page.
 *
 * Search (`q`): same filters, matched via FTS (`websearch_to_tsquery`) OR
 * trigram similarity / ILIKE substring on `title` + `url_normalized`,
 * ordered by `ts_rank` desc then recency. Single page, `nextCursor: null`.
 *
 * Every page (including cursor pages — uniform shape) also carries the view
 * aggregates: `total` (ignores q + tags), `matching` (q + tags, full count),
 * and `facets` (q-scoped, IGNORES the active tag filter). See the
 * `ListBookmarksResult` field docs for exact scoping.
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
	const tags = options.tags?.length ? options.tags : undefined;
	// AND semantics: the row's tags array must contain every requested tag.
	const tagsCond = tags ? arrayContains(bookmarks.tags, tags) : undefined;

	// Decode the cursor up front (feed only) so a malformed one throws
	// InvalidCursorError before any query runs.
	const cursor = !q && options.cursor ? decodeCursor(options.cursor) : null;

	// The "current view": this user's rows in the live or archived state.
	const viewCond = and(eq(bookmarks.userId, userId), archivedCond);

	// Search predicate: FTS OR trgm similarity OR ILIKE substring. `sql`
	// template params are parameterized, so `q` is safe to interpolate
	// directly (no manual escaping). Built up front so the aggregates and the
	// search branch share the exact same condition. The tsvector expression
	// MUST stay identical to the bookmarks_fts_idx definition (db/schema.ts)
	// or the GIN index goes unused. `note` joins FTS + ILIKE only — NOT the
	// trgm `%` terms (no trgm index on note; similarity over prose is noise).
	const tsVector = sql`to_tsvector('simple', ${bookmarks.title} || ' ' || ${bookmarks.urlNormalized} || ' ' || coalesce(${bookmarks.note}, ''))`;
	const tsQuery = sql`websearch_to_tsquery('simple', ${q})`;
	const like = `%${q}%`;
	const matchCond = q
		? sql`(
			(${tsVector}) @@ (${tsQuery})
			OR ${bookmarks.title} % ${q}
			OR ${bookmarks.urlNormalized} % ${q}
			OR ${bookmarks.title} ILIKE ${like}
			OR ${bookmarks.urlNormalized} ILIKE ${like}
			OR ${bookmarks.note} ILIKE ${like}
		)`
		: undefined;

	// Aggregates (returned on every page — uniform shape):
	//   total    — view only; matching — view + q + tags (full count, no cap);
	//   facets   — view + q, IGNORING tags (an active tag keeps its count).
	// `matching === total` by definition when there's no q and no tags, so
	// skip the redundant count in that case.
	const [total, matching, facets] = await Promise.all([
		countBookmarks(db, viewCond),
		matchCond || tagsCond
			? countBookmarks(db, and(viewCond, matchCond, tagsCond))
			: undefined,
		tagFacets(db, and(viewCond, matchCond)),
	]);
	const aggregates = { total, matching: matching ?? total, facets };

	if (!q) {
		const conditions = [viewCond, tagsCond];

		if (cursor) {
			// Keyset pagination: strictly "after" the cursor row in the
			// (updated_at desc, id desc) ordering. Row-comparison is
			// lexicographic, which matches that ordering exactly.
			// The params MUST be cast explicitly: raw sql`` params are sent
			// untyped, and postgres-js stringifies a Date param into a form
			// Postgres can't parse inside a row constructor (500 in prod,
			// invisible on PGlite) — so pass an ISO string + ::timestamptz.
			// Round-tripping through new Date(...).toISOString() normalizes
			// forged-but-JS-parseable `u` values (e.g. "1") into a form
			// Postgres is guaranteed to accept.
			conditions.push(
				sql`(${bookmarks.updatedAt}, ${bookmarks.id}) < (${new Date(cursor.u).toISOString()}::timestamptz, ${cursor.id}::bigint)`,
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

		return {
			bookmarks: await withHighlights(db, page),
			nextCursor,
			...aggregates,
		};
	}

	const rows = await db
		.select(BOOKMARK_COLUMNS)
		.from(bookmarks)
		.where(and(viewCond, matchCond, tagsCond))
		.orderBy(
			sql`ts_rank((${tsVector}), (${tsQuery})) desc`,
			desc(bookmarks.updatedAt),
			desc(bookmarks.id),
		)
		.limit(PAGE_SIZE);

	return {
		bookmarks: await withHighlights(db, rows),
		nextCursor: null,
		...aggregates,
	};
}

/**
 * Web-UI add (POST /api/bookmarks, m11): upsert on `(user_id, url_normalized)`
 * from a RAW URL (SPEC §5 web add). Insert: `created_at = updated_at = now()`,
 * title autofilled from the hostname (`www.` stripped), no tags, no chrome_id.
 * Conflict (already saved): bump `updated_at` + unarchive ONLY —
 * title/tags/url/chrome_id/created_at stay untouched; unlike a Chrome live
 * re-save there is no fresher title/spelling to trust. A deliberate user save
 * is a live capture, so this path is allowed to bump `updated_at` (Hard rule
 * #1 lists it alongside `applySync` live mode and `applyHighlight`).
 */
export async function addBookmark(
	db: BookmarksDb,
	userId: string,
	rawUrl: string,
): Promise<{ bookmark: BookmarkRow; created: boolean }> {
	const now = new Date();
	let host = "";
	try {
		host = new URL(rawUrl).hostname;
	} catch {
		// Unparseable input still stores (normalizeUrl falls back to the
		// trimmed original) — it just gets no autofilled title. The route
		// rejects these before we get here; this is belt-and-braces.
	}

	const rows = await db
		.insert(bookmarks)
		.values({
			userId,
			url: rawUrl,
			urlNormalized: normalizeUrl(rawUrl),
			title: host.replace(/^www\./, ""),
			tags: [],
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [bookmarks.userId, bookmarks.urlNormalized],
			set: { updatedAt: sql`now()`, archivedAt: null },
		})
		// xmax = 0 distinguishes a fresh insert from a conflict-update (same
		// trick as applySync): an updated row carries the old version's
		// locking txid in xmax, a brand-new row has xmax = 0.
		.returning({ ...BOOKMARK_COLUMNS, wasInserted: sql<boolean>`(xmax = 0)` });

	const { wasInserted, ...bookmark } = rows[0];
	return { bookmark, created: wasInserted };
}

export type PatchBookmarkInput = {
	title?: string;
	tags?: string[];
	/** Trimmed server-side; empty-after-trim stores NULL (note removed). */
	note?: string;
	archived?: boolean;
};

type PatchSet = {
	title?: string;
	tags?: string[];
	note?: string | null;
	archivedAt?: Date | null;
};

/** Maps the wire-level patch input to column assignments (note trim→null). */
function buildPatchSet(input: PatchBookmarkInput): PatchSet {
	const set: PatchSet = {};
	if (input.title !== undefined) {
		set.title = input.title;
	}
	if (input.tags !== undefined) {
		set.tags = input.tags;
	}
	if (input.note !== undefined) {
		const trimmed = input.note.trim();
		set.note = trimmed === "" ? null : trimmed;
	}
	if (input.archived !== undefined) {
		set.archivedAt = input.archived ? new Date() : null;
	}
	return set;
}

/**
 * Applies `input` to the single row matching `cond` (which must already
 * include the ownership check). CRITICAL (AGENTS.md Hard rule #1): never
 * touches `updated_at` — only live captures (`applySync` live mode,
 * `applyHighlight`) bump it. Returns null when no row matches — callers turn
 * that into a 404. Returns the bare row WITHOUT nested highlights: SPEC §8
 * nests them only in GET /api/bookmarks responses.
 */
async function patchWhere(
	db: BookmarksDb,
	cond: SQL | undefined,
	input: PatchBookmarkInput,
): Promise<BookmarkRow | null> {
	const set = buildPatchSet(input);

	if (Object.keys(set).length === 0) {
		// Nothing to change (callers should reject this earlier via Zod) —
		// just report the current row, ownership-checked, or null.
		const rows = await db
			.select(BOOKMARK_COLUMNS)
			.from(bookmarks)
			.where(cond)
			.limit(1);
		return rows[0] ?? null;
	}

	const rows = await db
		.update(bookmarks)
		.set(set)
		.where(cond)
		.returning(BOOKMARK_COLUMNS);

	return rows[0] ?? null;
}

/**
 * Updates ONLY the provided fields, scoped to `user_id` for ownership.
 * `archived: true` sets `archived_at = now()`; `false` clears it to null.
 * Never bumps `updated_at` (see `patchWhere`).
 */
export async function patchBookmark(
	db: BookmarksDb,
	userId: string,
	id: number,
	input: PatchBookmarkInput,
): Promise<BookmarkRow | null> {
	return patchWhere(
		db,
		and(eq(bookmarks.id, id), eq(bookmarks.userId, userId)),
		input,
	);
}

/**
 * Looks up a bookmark by `(user_id, url_normalized)` from a RAW URL — the
 * extension always sends raw URLs; normalization happens here, server-side,
 * via the single `normalizeUrl` implementation (Hard rule #3). Returns the
 * bare row (no nested highlights) or null when the user has no bookmark for
 * that URL. Used by GET /api/bookmarks/by-url (extension popup).
 */
export async function getBookmarkByUrl(
	db: BookmarksDb,
	userId: string,
	rawUrl: string,
): Promise<BookmarkRow | null> {
	const rows = await db
		.select(BOOKMARK_COLUMNS)
		.from(bookmarks)
		.where(
			and(
				eq(bookmarks.userId, userId),
				eq(bookmarks.urlNormalized, normalizeUrl(rawUrl)),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

/**
 * `patchBookmark`, but resolved by RAW URL (normalized server-side) instead
 * of id — the extension popup's edit path (PATCH /api/bookmarks/by-url).
 * Identical patch semantics: never bumps `updated_at`; null when the user
 * has no bookmark for that URL (route 404s).
 */
export async function patchBookmarkByUrl(
	db: BookmarksDb,
	userId: string,
	rawUrl: string,
	input: PatchBookmarkInput,
): Promise<BookmarkRow | null> {
	return patchWhere(
		db,
		and(
			eq(bookmarks.userId, userId),
			eq(bookmarks.urlNormalized, normalizeUrl(rawUrl)),
		),
		input,
	);
}
