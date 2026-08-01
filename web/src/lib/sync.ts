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
			// First element = Chrome folder path at insert; site-owned afterwards.
			tags: b.folderPath != null ? [b.folderPath] : [],
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
