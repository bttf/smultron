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
//   - m22 pins: the log lists pinned rows like any others, on BOTH branches.
//     m13–m21 excluded them from the feed (no `q`) branch in favor of the
//     shelf, which left a pinned row visible only as a shelf card — out of
//     the log's chronology and uneditable in place. The shelf is quick
//     access, not the row's new home, so the exclusion is gone and with it
//     the subtraction from `matching`: on a plain live feed (no q, no tags)
//     `matching === total` again. `pinned` still carries the whole shelf on
//     every response; `total` and `facets` are unchanged (they always
//     described the view, not the log).
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
	/**
	 * Absolute favicon URL from the m17 metadata fill; null when it never ran
	 * or the page declared no icon (the UI falls back to a hostname-derived
	 * favicon service).
	 */
	faviconUrl: string | null;
	tags: string[];
	/** User note (m10); null = none. */
	note: string | null;
	createdAt: Date;
	updatedAt: Date;
	archivedAt: Date | null;
	/**
	 * Pinned to the shelf (m13); null = not pinned. WHEN it was pinned — the
	 * shelf's ORDER key is `pin_position` since m21, which is deliberately NOT
	 * serialized: the `pinned` array's order is the contract (SPEC §8).
	 */
	pinnedAt: Date | null;
	/** Ordered `created_at asc` (SPEC §8); `[]` when none. */
	highlights: BookmarkHighlight[];
};

/** The bookmark columns every route serializes (exported for `bookmarkMetadata.ts`). */
export const BOOKMARK_COLUMNS = {
	id: bookmarks.id,
	url: bookmarks.url,
	urlNormalized: bookmarks.urlNormalized,
	title: bookmarks.title,
	faviconUrl: bookmarks.faviconUrl,
	tags: bookmarks.tags,
	note: bookmarks.note,
	createdAt: bookmarks.createdAt,
	updatedAt: bookmarks.updatedAt,
	archivedAt: bookmarks.archivedAt,
	pinnedAt: bookmarks.pinnedAt,
};

export const PAGE_SIZE = 50;

/** A page row before its highlights are attached. */
export type BookmarkRow = Omit<Bookmark, "highlights">;

/**
 * The title a web add (SPEC §5) fills in when it has nothing better: the
 * hostname without `www.`. Also the marker the m17 metadata fill looks for —
 * a row still carrying it has never had a real title, so Firecrawl's may
 * replace it (`bookmarkMetadata.ts`). Keep the two in one place so they
 * cannot drift apart.
 */
export function hostnameTitle(rawUrl: string): string {
	try {
		return new URL(rawUrl).hostname.replace(/^www\./, "");
	} catch {
		// Unparseable input still stores (normalizeUrl falls back to the
		// trimmed original) — it just gets no autofilled title. The route
		// rejects these before we get here; this is belt-and-braces.
		return "";
	}
}

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
	/**
	 * The pinned shelf (m13): ALL of the user's pinned rows, in their
	 * hand-arranged order — `pin_position asc, id desc` (m21; it was
	 * `pinned_at desc` until the order became the user's to set). Independent
	 * of the current view and of q/tags — the shelf is always fully visible.
	 * Pinned rows are always live (archiving unpins), so the archived view
	 * gets the same list; the client only renders it on the live feed.
	 */
	pinned: Bookmark[];
	/** Rows in the current view (user + archived state), ignoring q and tags. */
	total: number;
	/**
	 * Rows the LOG can reach — full count, not capped at PAGE_SIZE. Both
	 * branches include pinned rows since m22, so on a plain live feed (no q,
	 * no tags) this equals `total`; it only diverges once `q` or `tags`
	 * narrows the log.
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
 * `updated_at desc, id desc`, keyset-paginated 50/page. Pinned rows are in
 * the log like any others (m22) AND on the shelf.
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
	//   total    — view only; facets — view + q, IGNORING tags (an active tag
	//   keeps its count); matching — whatever the LOG query below can reach
	//   (view + q + tags; since m22 pinned rows are in the log on BOTH
	//   branches, so nothing is subtracted here either).
	//   pinned   — the shelf: every pinned row in its hand-arranged order
	//   (m21: pin_position asc, id desc), view/filter-independent (pinned rows
	//   are always live — archiving unpins). A pinned row therefore appears
	//   twice in a response: once in the log, once on the shelf.
	const [total, matching, facets, pinnedRows] = await Promise.all([
		countBookmarks(db, viewCond),
		countBookmarks(
			db,
			q ? and(viewCond, matchCond, tagsCond) : and(viewCond, tagsCond),
		),
		tagFacets(db, and(viewCond, matchCond)),
		db
			.select(BOOKMARK_COLUMNS)
			.from(bookmarks)
			.where(and(eq(bookmarks.userId, userId), isNotNull(bookmarks.pinnedAt)))
			.orderBy(asc(bookmarks.pinPosition), desc(bookmarks.id)),
	]);
	const aggregates = {
		total,
		matching,
		facets,
		pinned: await withHighlights(db, pinnedRows),
	};

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

	const rows = await db
		.insert(bookmarks)
		.values({
			userId,
			url: rawUrl,
			urlNormalized: normalizeUrl(rawUrl),
			title: hostnameTitle(rawUrl),
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

/**
 * The fields BOTH patch routes accept. `url` is deliberately NOT here: on
 * `PATCH /api/bookmarks/by-url` the URL is the row SELECTOR, never an edit
 * (SPEC §8, m22). `buildPatchSet` below likewise knows nothing about `url`,
 * so even a future field-passthrough cannot leak one into the by-url path.
 */
export type PatchBookmarkInput = {
	title?: string;
	tags?: string[];
	/** Trimmed server-side; empty-after-trim stores NULL (note removed). */
	note?: string;
	archived?: boolean;
	/**
	 * m13/m21: true pins an UNPINNED row — `pinned_at = now()` and
	 * `pin_position = max(the caller's positions) + 1`, i.e. the END of the
	 * shelf — and is a no-op on BOTH columns for an already-pinned row (it
	 * keeps its slot and its original `pinned_at`; m13 refreshed `pinned_at`
	 * to jump to the front, retired once the order became hand-arranged).
	 * false unpins, clearing both. Mutually exclusive with `archived`:
	 * archiving unpins, pinning unarchives (routes reject both-true).
	 */
	pinned?: boolean;
};

/**
 * `PATCH /api/bookmarks/:id` only (m22, SPEC §8): the ONE way to correct a
 * bookmark's URL. `url` is the new RAW URL — already trimmed and validated by
 * the route (parseable http(s), dotted hostname) — from which
 * `url_normalized` is recomputed here (Hard rule #3: one implementation).
 */
export type PatchBookmarkByIdInput = PatchBookmarkInput & {
	url?: string;
};

type PatchSet = {
	title?: string;
	tags?: string[];
	note?: string | null;
	archivedAt?: Date | null;
	url?: string;
	urlNormalized?: string;
	faviconUrl?: string | null;
	// The pin columns are SQL expressions on the pin path (m21): the new slot
	// is read from the caller's other rows inside the same UPDATE, so a pin
	// never becomes a read-then-write race.
	pinnedAt?: Date | SQL | null;
	pinPosition?: number | SQL | null;
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
		if (input.archived) {
			// Archiving unpins — the shelf only ever holds live rows. Both pin
			// columns go together (the CHECK: a slot exists iff pinned_at does).
			set.pinnedAt = null;
			set.pinPosition = null;
		}
	}
	if (input.pinned !== undefined) {
		if (input.pinned) {
			// Idempotent pin (m21): an already-pinned row keeps its pinned_at
			// AND its slot; an unpinned one is stamped now() and appended to
			// the END of the caller's shelf (max + 1, -1 + 1 = 0 for the first
			// pin). Expressed as SQL so it is one statement — no read-then-
			// write race, and the CHECK invariant holds on every path.
			set.pinnedAt = sql`coalesce(${bookmarks.pinnedAt}, now())`;
			set.pinPosition = sql`coalesce(${bookmarks.pinPosition}, (select coalesce(max(p.pin_position), -1) + 1 from ${bookmarks} p where p.user_id = ${bookmarks.userId} and p.pinned_at is not null))`;
			// Pinning unarchives — a pinned row is a live row. Routes reject
			// {archived: true, pinned: true}, so this never fights the branch
			// above.
			set.archivedAt = null;
		} else {
			set.pinnedAt = null;
			set.pinPosition = null;
		}
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
 * Thrown by `patchBookmark` when the edited URL normalizes onto ANOTHER of the
 * caller's rows (SPEC §8: `409 {error: "duplicate_url", conflict}`). Nothing
 * was written — never a silent merge, because reconciling two rows' tags,
 * highlights and pins has no right answer; the client shows the conflict.
 * `conflict` is the bare row that already owns the key (null only in the race
 * where it vanished between the failed UPDATE and the lookup).
 */
export class DuplicateUrlError extends Error {
	readonly conflict: BookmarkRow | null;

	constructor(conflict: BookmarkRow | null) {
		super("duplicate url");
		this.name = "DuplicateUrlError";
		this.conflict = conflict;
	}
}

/**
 * Postgres SQLSTATE 23505 (unique_violation). Drizzle wraps driver errors in a
 * `DrizzleQueryError` whose `cause` is the real pg error — identical for
 * postgres-js (prod) and PGlite (tests) — so walk the chain rather than
 * matching one wrapper's shape.
 */
function isUniqueViolation(err: unknown): boolean {
	let current: unknown = err;
	for (let depth = 0; current != null && depth < 5; depth++) {
		if (
			typeof current === "object" &&
			(current as { code?: unknown }).code === "23505"
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** `new URL(raw).host`, or null when the URL doesn't parse. */
function hostOf(raw: string): string | null {
	try {
		return new URL(raw).host;
	} catch {
		return null;
	}
}

/**
 * Updates ONLY the provided fields, scoped to `user_id` for ownership.
 * `archived: true` sets `archived_at = now()`; `false` clears it to null.
 * Never bumps `updated_at` (see `patchWhere`).
 *
 * `url` (m22, `:id` route only): replaces `url` and recomputes
 * `url_normalized`. When the new URL's HOST differs from the current row's —
 * an unparseable current URL counts as different — `favicon_url` is cleared
 * too: the stored icon belongs to the old site and the hostname-derived
 * fallback (SPEC §9) is instantly right. Title, tags, note, pins, highlights
 * and any article are untouched. A collision with another of the caller's
 * rows throws `DuplicateUrlError` and writes nothing.
 */
export async function patchBookmark(
	db: BookmarksDb,
	userId: string,
	id: number,
	input: PatchBookmarkByIdInput,
): Promise<BookmarkRow | null> {
	const cond = and(eq(bookmarks.id, id), eq(bookmarks.userId, userId));
	const { url, ...rest } = input;

	if (url === undefined) {
		return patchWhere(db, cond, rest);
	}

	const rawUrl = url.trim();
	const urlNormalized = normalizeUrl(rawUrl);

	try {
		// One transaction: the favicon decision needs the CURRENT row's host, so
		// the read and the write must see the same row version. Both statements
		// carry the ownership condition.
		return await db.transaction(async (tx) => {
			const [current] = await tx
				.select({ url: bookmarks.url })
				.from(bookmarks)
				.where(cond)
				.limit(1);
			if (!current) {
				return null;
			}

			const set: PatchSet = {
				...buildPatchSet(rest),
				url: rawUrl,
				urlNormalized,
			};
			const currentHost = hostOf(current.url);
			if (currentHost === null || currentHost !== hostOf(rawUrl)) {
				set.faviconUrl = null;
			}

			const rows = await tx
				.update(bookmarks)
				.set(set)
				.where(cond)
				.returning(BOOKMARK_COLUMNS);
			return rows[0] ?? null;
		});
	} catch (err) {
		if (!isUniqueViolation(err)) {
			throw err;
		}
		// The transaction rolled back, so this lookup runs on the outer
		// connection: fetch the row that already owns the key for the 409 body.
		const [conflict] = await db
			.select(BOOKMARK_COLUMNS)
			.from(bookmarks)
			.where(
				and(
					eq(bookmarks.userId, userId),
					eq(bookmarks.urlNormalized, urlNormalized),
				),
			)
			.limit(1);
		throw new DuplicateUrlError(conflict ?? null);
	}
}

/**
 * Rewrites the caller's pinned shelf order (m21, SPEC §8 —
 * `PUT /api/bookmarks/pinned`). `ids` is the shelf as the user arranged it.
 *
 * LENIENT by design, because the shelf can change under a drag (a popup pin
 * or unpin mid-gesture): ids that are not currently pinned, not the caller's,
 * or duplicated are silently ignored, and pinned rows MISSING from `ids` keep
 * their relative order and trail the listed ones. Nothing is created,
 * unpinned or archived here.
 *
 * The surviving rows get dense `pin_position = 0..k-1` in one statement
 * inside one transaction. CRITICAL (Hard rule #1): it never touches
 * `updated_at` — nor `pinned_at`, which records WHEN a row was pinned and is
 * not the order key any more.
 *
 * Returns the whole shelf in its new order, shaped exactly like the listing's
 * `pinned` (highlights nested), so a client can swap it in verbatim.
 */
export async function reorderPinned(
	db: BookmarksDb,
	userId: string,
	ids: number[],
): Promise<Bookmark[]> {
	return db.transaction(async (tx) => {
		const shelfCond = and(
			eq(bookmarks.userId, userId),
			isNotNull(bookmarks.pinnedAt),
		);

		// The shelf as it stands right now, in its current order.
		const current = await tx
			.select({ id: bookmarks.id })
			.from(bookmarks)
			.where(shelfCond)
			.orderBy(asc(bookmarks.pinPosition), desc(bookmarks.id));

		const pinnedIds = new Set(current.map((row) => row.id));
		const placed = new Set<number>();
		const ordered: number[] = [];
		// Requested order first (ignoring anything not on the shelf, and any
		// repeat of an id already placed)...
		for (const id of ids) {
			if (pinnedIds.has(id) && !placed.has(id)) {
				placed.add(id);
				ordered.push(id);
			}
		}
		// ...then whatever the caller did not list, in its prior relative order.
		for (const row of current) {
			if (!placed.has(row.id)) {
				placed.add(row.id);
				ordered.push(row.id);
			}
		}

		if (ordered.length > 0) {
			// One UPDATE joined against the id list with its ordinality — the
			// slot is the list index. Ownership AND pinned-ness are re-checked
			// in the WHERE: a popup unpin/archive that commits between the
			// SELECT above and this statement (READ COMMITTED re-evaluates the
			// predicate on the fresh row version) is then simply skipped —
			// the lenient race SPEC §8 promises — instead of assigning a slot
			// to an unpinned row and tripping the CHECK. `pin_position` is
			// the ONLY column assigned.
			const idList = sql.join(
				ordered.map((id) => sql`${id}`),
				sql`, `,
			);
			await tx.execute(sql`
				update ${bookmarks} as b
				set pin_position = v.ord - 1
				from unnest(array[${idList}]::bigint[]) with ordinality as v(id, ord)
				where b.id = v.id and b.user_id = ${userId} and b.pinned_at is not null
			`);
		}

		const rows = await tx
			.select(BOOKMARK_COLUMNS)
			.from(bookmarks)
			.where(shelfCond)
			.orderBy(asc(bookmarks.pinPosition), desc(bookmarks.id));

		return withHighlights(tx, rows);
	});
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
