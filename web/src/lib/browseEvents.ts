// Browse-event capture core — SPEC §13 (attention tracking) + §8
// (POST/GET /api/browse-events). Pure functions over an injected Drizzle db
// (PGlite-testable, same pattern as sync.ts / bookmarks.ts); callers (route
// handlers) own auth, this module owns validation + the queries.
//
// CRITICAL (Hard rule #1, SPEC §13): browse events are APPEND-ONLY telemetry
// COMPLETELY separate from bookmarks. Nothing in this module may read or
// write the bookmarks table — which is exactly why nothing in this feature
// can bump `bookmarks.updated_at`. Rows here are never updated or deleted
// either (retention is a future decision).
//
// Decisions not fully pinned down by SPEC (documented here per orchestrator
// instructions):
//   - `InvalidCursorError` is defined HERE rather than imported from
//     bookmarks.ts, so this module carries no reference to the bookmarks
//     module at all. Same shape, same route mapping (400 invalid_cursor).
//   - `q` matches when EITHER `url` OR `title` contains it (case-insensitive
//     substring). `%`/`_`/`\` in the user's text are escaped so they match
//     literally rather than acting as LIKE wildcards.
//   - An empty `kinds` array means "no kind filter" (same as omitting it).
//   - An empty `events` batch is valid and writes nothing: `{inserted: 0,
//     deduped: 0}`.
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
	BROWSE_EVENT_KINDS,
	type BrowseEventKind,
	browseEvents,
	IDLE_STATES,
	type IdleState,
} from "../db/schema";
import { normalizeUrl } from "./normalizeUrl";

// Accept any Drizzle Postgres database or transaction (postgres-js in prod,
// PGlite in tests) — same pattern as SyncDb (sync.ts) / BookmarksDb.
// biome-ignore lint/suspicious/noExplicitAny: variance of Drizzle's driver-specific generics requires it; the schema/relations generics are irrelevant here.
export type BrowseEventsDb = PgDatabase<PgQueryResultHKT, any, any>;

// ---------------------------------------------------------------------------
// Validation (SPEC §13 "Validation bounds")
// ---------------------------------------------------------------------------
//
// The bounds below exist so a malformed batch is a DETERMINISTIC 400: nothing
// that passes this schema may be able to raise a Postgres error, because that
// 5xx would make the extension's outbox halt-and-retry the same batch forever,
// wedging bookmark syncs behind it.

/** SPEC §8: max 500 events per batch. */
export const MAX_EVENTS_PER_BATCH = 500;

/**
 * Last millisecond of year 9999 — NOT the max representable JS Date. Anything
 * from year 10000 on serializes via `Date#toISOString()` into ISO expanded-year
 * form (`+010000-01-01T…`), which Postgres rejects: a value that passed Zod
 * would then die at INSERT as a 5xx, and the outbox would retry that batch
 * forever. This is deliberately TIGHTER than /api/sync's `dateAddedMs` bound
 * (SPEC §13 records the corrected number).
 */
const MAX_OCCURRED_AT_MS = 253_402_300_799_999;

/**
 * Whether a JS epoch-ms value round-trips through `toISOString()` into a
 * timestamp Postgres can parse — i.e. a real number inside `[0, year 9999]`.
 * Shared by the write bound and the cursor decoder.
 */
function isPgRepresentableMs(ms: number): boolean {
	return Number.isFinite(ms) && ms >= 0 && ms <= MAX_OCCURRED_AT_MS;
}

// Postgres `integer` range: anything outside it would be a DB error, not a 400.
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

const int32 = z.number().int().min(INT32_MIN).max(INT32_MAX);

/**
 * A free-text field bound for a Postgres `text` column: length-capped AND free
 * of NUL (`\u0000`), which `text` cannot store at all. A NUL that slipped past
 * Zod would raise "unsupported Unicode escape sequence" at INSERT — the same
 * retry-forever 5xx the rest of these bounds exist to prevent.
 */
function pgSafeText(max: number, min = 0) {
	return z
		.string()
		.min(min)
		.max(max)
		.refine((value) => !value.includes("\u0000"), {
			message: "must not contain a null byte",
		});
}

/**
 * The kind-dependent fields (SPEC §13 event table). Everything NOT listed for
 * a kind is rejected for that kind — "required" means present, and a field
 * that is neither required nor optional for the kind is forbidden.
 */
const KIND_FIELDS = {
	nav: {
		required: ["tabId", "url"],
		optional: ["windowId", "transition", "documentLifecycle"],
	},
	tab_activated: {
		required: ["tabId", "windowId"],
		optional: ["url", "title"],
	},
	window_focus: {
		required: ["windowId"],
		optional: ["tabId", "url", "title"],
	},
	window_blur: { required: [], optional: [] },
	idle: { required: ["idleState"], optional: [] },
	capture_start: { required: [], optional: [] },
	capture_stop: { required: [], optional: [] },
} as const satisfies Record<
	BrowseEventKind,
	{ required: readonly OptionalField[]; optional: readonly OptionalField[] }
>;

/** Every field whose presence depends on the kind. */
const OPTIONAL_FIELDS = [
	"url",
	"title",
	"tabId",
	"windowId",
	"idleState",
	"transition",
	"documentLifecycle",
] as const;

type OptionalField = (typeof OPTIONAL_FIELDS)[number];

const eventShape = z.strictObject({
	// Extension-minted idempotency key; UUID format so a junk value can't
	// become an unbounded text row.
	clientEventId: z.uuid(),
	// The capture session (SPEC §13) this event belongs to.
	bootId: z.uuid(),
	kind: z.enum(BROWSE_EVENT_KINDS),
	occurredAtMs: z.number().int().min(0).max(MAX_OCCURRED_AT_MS),
	url: pgSafeText(8192, 1).optional(),
	title: pgSafeText(4096).optional(),
	tabId: int32.optional(),
	windowId: int32.optional(),
	idleState: z.enum(IDLE_STATES).optional(),
	transition: pgSafeText(256).optional(),
	documentLifecycle: pgSafeText(64).optional(),
});

/**
 * One event as it arrives on the wire (SPEC §13). Post-validation shape —
 * `applyBrowseEvents` takes these verbatim.
 */
export type BrowseEventInput = z.infer<typeof eventShape>;

/** Per-kind required/forbidden enforcement (SPEC §13 table). */
const browseEventSchema = eventShape.superRefine((event, ctx) => {
	const spec = KIND_FIELDS[event.kind];
	for (const field of OPTIONAL_FIELDS) {
		const present = event[field] !== undefined;
		const required = (spec.required as readonly string[]).includes(field);
		const allowed =
			required || (spec.optional as readonly string[]).includes(field);

		if (required && !present) {
			ctx.addIssue({
				code: "custom",
				path: [field],
				message: `${field} is required for kind '${event.kind}'`,
			});
		} else if (present && !allowed) {
			ctx.addIssue({
				code: "custom",
				path: [field],
				message: `${field} is not allowed for kind '${event.kind}'`,
			});
		}
	}
});

/** POST /api/browse-events body (SPEC §8): strict at every level. */
export const browseEventsBodySchema = z.strictObject({
	events: z.array(browseEventSchema).max(MAX_EVENTS_PER_BATCH),
});

export type BrowseEventsBody = z.infer<typeof browseEventsBodySchema>;

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export type ApplyBrowseEventsResult = {
	/** Rows actually written. */
	inserted: number;
	/** Events the unique `(user_id, client_event_id)` already covered. */
	deduped: number;
};

/**
 * Append-only batch insert (SPEC §13 "Server semantics"): normalizes `url`
 * server-side into `url_normalized` (SPEC §4, the single implementation —
 * Hard rule #3) and inserts with `ON CONFLICT (user_id, client_event_id) DO
 * NOTHING`. At-least-once outbox delivery makes duplicate batches routine,
 * not errors, so a redelivery is a no-op that reports itself as `deduped`.
 * In-batch duplicate `clientEventId`s are handled by the same conflict clause.
 *
 * NEVER touches the bookmarks table (Hard rule #1 / SPEC §13).
 */
export async function applyBrowseEvents(
	db: BrowseEventsDb,
	userId: string,
	events: BrowseEventInput[],
): Promise<ApplyBrowseEventsResult> {
	if (events.length === 0) {
		return { inserted: 0, deduped: 0 };
	}

	const values = events.map((event) => ({
		userId,
		clientEventId: event.clientEventId,
		bootId: event.bootId,
		kind: event.kind,
		occurredAt: new Date(event.occurredAtMs),
		url: event.url ?? null,
		// null when the kind carries no url — nothing to normalize.
		urlNormalized: event.url === undefined ? null : normalizeUrl(event.url),
		title: event.title ?? null,
		tabId: event.tabId ?? null,
		windowId: event.windowId ?? null,
		idleState: event.idleState ?? null,
		transition: event.transition ?? null,
		documentLifecycle: event.documentLifecycle ?? null,
	}));

	const inserted = await db
		.insert(browseEvents)
		.values(values)
		.onConflictDoNothing({
			target: [browseEvents.userId, browseEvents.clientEventId],
		})
		.returning({ id: browseEvents.id });

	return {
		inserted: inserted.length,
		deduped: events.length - inserted.length,
	};
}

// ---------------------------------------------------------------------------
// Read path (the /events log view — SPEC §8/§9)
// ---------------------------------------------------------------------------

/** SPEC §8: 100 events per page. */
export const PAGE_SIZE = 100;

/** Thrown by `listBrowseEvents` when `cursor` isn't a value it produced. */
export class InvalidCursorError extends Error {
	constructor() {
		super("invalid cursor");
		this.name = "InvalidCursorError";
	}
}

type CursorPayload = { o: string; id: number };

/** Opaque base64url cursor over the log's keyset (`occurred_at`, `id`). */
function encodeCursor(occurredAt: Date, id: number): string {
	const payload: CursorPayload = { o: occurredAt.toISOString(), id };
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
		typeof (parsed as CursorPayload).o !== "string" ||
		typeof (parsed as CursorPayload).id !== "number" ||
		// Safe-integer (not just integer): a forged id like 1e19 would either
		// overflow int8 or serialize as "1e+19" — both Postgres errors that
		// would escape the InvalidCursorError → 400 mapping.
		!Number.isSafeInteger((parsed as CursorPayload).id) ||
		// NaN alone isn't enough: JS parses "+275760-09-13T00:00:00.000Z",
		// "-000001-01-01T00:00:00.000Z" and "0000" happily, then re-serializes
		// them into expanded-year ISO form that Postgres REJECTS — a forged
		// cursor would 500 the GET instead of 400ing. Bound it to the same
		// [0, year 9999] window the write path enforces (nothing outside it can
		// be in the table anyway).
		!isPgRepresentableMs(new Date((parsed as CursorPayload).o).getTime())
	) {
		throw new InvalidCursorError();
	}

	return parsed as CursorPayload;
}

/** One event as GET /api/browse-events serializes it (SPEC §8). */
export type BrowseEvent = {
	id: number;
	kind: BrowseEventKind;
	/** ISO-8601. */
	occurredAt: string;
	bootId: string;
	url: string | null;
	urlNormalized: string | null;
	title: string | null;
	tabId: number | null;
	windowId: number | null;
	idleState: IdleState | null;
	transition: string | null;
	documentLifecycle: string | null;
	/** ISO-8601 server receipt time. */
	createdAt: string;
};

export type ListBrowseEventsOptions = {
	/** Case-insensitive substring over `url` + `title`. Blank = no filter. */
	q?: string;
	/** Kind filter (OR within the set). Empty/absent = no filter. */
	kinds?: BrowseEventKind[];
	/** Opaque cursor from a previous `nextCursor`. */
	cursor?: string;
};

export type ListBrowseEventsResult = {
	events: BrowseEvent[];
	nextCursor: string | null;
	/** Full, uncapped count for the current filter (q + kinds). */
	total: number;
};

/**
 * Escapes LIKE metacharacters so the user's filter text matches literally.
 * Backslash first, or it would double-escape the escapes we add after it.
 * Postgres' default LIKE escape character is `\`, and the pattern travels as
 * a bound parameter, so no ESCAPE clause is needed.
 */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * The log view's page (SPEC §8/§9): this user's events ordered
 * `occurred_at desc, id desc`, keyset-paginated 100/page, optionally filtered
 * by `q` (case-insensitive substring over `url` OR `title`) and `kinds`.
 * `total` is the full uncapped count under the SAME filter, recomputed each
 * request.
 */
export async function listBrowseEvents(
	db: BrowseEventsDb,
	userId: string,
	options: ListBrowseEventsOptions = {},
): Promise<ListBrowseEventsResult> {
	// Decode up front so a malformed cursor throws before any query runs.
	const cursor = options.cursor ? decodeCursor(options.cursor) : null;

	const q = options.q?.trim();
	const conditions: (SQL | undefined)[] = [eq(browseEvents.userId, userId)];

	if (q) {
		const like = `%${escapeLike(q)}%`;
		conditions.push(
			or(
				sql`${browseEvents.url} ILIKE ${like}`,
				sql`${browseEvents.title} ILIKE ${like}`,
			),
		);
	}

	if (options.kinds?.length) {
		conditions.push(inArray(browseEvents.kind, options.kinds));
	}

	const filterCond = and(...conditions);

	const pageConditions = [filterCond];
	if (cursor) {
		// Keyset pagination: strictly "after" the cursor row in the
		// (occurred_at desc, id desc) ordering — row-comparison is
		// lexicographic, which matches that ordering exactly (and so handles
		// ties on occurred_at via the id half). The params MUST be cast
		// explicitly: raw sql`` params are sent untyped, and postgres-js
		// stringifies a Date param into a form Postgres can't parse inside a
		// row constructor. Round-tripping through new Date(...).toISOString()
		// normalizes forged-but-JS-parseable `o` values into a form Postgres
		// is guaranteed to accept.
		pageConditions.push(
			sql`(${browseEvents.occurredAt}, ${browseEvents.id}) < (${new Date(cursor.o).toISOString()}::timestamptz, ${cursor.id}::bigint)`,
		);
	}

	const [rows, totalRows] = await Promise.all([
		db
			.select()
			.from(browseEvents)
			.where(and(...pageConditions))
			.orderBy(desc(browseEvents.occurredAt), desc(browseEvents.id))
			.limit(PAGE_SIZE + 1),
		db
			.select({ count: sql<number>`count(*)::int` })
			.from(browseEvents)
			.where(filterCond),
	]);

	const hasMore = rows.length > PAGE_SIZE;
	const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
	const last = page.at(-1);

	return {
		events: page.map((row) => ({
			id: row.id,
			// Only validated kinds are ever written (browseEventsBodySchema).
			kind: row.kind as BrowseEventKind,
			occurredAt: row.occurredAt.toISOString(),
			bootId: row.bootId,
			url: row.url,
			urlNormalized: row.urlNormalized,
			title: row.title,
			tabId: row.tabId,
			windowId: row.windowId,
			idleState: row.idleState as IdleState | null,
			transition: row.transition,
			documentLifecycle: row.documentLifecycle,
			createdAt: row.createdAt.toISOString(),
		})),
		nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.id) : null,
		total: totalRows[0]?.count ?? 0,
	};
}
