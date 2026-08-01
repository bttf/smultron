// applySync tests against REAL Postgres semantics: an in-memory PGlite
// database with the production migrations from web/drizzle/ applied in
// journal order, plus a stubbed auth.users (Supabase-managed in prod).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { bookmarks } from "../db/schema";
import { applySync } from "./sync";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

// A fixed past instant for dateAddedMs so "bump moves updated_at" is
// unambiguous.
const PAST = new Date("2024-01-15T12:00:00.000Z");

const drizzleDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../drizzle",
);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
	client = new PGlite({ extensions: { pg_trgm } });

	// Stub the Supabase-managed auth schema the FK migrations reference.
	await client.exec(
		"CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);",
	);

	// Apply the real production migrations in journal order.
	const journal = JSON.parse(
		readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"),
	) as { entries: Array<{ tag: string }> };
	for (const entry of journal.entries) {
		const migration = readFileSync(
			join(drizzleDir, `${entry.tag}.sql`),
			"utf8",
		);
		for (const statement of migration.split("--> statement-breakpoint")) {
			await client.exec(statement);
		}
	}

	await client.exec(
		`INSERT INTO auth.users (id) VALUES ('${USER_A}'), ('${USER_B}');`,
	);

	db = drizzle(client, { schema });
});

afterAll(async () => {
	await client.close();
});

beforeEach(async () => {
	await db.execute(sql`DELETE FROM smultron.bookmarks`);
});

async function allRows(userId?: string) {
	const rows = userId
		? await db.select().from(bookmarks).where(eq(bookmarks.userId, userId))
		: await db.select().from(bookmarks);
	return rows.sort((a, b) => a.id - b.id);
}

function expectRecent(d: Date) {
	expect(Math.abs(d.getTime() - Date.now())).toBeLessThan(10_000);
}

describe("applySync", () => {
	it("empty batch returns zeros without touching the DB", async () => {
		const result = await applySync(db, USER_A, "live", []);
		expect(result).toEqual({ inserted: 0, bumped: 0, skipped: 0 });
		expect(await allRows()).toHaveLength(0);

		const backfill = await applySync(db, USER_A, "backfill", []);
		expect(backfill).toEqual({ inserted: 0, bumped: 0, skipped: 0 });
	});

	describe("live insert", () => {
		it("inserts with dateAddedMs and folderPath", async () => {
			const result = await applySync(db, USER_A, "live", [
				{
					url: "https://Example.com/Page/?utm_source=nl&x=1#frag",
					title: "A page",
					chromeId: "c1",
					dateAddedMs: PAST.getTime(),
					folderPath: "Bookmarks Bar/Dev",
				},
			]);
			expect(result).toEqual({ inserted: 1, bumped: 0, skipped: 0 });

			const [row] = await allRows();
			expect(row.userId).toBe(USER_A);
			// Raw URL stored untouched; normalized computed server-side.
			expect(row.url).toBe("https://Example.com/Page/?utm_source=nl&x=1#frag");
			expect(row.urlNormalized).toBe("https://example.com/Page?x=1");
			expect(row.title).toBe("A page");
			expect(row.chromeId).toBe("c1");
			expect(row.tags).toEqual(["Bookmarks Bar/Dev"]);
			expect(row.createdAt).toEqual(PAST);
			expect(row.updatedAt).toEqual(PAST);
			expect(row.archivedAt).toBeNull();
		});

		it("inserts with created_at = updated_at = now when dateAddedMs absent", async () => {
			await applySync(db, USER_A, "live", [
				{ url: "https://a.com/x", title: "t", chromeId: "c1" },
			]);
			const [row] = await allRows();
			expectRecent(row.createdAt);
			expect(row.updatedAt).toEqual(row.createdAt);
		});

		it("inserts with empty tags when folderPath absent", async () => {
			await applySync(db, USER_A, "live", [
				{ url: "https://a.com/x", title: "t", chromeId: "c1" },
			]);
			const [row] = await allRows();
			expect(row.tags).toEqual([]);
		});

		it("allows empty titles (Chrome allows them)", async () => {
			const result = await applySync(db, USER_A, "live", [
				{ url: "https://a.com/x", title: "", chromeId: "c1" },
			]);
			expect(result).toEqual({ inserted: 1, bumped: 0, skipped: 0 });
			const [row] = await allRows();
			expect(row.title).toBe("");
		});
	});

	describe("live re-save (conflict)", () => {
		it("bumps updated_at, overwrites title/chrome_id/url, does NOT touch tags or created_at", async () => {
			await applySync(db, USER_A, "live", [
				{
					url: "https://a.com/x/",
					title: "old title",
					chromeId: "c1",
					dateAddedMs: PAST.getTime(),
					folderPath: "Bar/Old",
				},
			]);
			const [before] = await allRows();

			const result = await applySync(db, USER_A, "live", [
				{
					url: "https://A.com/x?utm_source=z", // same normalized key
					title: "new title",
					chromeId: "c2",
					dateAddedMs: PAST.getTime(),
					folderPath: "Bar/New",
				},
			]);
			expect(result).toEqual({ inserted: 0, bumped: 1, skipped: 0 });

			const [after] = await allRows();
			expect(after.id).toBe(before.id);
			expect(after.title).toBe("new title");
			expect(after.chromeId).toBe("c2");
			// url refreshed to the newest raw form.
			expect(after.url).toBe("https://A.com/x?utm_source=z");
			expect(after.urlNormalized).toBe("https://a.com/x");
			// Site-owned after insert: tags and created_at untouched.
			expect(after.tags).toEqual(["Bar/Old"]);
			expect(after.createdAt).toEqual(PAST);
			// updated_at bumped to now, NOT to the event's dateAdded.
			expectRecent(after.updatedAt);
			expect(after.updatedAt.getTime()).toBeGreaterThan(
				before.updatedAt.getTime(),
			);
		});

		it("unarchives an archived row", async () => {
			await applySync(db, USER_A, "live", [
				{
					url: "https://a.com/x",
					title: "t",
					chromeId: "c1",
					dateAddedMs: PAST.getTime(),
				},
			]);
			await db
				.update(bookmarks)
				.set({ archivedAt: new Date() })
				.where(eq(bookmarks.userId, USER_A));

			const result = await applySync(db, USER_A, "live", [
				{ url: "https://a.com/x", title: "t2", chromeId: "c1" },
			]);
			expect(result).toEqual({ inserted: 0, bumped: 1, skipped: 0 });

			const [row] = await allRows();
			expect(row.archivedAt).toBeNull();
		});

		it("counts mixed batches (one new, one existing)", async () => {
			await applySync(db, USER_A, "live", [
				{ url: "https://a.com/x", title: "t", chromeId: "c1" },
			]);
			const result = await applySync(db, USER_A, "live", [
				{ url: "https://a.com/x", title: "t2", chromeId: "c1" },
				{ url: "https://b.com/y", title: "u", chromeId: "c2" },
			]);
			expect(result).toEqual({ inserted: 1, bumped: 1, skipped: 0 });
			expect(await allRows()).toHaveLength(2);
		});
	});

	describe("backfill", () => {
		it("inserts with created_at = updated_at = dateAdded", async () => {
			const result = await applySync(db, USER_A, "backfill", [
				{
					url: "https://a.com/x",
					title: "t",
					chromeId: "c1",
					dateAddedMs: PAST.getTime(),
					folderPath: "Bar/Dev",
				},
			]);
			expect(result).toEqual({ inserted: 1, bumped: 0, skipped: 0 });

			const [row] = await allRows();
			expect(row.createdAt).toEqual(PAST);
			expect(row.updatedAt).toEqual(PAST);
			expect(row.tags).toEqual(["Bar/Dev"]);
			expect(row.archivedAt).toBeNull();
		});

		it("inserts with now when dateAdded absent", async () => {
			await applySync(db, USER_A, "backfill", [
				{ url: "https://a.com/x", title: "t", chromeId: "c1" },
			]);
			const [row] = await allRows();
			expectRecent(row.createdAt);
			expect(row.updatedAt).toEqual(row.createdAt);
		});

		it("conflict leaves the existing row COMPLETELY unchanged", async () => {
			await applySync(db, USER_A, "live", [
				{
					url: "https://a.com/x/",
					title: "site-edited title",
					chromeId: "c1",
					dateAddedMs: PAST.getTime(),
					folderPath: "Bar/Original",
				},
			]);
			const [before] = await allRows();

			const result = await applySync(db, USER_A, "backfill", [
				{
					url: "https://A.com/x?fbclid=123", // same normalized key
					title: "stale chrome title",
					chromeId: "c99",
					dateAddedMs: Date.now(),
					folderPath: "Bar/Other",
				},
			]);
			expect(result).toEqual({ inserted: 0, bumped: 0, skipped: 1 });

			const rows = await allRows();
			expect(rows).toHaveLength(1);
			// No bump, no overwrite of anything: url, title, chrome_id, tags,
			// created_at, updated_at all byte-identical.
			expect(rows[0]).toEqual(before);
		});

		it("conflict on an archived row leaves it archived", async () => {
			await applySync(db, USER_A, "live", [
				{
					url: "https://a.com/x",
					title: "t",
					chromeId: "c1",
					dateAddedMs: PAST.getTime(),
				},
			]);
			const archivedAt = new Date("2024-06-01T00:00:00.000Z");
			await db
				.update(bookmarks)
				.set({ archivedAt })
				.where(eq(bookmarks.userId, USER_A));

			const result = await applySync(db, USER_A, "backfill", [
				{ url: "https://a.com/x", title: "t", chromeId: "c1" },
			]);
			expect(result).toEqual({ inserted: 0, bumped: 0, skipped: 1 });

			const [row] = await allRows();
			expect(row.archivedAt).toEqual(archivedAt);
		});
	});

	describe("normalization-based dedupe", () => {
		it("two raw URLs that normalize identically hit one row across calls", async () => {
			const first = await applySync(db, USER_A, "live", [
				{
					url: "https://X.com/a/?utm_source=t#frag",
					title: "one",
					chromeId: "c1",
				},
			]);
			expect(first).toEqual({ inserted: 1, bumped: 0, skipped: 0 });

			const second = await applySync(db, USER_A, "live", [
				{ url: "https://x.com/a", title: "two", chromeId: "c2" },
			]);
			expect(second).toEqual({ inserted: 0, bumped: 1, skipped: 0 });

			const rows = await allRows();
			expect(rows).toHaveLength(1);
			expect(rows[0].urlNormalized).toBe("https://x.com/a");
			expect(rows[0].title).toBe("two");
		});

		it("two raw forms in one backfill batch collapse to one insert + one skip", async () => {
			const result = await applySync(db, USER_A, "backfill", [
				{
					url: "https://x.com/a/",
					title: "first",
					chromeId: "c1",
					dateAddedMs: PAST.getTime(),
				},
				{ url: "https://X.com/a?gclid=9", title: "second", chromeId: "c2" },
			]);
			expect(result).toEqual({ inserted: 1, bumped: 0, skipped: 1 });

			const rows = await allRows();
			expect(rows).toHaveLength(1);
			expect(rows[0].title).toBe("first");
		});
	});

	describe("within-batch duplicates", () => {
		it("live: last occurrence wins, counted as one upsert", async () => {
			const result = await applySync(db, USER_A, "live", [
				{ url: "https://a.com/x", title: "first", chromeId: "c1" },
				{ url: "https://a.com/x/", title: "second", chromeId: "c2" },
				{ url: "https://A.com/x", title: "third", chromeId: "c3" },
			]);
			// One key -> one insert; in-batch dupes fold into that result.
			expect(result).toEqual({ inserted: 1, bumped: 0, skipped: 0 });

			const rows = await allRows();
			expect(rows).toHaveLength(1);
			expect(rows[0].title).toBe("third");
			expect(rows[0].chromeId).toBe("c3");
		});

		it("live: duplicate batch against an existing row counts as one bump", async () => {
			await applySync(db, USER_A, "live", [
				{ url: "https://a.com/x", title: "orig", chromeId: "c0" },
			]);
			const result = await applySync(db, USER_A, "live", [
				{ url: "https://a.com/x", title: "first", chromeId: "c1" },
				{ url: "https://a.com/x", title: "second", chromeId: "c2" },
			]);
			expect(result).toEqual({ inserted: 0, bumped: 1, skipped: 0 });

			const rows = await allRows();
			expect(rows).toHaveLength(1);
			expect(rows[0].title).toBe("second");
		});

		it("backfill: first occurrence wins, later dupes counted as skipped", async () => {
			const early = PAST.getTime();
			const result = await applySync(db, USER_A, "backfill", [
				{
					url: "https://a.com/x",
					title: "first",
					chromeId: "c1",
					dateAddedMs: early,
					folderPath: "Bar/One",
				},
				{
					url: "https://a.com/x/",
					title: "second",
					chromeId: "c2",
					dateAddedMs: early + 1000,
				},
				{ url: "https://b.com/y", title: "other", chromeId: "c3" },
			]);
			expect(result).toEqual({ inserted: 2, bumped: 0, skipped: 1 });

			const rows = await allRows();
			expect(rows).toHaveLength(2);
			const dup = rows.find((r) => r.urlNormalized === "https://a.com/x");
			expect(dup?.title).toBe("first");
			expect(dup?.chromeId).toBe("c1");
			expect(dup?.tags).toEqual(["Bar/One"]);
			expect(dup?.createdAt).toEqual(PAST);
		});
	});

	describe("multi-user isolation", () => {
		it("same url_normalized for two users creates two independent rows", async () => {
			await applySync(db, USER_A, "live", [
				{
					url: "https://a.com/x",
					title: "A's title",
					chromeId: "c1",
					dateAddedMs: PAST.getTime(),
				},
			]);
			const result = await applySync(db, USER_B, "live", [
				{ url: "https://a.com/x", title: "B's title", chromeId: "c9" },
			]);
			// Inserted for B, not a bump of A's row.
			expect(result).toEqual({ inserted: 1, bumped: 0, skipped: 0 });

			expect(await allRows()).toHaveLength(2);
			const [rowA] = await allRows(USER_A);
			const [rowB] = await allRows(USER_B);
			expect(rowA.title).toBe("A's title");
			expect(rowA.updatedAt).toEqual(PAST); // untouched by B's sync
			expect(rowB.title).toBe("B's title");
		});
	});
});
