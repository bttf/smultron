// Page snapshots (m25, SPEC §17) — the database half.
//
// Pure functions over an injected Drizzle db (PGlite-testable, same pattern
// as bookmarks.ts). Storage calls (signed upload/read URLs, the complete
// check's listing, deletes) live in the routes, so everything here runs
// offline against the real migrations.
//
// CRITICAL (Hard rule #1): `createSnapshot` is a LIVE CAPTURE of the page's
// bookmark — insert, or bump `updated_at` + unarchive + fill `favicon_url`
// when null, and NOTHING else on conflict (title, tags, url, pins, note,
// screenshot untouched). No other function here writes the bookmarks table.
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { bookmarks, type SnapshotStatus, snapshots } from "../db/schema";
import type { BookmarksDb } from "./bookmarks";
import { validFaviconUrl } from "./firecrawl";
import { normalizeUrl } from "./normalizeUrl";

export const SNAPSHOT_ASSET_KINDS = ["screenshot", "html", "data"] as const;
export type SnapshotAssetKind = (typeof SNAPSHOT_ASSET_KINDS)[number];

/** At most 64 assets per snapshot (SPEC §17.4). */
export const SNAPSHOT_MAX_ASSETS = 64;
/** Markdown cap (SPEC §17.8) — keeps the manifest under Vercel's 4.5 MB. */
export const SNAPSHOT_MAX_MARKDOWN_CHARS = 1_000_000;
/** `metadata` cap, measured as serialized UTF-8 JSON (SPEC §17.8). */
export const SNAPSHOT_MAX_METADATA_BYTES = 512 * 1024;
/** Matches the bucket's `file_size_limit` (SPEC §17.3). */
export const SNAPSHOT_MAX_ASSET_BYTES = 50 * 1024 * 1024;

/** The mime types each asset kind may carry (SPEC §17.3/§17.4). */
const MIME_BY_KIND: Record<SnapshotAssetKind, readonly string[]> = {
	screenshot: ["image/webp", "image/jpeg"],
	html: ["text/html"],
	data: ["application/json"],
};

/** One stored asset (SPEC §17.4). `path` is server-assigned. */
export type SnapshotAsset = {
	kind: SnapshotAssetKind;
	idx: number;
	path: string;
	mime: string;
	byteSize: number;
	width?: number;
	height?: number;
};

/** SPEC §17.8. */
export type SnapshotSummary = {
	id: number;
	bookmarkId: number;
	url: string;
	title: string;
	adapterId: string;
	adapterVersion: string;
	status: SnapshotStatus;
	capturedAt: Date;
	createdAt: Date;
	markdownChars: number;
	screenshotCount: number;
};

/** `GET /api/snapshots/:id` before the routes attach signed URLs. */
export type SnapshotDetail = SnapshotSummary & {
	markdown: string;
	metadata: Record<string, unknown>;
	assets: SnapshotAsset[];
};

function isHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Postgres `text` and `jsonb` reject U+0000. A page can carry one (a stray
 * NUL in a meta tag or the extracted text), and a deterministic 500 on that
 * page would be worse than dropping an invisible character, so it is stripped
 * from every string — object keys included — before the insert.
 */
function stripNul(value: string): string {
	return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
}

function stripNulDeep(value: unknown): unknown {
	if (typeof value === "string") {
		return stripNul(value);
	}
	if (Array.isArray(value)) {
		return value.map(stripNulDeep);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				stripNul(key),
				stripNulDeep(entry),
			]),
		);
	}
	return value;
}

const assetInputSchema = z.strictObject({
	kind: z.enum(SNAPSHOT_ASSET_KINDS),
	idx: z
		.number()
		.int()
		.min(0)
		.max(SNAPSHOT_MAX_ASSETS - 1),
	mime: z.string(),
	byteSize: z.number().int().min(0).max(SNAPSHOT_MAX_ASSET_BYTES),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
});

/**
 * `POST /api/snapshots` body (SPEC §17.8). Strict at every level except
 * `metadata`, which is validated as a JSON object of bounded serialized size,
 * not field by field. Lives here, beside the semantics it feeds, like
 * `syncBodySchema`.
 */
export const createSnapshotBodySchema = z
	.strictObject({
		url: z
			.string()
			.min(1)
			.max(2048)
			.refine(isHttpUrl, "url must be an absolute http(s) URL"),
		title: z.string().max(1000).transform(stripNul),
		// Raw tab favIconUrl. Validated by `validFaviconUrl` (the RED-205 rule,
		// one implementation): a junk icon degrades to null, never a 400.
		faviconUrl: z.string().optional(),
		adapterId: z.string().min(1).max(200),
		adapterVersion: z.string().min(1).max(200),
		markdown: z.string().max(SNAPSHOT_MAX_MARKDOWN_CHARS).transform(stripNul),
		metadata: z
			.record(z.string(), z.unknown())
			.refine(
				(value) =>
					Buffer.byteLength(JSON.stringify(value), "utf8") <=
					SNAPSHOT_MAX_METADATA_BYTES,
				`metadata must serialize to at most ${SNAPSHOT_MAX_METADATA_BYTES} bytes`,
			)
			.transform((value) => stripNulDeep(value) as Record<string, unknown>),
		capturedAt: z.iso.datetime({ offset: true }),
		assets: z.array(assetInputSchema).max(SNAPSHOT_MAX_ASSETS),
	})
	.superRefine((body, ctx) => {
		const seen = new Set<string>();
		body.assets.forEach((asset, i) => {
			if (!MIME_BY_KIND[asset.kind].includes(asset.mime)) {
				ctx.addIssue({
					code: "custom",
					path: ["assets", i, "mime"],
					message: `${asset.kind} assets must be ${MIME_BY_KIND[asset.kind].join(" or ")}`,
				});
			}
			if (asset.kind !== "screenshot") {
				if (asset.idx !== 0) {
					ctx.addIssue({
						code: "custom",
						path: ["assets", i, "idx"],
						message: `${asset.kind} assets must have idx 0`,
					});
				}
				if (asset.width !== undefined || asset.height !== undefined) {
					ctx.addIssue({
						code: "custom",
						path: ["assets", i],
						message: "width/height are for screenshots only",
					});
				}
			}
			// Two assets with the same kind+idx would share an object path.
			const key = `${asset.kind}:${asset.idx}`;
			if (seen.has(key)) {
				ctx.addIssue({
					code: "custom",
					path: ["assets", i],
					message: `duplicate ${asset.kind} asset idx ${asset.idx}`,
				});
			}
			seen.add(key);
		});
	});

export type CreateSnapshotInput = z.output<typeof createSnapshotBodySchema>;

/**
 * The object name of one asset within its snapshot's folder (SPEC §17.3):
 * `screenshot-<idx>.webp` (`.jpg` for JPEG), `page.html`, `data.json`.
 */
export function snapshotAssetName(
	kind: SnapshotAssetKind,
	idx: number,
	mime: string,
): string {
	switch (kind) {
		case "screenshot":
			return `screenshot-${idx}.${mime === "image/jpeg" ? "jpg" : "webp"}`;
		case "html":
			return "page.html";
		case "data":
			return "data.json";
	}
}

/** `<userId>/<snapshotId>` — the folder every asset of a snapshot lives in. */
export function snapshotFolder(userId: string, snapshotId: number): string {
	return `${userId}/${snapshotId}`;
}

/** Screenshots top to bottom, then the HTML, then the adapter data. */
const KIND_ORDER: Record<SnapshotAssetKind, number> = {
	screenshot: 0,
	html: 1,
	data: 2,
};

/**
 * The summary columns (SPEC §17.8). `markdownChars` and `screenshotCount` are
 * derived in SQL so a listing never ships the markdown itself. The column
 * references inside the derived expressions stay unambiguous in an
 * `UPDATE ... RETURNING` too, where Drizzle renders them unqualified.
 */
function SUMMARY_COLUMNS() {
	return {
		id: snapshots.id,
		bookmarkId: snapshots.bookmarkId,
		url: snapshots.url,
		title: snapshots.title,
		adapterId: snapshots.adapterId,
		adapterVersion: snapshots.adapterVersion,
		status: snapshots.status,
		capturedAt: snapshots.capturedAt,
		createdAt: snapshots.createdAt,
		markdownChars: sql<number>`char_length(${snapshots.markdown})::int`,
		screenshotCount: sql<number>`(select count(*)::int from jsonb_array_elements(${snapshots.assets}) as snapshot_asset(elem) where snapshot_asset.elem->>'kind' = 'screenshot')`,
	};
}

type SummaryRow = Omit<SnapshotSummary, "status"> & { status: string };

function toSummary(row: SummaryRow): SnapshotSummary {
	return {
		...row,
		// Plain text in the DB; anything unrecognized reads as not complete.
		status: row.status === "complete" ? "complete" : "uploading",
	};
}

/**
 * Creates a snapshot row (SPEC §17.8), in ONE transaction:
 *
 * 1. The bookmark upsert on `(user_id, url_normalized)` as a LIVE CAPTURE:
 *    insert with `created_at = updated_at = now()`, the body's title, no
 *    tags, no `chrome_id`, the validated favicon; on conflict
 *    `updated_at = now()`, `archived_at = null`,
 *    `favicon_url = coalesce(bookmarks.favicon_url, excluded.favicon_url)` —
 *    and nothing else.
 * 2. The snapshot insert with `status = 'uploading'`, then its asset paths
 *    (they embed the snapshot id, so they are written once the id exists).
 *
 * Returns the summary plus the assets with their server-assigned paths; the
 * route mints one signed upload URL per asset after the commit.
 */
export async function createSnapshot(
	db: BookmarksDb,
	userId: string,
	input: CreateSnapshotInput,
): Promise<{ snapshot: SnapshotSummary; assets: SnapshotAsset[] }> {
	return db.transaction(async (tx) => {
		const now = new Date();

		const [bookmark] = await tx
			.insert(bookmarks)
			.values({
				userId,
				url: input.url,
				urlNormalized: normalizeUrl(input.url),
				title: input.title,
				tags: [],
				faviconUrl: validFaviconUrl(input.faviconUrl ?? null),
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [bookmarks.userId, bookmarks.urlNormalized],
				set: {
					updatedAt: sql`now()`,
					archivedAt: null,
					faviconUrl: sql`coalesce(bookmarks.favicon_url, excluded.favicon_url)`,
				},
			})
			.returning({ id: bookmarks.id });

		const [inserted] = await tx
			.insert(snapshots)
			.values({
				userId,
				bookmarkId: bookmark.id,
				url: input.url,
				title: input.title,
				adapterId: input.adapterId,
				adapterVersion: input.adapterVersion,
				markdown: input.markdown,
				metadata: input.metadata,
				assets: [],
				status: "uploading",
				capturedAt: new Date(input.capturedAt),
				// Set here rather than by the column default so it carries
				// millisecond precision, which the ISO keyset cursor below
				// round-trips exactly (Postgres `now()` has microseconds).
				createdAt: now,
			})
			.returning({ id: snapshots.id });

		const folder = snapshotFolder(userId, inserted.id);
		const assets: SnapshotAsset[] = [...input.assets]
			.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.idx - b.idx)
			.map((asset) => ({
				kind: asset.kind,
				idx: asset.idx,
				path: `${folder}/${snapshotAssetName(asset.kind, asset.idx, asset.mime)}`,
				mime: asset.mime,
				byteSize: asset.byteSize,
				...(asset.width !== undefined ? { width: asset.width } : {}),
				...(asset.height !== undefined ? { height: asset.height } : {}),
			}));

		const [row] = await tx
			.update(snapshots)
			.set({ assets })
			.where(eq(snapshots.id, inserted.id))
			.returning(SUMMARY_COLUMNS());

		return { snapshot: toSummary(row), assets };
	});
}

/** Thrown by `listSnapshots` when `cursor` isn't a value it produced. */
export class InvalidSnapshotCursorError extends Error {
	constructor() {
		super("invalid cursor");
		this.name = "InvalidSnapshotCursorError";
	}
}

type CursorPayload = { c: string; id: number };

/** Opaque base64url keyset over (`created_at`, `id`), like the feed's. */
function encodeCursor(createdAt: Date, id: number): string {
	const payload: CursorPayload = { c: createdAt.toISOString(), id };
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		throw new InvalidSnapshotCursorError();
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as CursorPayload).c !== "string" ||
		typeof (parsed as CursorPayload).id !== "number" ||
		!Number.isSafeInteger((parsed as CursorPayload).id) ||
		Number.isNaN(new Date((parsed as CursorPayload).c).getTime())
	) {
		throw new InvalidSnapshotCursorError();
	}
	return parsed as CursorPayload;
}

export const SNAPSHOT_PAGE_DEFAULT = 20;
export const SNAPSHOT_PAGE_MAX = 100;

/**
 * The caller's snapshots, `created_at desc, id desc`, keyset-paginated
 * (SPEC §8 `GET /api/snapshots`). `bookmarkId` narrows to one bookmark.
 */
export async function listSnapshots(
	db: BookmarksDb,
	userId: string,
	options: { bookmarkId?: number; limit?: number; cursor?: string } = {},
): Promise<{ snapshots: SnapshotSummary[]; nextCursor: string | null }> {
	const limit = options.limit ?? SNAPSHOT_PAGE_DEFAULT;
	const cursor = options.cursor ? decodeCursor(options.cursor) : null;

	const conditions: Array<SQL | undefined> = [eq(snapshots.userId, userId)];
	if (options.bookmarkId !== undefined) {
		conditions.push(eq(snapshots.bookmarkId, options.bookmarkId));
	}
	if (cursor) {
		// Same explicit casts as the feed's keyset (bookmarks.ts): untyped
		// params inside a row constructor break under postgres-js.
		conditions.push(
			sql`(${snapshots.createdAt}, ${snapshots.id}) < (${new Date(cursor.c).toISOString()}::timestamptz, ${cursor.id}::bigint)`,
		);
	}

	const rows = await db
		.select(SUMMARY_COLUMNS())
		.from(snapshots)
		.where(and(...conditions))
		.orderBy(desc(snapshots.createdAt), desc(snapshots.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page.at(-1);
	return {
		snapshots: page.map(toSummary),
		nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
	};
}

/** The full snapshot, user-scoped; null for an unknown or another user's id. */
export async function getSnapshot(
	db: BookmarksDb,
	userId: string,
	id: number,
): Promise<SnapshotDetail | null> {
	const [row] = await db
		.select({
			...SUMMARY_COLUMNS(),
			markdown: snapshots.markdown,
			metadata: snapshots.metadata,
			assets: snapshots.assets,
		})
		.from(snapshots)
		.where(and(eq(snapshots.id, id), eq(snapshots.userId, userId)))
		.limit(1);
	if (!row) {
		return null;
	}
	const { markdown, metadata, assets, ...summary } = row;
	return {
		...toSummary(summary),
		markdown,
		metadata: (metadata ?? {}) as Record<string, unknown>,
		assets: (Array.isArray(assets) ? assets : []) as SnapshotAsset[],
	};
}

/**
 * Flips an `uploading` row to `complete` (SPEC §17.8). The route has already
 * confirmed every asset object is in Storage. Idempotent: a row that is
 * already complete is returned as is. Null when the row is not the caller's.
 */
export async function markSnapshotComplete(
	db: BookmarksDb,
	userId: string,
	id: number,
): Promise<SnapshotSummary | null> {
	const cond = and(eq(snapshots.id, id), eq(snapshots.userId, userId));
	await db
		.update(snapshots)
		.set({ status: "complete" })
		.where(and(cond, eq(snapshots.status, "uploading")));
	const [row] = await db
		.select(SUMMARY_COLUMNS())
		.from(snapshots)
		.where(cond)
		.limit(1);
	return row ? toSummary(row) : null;
}

/**
 * Hard-deletes the caller's snapshot row (SPEC §17.3). The route removes the
 * Storage objects first, best-effort. Returns whether a row was deleted.
 */
export async function deleteSnapshot(
	db: BookmarksDb,
	userId: string,
	id: number,
): Promise<boolean> {
	const rows = await db
		.delete(snapshots)
		.where(and(eq(snapshots.id, id), eq(snapshots.userId, userId)))
		.returning({ id: snapshots.id });
	return rows.length > 0;
}
