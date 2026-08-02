// Sync upsert semantics — SPEC §5. This is the ONLY write path for bookmark
// rows coming from the extension, and `live` mode is the ONLY code path
// anywhere that bumps `updated_at` (AGENTS.md Hard rule #1).
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { bookmarks } from "../db/schema";
import { normalizeUrl } from "./normalizeUrl";

/** Incoming bookmark shape from the extension (SPEC §8). URLs are RAW. */
export type SyncBookmark = {
	url: string;
	title: string;
	chromeId: string;
	dateAddedMs?: number;
	folderPath?: string;
};

export type SyncMode = "live" | "backfill";

export type SyncResult = {
	/** New rows created. */
	inserted: number;
	/** Live-mode conflicts that updated an existing row. */
	bumped: number;
	/** Backfill-mode conflicts (including in-batch duplicates) that did nothing. */
	skipped: number;
};

// Accept any Drizzle Postgres database or transaction (postgres-js in prod,
// PGlite in tests). Transactions extend PgDatabase, so they're covered too.
// biome-ignore lint/suspicious/noExplicitAny: variance of Drizzle's driver-specific generics requires it; the schema/relations generics are irrelevant here.
export type SyncDb = PgDatabase<PgQueryResultHKT, any, any>;

// Chrome's DEFAULT root containers (English names — a localized Chrome would
// send translated names and get tagged; acceptable for this deployment).
// Matched by NAME, not structure: a user's own top-level folder must still
// become a tag, so a bare single-segment path is only untagged when it is
// exactly one of these.
const DEFAULT_ROOT_CONTAINERS = new Set([
	"Bookmarks Bar",
	"Other Bookmarks",
	"Mobile Bookmarks",
]);

/**
 * Derives insert-time tags from the extension's full `/`-joined folder path
 * (SPEC §5): the LEAFMOST folder name only — except a bookmark sitting
 * directly in a default root container (single-segment path matching
 * DEFAULT_ROOT_CONTAINERS) gets no tag at all.
 */
export function folderTags(folderPath: string | undefined): string[] {
	if (folderPath == null || folderPath === "") {
		return [];
	}
	const segments = folderPath.split("/");
	if (segments.length === 1 && DEFAULT_ROOT_CONTAINERS.has(folderPath)) {
		return [];
	}
	const leaf = segments.at(-1);
	return leaf ? [leaf] : [];
}

export async function applySync(
	db: SyncDb,
	userId: string,
	mode: SyncMode,
	batch: SyncBookmark[],
): Promise<SyncResult> {
	if (batch.length === 0) {
		return { inserted: 0, bumped: 0, skipped: 0 };
	}

	const now = new Date();

	// Dedupe the batch by url_normalized BEFORE inserting: a single multi-row
	// INSERT ... ON CONFLICT fails with "cannot affect row a second time" if
	// two rows share the conflict key.
	//   - live: keep the LAST occurrence — the latest event wins, matching
	//     what sequential single-event upserts would have produced.
	//   - backfill: keep the FIRST occurrence — the earliest-listed entry is
	//     closest to the original "first save", and backfill must never
	//     overwrite, so later duplicates are skips.
	const byKey = new Map<string, SyncBookmark>();
	for (const b of batch) {
		const key = normalizeUrl(b.url);
		if (mode === "live" || !byKey.has(key)) {
			byKey.set(key, b);
		}
	}

	const values = [...byKey.entries()].map(([urlNormalized, b]) => {
		// SPEC §5: created_at = updated_at = Chrome's dateAdded when available,
		// else now. (`!= null` rather than truthiness so an explicit 0 — the
		// epoch — is honored as sent.)
		const createdAt = b.dateAddedMs != null ? new Date(b.dateAddedMs) : now;
		return {
			userId,
			url: b.url,
			urlNormalized,
			title: b.title,
			chromeId: b.chromeId,
			// First element = leafmost folder name at insert (none for default
			// root containers); site-owned afterwards.
			tags: folderTags(b.folderPath),
			createdAt,
			updatedAt: createdAt,
		};
	});

	const conflictTarget = [bookmarks.userId, bookmarks.urlNormalized];

	if (mode === "backfill") {
		// Backfill NEVER touches existing rows: no bump, no unarchive, no
		// title/tags overwrite (Hard rule #1). ON CONFLICT DO NOTHING returns
		// only actually-inserted rows, so counts fall out of RETURNING.
		const returned = await db
			.insert(bookmarks)
			.values(values)
			.onConflictDoNothing({ target: conflictTarget })
			.returning({ id: bookmarks.id });

		const inserted = returned.length;
		// In-batch duplicates (dropped by the dedupe above) count as skipped
		// too, hence batch.length (raw input size), not values.length.
		return { inserted, bumped: 0, skipped: batch.length - inserted };
	}

	// live: upsert. On conflict (re-save): bump updated_at, unarchive,
	// overwrite title + chrome_id, and refresh `url` to the newest raw form
	// (the normalized key matched, so this is the same page; keeping the
	// latest raw spelling is consistent with overwriting title). tags and
	// created_at are NOT touched — site-owned after insert / first-save time.
	const returned = await db
		.insert(bookmarks)
		.values(values)
		.onConflictDoUpdate({
			target: conflictTarget,
			set: {
				updatedAt: sql`now()`,
				archivedAt: null,
				title: sql`excluded.title`,
				chromeId: sql`excluded.chrome_id`,
				url: sql`excluded.url`,
			},
		})
		// xmax = 0 distinguishes a fresh insert from a conflict-update: an
		// updated row carries the deleting/locking transaction id of the old
		// version in xmax, a brand-new row has xmax = 0.
		.returning({ wasInserted: sql<boolean>`(xmax = 0)` });

	const inserted = returned.filter((r) => r.wasInserted).length;
	// In-batch duplicates collapsed into one upsert row are counted as part
	// of that single result (not separately), so bumped + inserted may be
	// less than the raw batch size.
	return { inserted, bumped: returned.length - inserted, skipped: 0 };
}
