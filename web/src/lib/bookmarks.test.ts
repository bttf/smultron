// listBookmarks/patchBookmark tests against REAL Postgres semantics: an
// in-memory PGlite database with the production migrations from web/drizzle/
// applied in journal order (same harness as sync.test.ts / pairing.test.ts).
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
import {
	addBookmark,
	getBookmarkByUrl,
	InvalidCursorError,
	listBookmarks,
	patchBookmark,
	patchBookmarkByUrl,
} from "./bookmarks";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

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

type SeedRow = {
	userId: string;
	url: string;
	title: string;
	tags?: string[];
	note?: string | null;
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date | null;
	pinnedAt?: Date | null;
};

async function seed(rows: SeedRow[]) {
	await db.insert(bookmarks).values(
		rows.map((r) => ({
			userId: r.userId,
			url: r.url,
			urlNormalized: r.url,
			title: r.title,
			tags: r.tags ?? [],
			note: r.note ?? null,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
			archivedAt: r.archivedAt ?? null,
			pinnedAt: r.pinnedAt ?? null,
		})),
	);
}

/** n rows for `userId`, index 0 = most recently updated, spaced 1s apart. */
function makeFeedRows(userId: string, n: number, archived = false): SeedRow[] {
	const base = Date.parse("2026-01-01T00:00:00.000Z");
	return Array.from({ length: n }, (_, i) => ({
		userId,
		url: `https://example.com/page-${i}`,
		title: `Page ${i}`,
		createdAt: new Date(base - i * 1000),
		updatedAt: new Date(base - i * 1000),
		archivedAt: archived ? new Date(base) : null,
	}));
}

async function rawRow(id: number) {
	const rows = await db.select().from(bookmarks).where(eq(bookmarks.id, id));
	return rows[0];
}

describe("listBookmarks — feed", () => {
	it("orders updated_at desc, id desc and paginates 50/page with no overlap/gap", async () => {
		await seed(makeFeedRows(USER_A, 120));

		const page1 = await listBookmarks(db, USER_A, {});
		expect(page1.bookmarks).toHaveLength(50);
		expect(page1.bookmarks[0]?.title).toBe("Page 0");
		expect(page1.bookmarks[49]?.title).toBe("Page 49");
		// Every bookmark carries the nested highlights field, [] when none.
		expect(page1.bookmarks.every((b) => b.highlights.length === 0)).toBe(true);
		// ...and the m10 note field, null when unset.
		expect(page1.bookmarks.every((b) => b.note === null)).toBe(true);
		expect(page1.nextCursor).not.toBeNull();

		const page2 = await listBookmarks(db, USER_A, {
			cursor: page1.nextCursor ?? undefined,
		});
		expect(page2.bookmarks).toHaveLength(50);
		expect(page2.bookmarks[0]?.title).toBe("Page 50");
		expect(page2.bookmarks[49]?.title).toBe("Page 99");
		expect(page2.nextCursor).not.toBeNull();

		const page3 = await listBookmarks(db, USER_A, {
			cursor: page2.nextCursor ?? undefined,
		});
		expect(page3.bookmarks).toHaveLength(20);
		expect(page3.bookmarks[0]?.title).toBe("Page 100");
		expect(page3.bookmarks[19]?.title).toBe("Page 119");
		expect(page3.nextCursor).toBeNull();

		// No overlap, no gap across the full walk.
		const allIds = [
			...page1.bookmarks,
			...page2.bookmarks,
			...page3.bookmarks,
		].map((b) => b.id);
		expect(new Set(allIds).size).toBe(120);
	});

	it("breaks ties on id desc when updated_at is identical", async () => {
		const same = new Date("2026-01-01T00:00:00.000Z");
		await seed([
			{
				userId: USER_A,
				url: "https://a.com/1",
				title: "first inserted",
				createdAt: same,
				updatedAt: same,
			},
			{
				userId: USER_A,
				url: "https://a.com/2",
				title: "second inserted",
				createdAt: same,
				updatedAt: same,
			},
		]);

		const { bookmarks: rows } = await listBookmarks(db, USER_A, {});
		expect(rows.map((r) => r.title)).toEqual([
			"second inserted",
			"first inserted",
		]);
	});

	it("empty/whitespace q behaves like no q (feed)", async () => {
		await seed(makeFeedRows(USER_A, 3));
		const withSpaces = await listBookmarks(db, USER_A, { q: "   " });
		expect(withSpaces.bookmarks).toHaveLength(3);
		expect(withSpaces.nextCursor).toBeNull();
	});

	it("archived=false (default) shows ONLY live rows; archived=true shows ONLY archived rows", async () => {
		await seed(makeFeedRows(USER_A, 3, false));
		await seed(
			makeFeedRows(USER_A, 2, true).map((r, i) => ({
				...r,
				url: `https://example.com/archived-${i}`,
			})),
		);

		const live = await listBookmarks(db, USER_A, {});
		expect(live.bookmarks).toHaveLength(3);
		expect(live.bookmarks.every((b) => b.archivedAt === null)).toBe(true);

		const archived = await listBookmarks(db, USER_A, { archived: true });
		expect(archived.bookmarks).toHaveLength(2);
		expect(archived.bookmarks.every((b) => b.archivedAt !== null)).toBe(true);
	});

	it("rejects a malformed cursor", async () => {
		await expect(
			listBookmarks(db, USER_A, { cursor: "not-a-real-cursor!!" }),
		).rejects.toBeInstanceOf(InvalidCursorError);
		await expect(
			listBookmarks(db, USER_A, {
				cursor: Buffer.from("not json", "utf8").toString("base64url"),
			}),
		).rejects.toBeInstanceOf(InvalidCursorError);
		// Unsafe-integer id: would overflow int8 / serialize as "1e+19" in
		// Postgres — must be rejected up front, not surface as a query error.
		await expect(
			listBookmarks(db, USER_A, {
				cursor: Buffer.from(
					JSON.stringify({ u: "2026-01-01T00:00:00.000Z", id: 1e19 }),
					"utf8",
				).toString("base64url"),
			}),
		).rejects.toBeInstanceOf(InvalidCursorError);
	});
});

describe("listBookmarks — search", () => {
	it("matches multi-word queries via websearch_to_tsquery (FTS)", async () => {
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/rust-guide",
				title: "Rust Async Programming Guide",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				userId: USER_A,
				url: "https://example.com/unrelated",
				title: "Sourdough Bread Recipe",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const result = await listBookmarks(db, USER_A, {
			q: "rust programming",
		});
		expect(result.bookmarks).toHaveLength(1);
		expect(result.bookmarks[0]?.title).toBe("Rust Async Programming Guide");
		expect(result.nextCursor).toBeNull();
	});

	it("matches a partial word via trgm/substring (e.g. 'postgre')", async () => {
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/pg",
				title: "PostgreSQL Tutorial",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				userId: USER_A,
				url: "https://example.com/other",
				title: "MySQL Basics",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const result = await listBookmarks(db, USER_A, { q: "postgre" });
		expect(result.bookmarks).toHaveLength(1);
		expect(result.bookmarks[0]?.title).toBe("PostgreSQL Tutorial");
	});

	it("matches a partial substring inside url_normalized", async () => {
		await seed([
			{
				userId: USER_A,
				url: "https://blog.example.com/deep-dive-into-kubernetes",
				title: "",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const result = await listBookmarks(db, USER_A, { q: "kubernetes" });
		expect(result.bookmarks).toHaveLength(1);
	});

	it("orders FTS matches (higher rank) before trgm/substring-only matches, then by recency", async () => {
		const older = new Date("2025-01-01T00:00:00.000Z");
		const newer = new Date("2026-01-01T00:00:00.000Z");
		await seed([
			// Strong FTS match, but older.
			{
				userId: USER_A,
				url: "https://example.com/a",
				title: "Postgres Performance Tuning",
				createdAt: older,
				updatedAt: older,
			},
			// Substring-only match (no FTS lexeme match for "postgre" as a
			// prefix), but newer.
			{
				userId: USER_A,
				url: "https://example.com/b",
				title: "postgresql-cheatsheet",
				createdAt: newer,
				updatedAt: newer,
			},
		]);

		const result = await listBookmarks(db, USER_A, { q: "postgres" });
		expect(result.bookmarks).toHaveLength(2);
		// The FTS-matching row ranks higher despite being older.
		expect(result.bookmarks[0]?.title).toBe("Postgres Performance Tuning");
		expect(result.bookmarks[1]?.title).toBe("postgresql-cheatsheet");
	});

	it("search respects the archived filter", async () => {
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/live",
				title: "Postgres Live",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				userId: USER_A,
				url: "https://example.com/archived",
				title: "Postgres Archived",
				createdAt: new Date(),
				updatedAt: new Date(),
				archivedAt: new Date(),
			},
		]);

		const live = await listBookmarks(db, USER_A, { q: "postgres" });
		expect(live.bookmarks.map((b) => b.title)).toEqual(["Postgres Live"]);

		const archived = await listBookmarks(db, USER_A, {
			q: "postgres",
			archived: true,
		});
		expect(archived.bookmarks.map((b) => b.title)).toEqual([
			"Postgres Archived",
		]);
	});

	it("scopes search to the requesting user only", async () => {
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/a",
				title: "Shared Topic Notes",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				userId: USER_B,
				url: "https://example.com/b",
				title: "Shared Topic Notes",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const result = await listBookmarks(db, USER_A, { q: "shared topic" });
		expect(result.bookmarks).toHaveLength(1);
	});
});

describe("listBookmarks — tags + aggregates (m9)", () => {
	// A small mixed corpus: distinct updated_at values so feed order is
	// deterministic (index 0 = most recent), varied tags including a row
	// with none.
	function taggedRows(): SeedRow[] {
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		const rows: Array<{ title: string; tags: string[] }> = [
			{ title: "Postgres Guide", tags: ["dev"] },
			{ title: "Rust Book", tags: ["dev", "read later"] },
			{ title: "Postgres Recipes", tags: ["cooking"] },
			{ title: "Sourdough Notes", tags: ["cooking", "read later"] },
			{ title: "Untagged Page", tags: [] },
		];
		return rows.map((r, i) => ({
			userId: USER_A,
			url: `https://example.com/tagged-${i}`,
			title: r.title,
			tags: r.tags,
			createdAt: new Date(base - i * 1000),
			updatedAt: new Date(base - i * 1000),
		}));
	}

	it("filters the feed by a single tag (exact string match)", async () => {
		await seed(taggedRows());

		const result = await listBookmarks(db, USER_A, { tags: ["dev"] });
		expect(result.bookmarks.map((b) => b.title)).toEqual([
			"Postgres Guide",
			"Rust Book",
		]);
		expect(result.nextCursor).toBeNull();
	});

	it("multi-tag filter is AND: a row must contain EVERY requested tag", async () => {
		await seed(taggedRows());

		const result = await listBookmarks(db, USER_A, {
			tags: ["dev", "read later"],
		});
		expect(result.bookmarks.map((b) => b.title)).toEqual(["Rust Book"]);
		expect(result.matching).toBe(1);
	});

	it("tag with no matches: empty page, but total and facets stay correct", async () => {
		await seed(taggedRows());

		const result = await listBookmarks(db, USER_A, { tags: ["nope"] });
		expect(result.bookmarks).toHaveLength(0);
		expect(result.nextCursor).toBeNull();
		expect(result.matching).toBe(0);
		// total ignores the tag filter entirely.
		expect(result.total).toBe(5);
		// facets ignore the tag filter too — full per-tag counts of the view,
		// ordered count desc then tag asc; the untagged row contributes nothing.
		expect(result.facets).toEqual([
			{ tag: "cooking", count: 2 },
			{ tag: "dev", count: 2 },
			{ tag: "read later", count: 2 },
		]);
	});

	it("tags compose with q (search branch); facets scope to q but ignore tags", async () => {
		await seed(taggedRows());

		const result = await listBookmarks(db, USER_A, {
			q: "postgres",
			tags: ["dev"],
		});
		expect(result.bookmarks.map((b) => b.title)).toEqual(["Postgres Guide"]);
		expect(result.matching).toBe(1);
		expect(result.total).toBe(5);
		// Facets over q matches ("Postgres Guide" + "Postgres Recipes")
		// IGNORING the active dev filter, so "cooking" keeps its count.
		expect(result.facets).toEqual([
			{ tag: "cooking", count: 1 },
			{ tag: "dev", count: 1 },
		]);
	});

	it("tags compose with cursor keyset pagination in the feed branch", async () => {
		// 120 rows; every other row carries the tag → 60 tagged, > PAGE_SIZE.
		await seed(
			makeFeedRows(USER_A, 120).map((r, i) => ({
				...r,
				tags: i % 2 === 0 ? ["even"] : ["odd"],
			})),
		);

		const page1 = await listBookmarks(db, USER_A, { tags: ["even"] });
		expect(page1.bookmarks).toHaveLength(50);
		expect(page1.bookmarks.every((b) => b.tags.includes("even"))).toBe(true);
		expect(page1.bookmarks[0]?.title).toBe("Page 0");
		expect(page1.bookmarks[49]?.title).toBe("Page 98");
		expect(page1.nextCursor).not.toBeNull();
		// matching is the FULL filtered count, not the page size.
		expect(page1.matching).toBe(60);
		expect(page1.total).toBe(120);

		const page2 = await listBookmarks(db, USER_A, {
			tags: ["even"],
			cursor: page1.nextCursor ?? undefined,
		});
		expect(page2.bookmarks).toHaveLength(10);
		expect(page2.bookmarks[0]?.title).toBe("Page 100");
		expect(page2.bookmarks[9]?.title).toBe("Page 118");
		expect(page2.nextCursor).toBeNull();
		// Aggregates are uniform across cursor pages.
		expect(page2.matching).toBe(60);
		expect(page2.total).toBe(120);

		const allIds = [...page1.bookmarks, ...page2.bookmarks].map((b) => b.id);
		expect(new Set(allIds).size).toBe(60);
	});

	it("orders facets count desc, then tag asc as tiebreak", async () => {
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		const tagSets = [["alpha"], ["alpha", "zeta"], ["alpha", "beta", "zeta"]];
		await seed(
			tagSets.map((tags, i) => ({
				userId: USER_A,
				url: `https://example.com/facet-${i}`,
				title: `Facet ${i}`,
				tags,
				createdAt: new Date(base - i * 1000),
				updatedAt: new Date(base - i * 1000),
			})),
		);

		const result = await listBookmarks(db, USER_A, {});
		// Count desc: alpha (3), zeta (2), beta (1) — NOT alphabetical.
		expect(result.facets).toEqual([
			{ tag: "alpha", count: 3 },
			{ tag: "zeta", count: 2 },
			{ tag: "beta", count: 1 },
		]);
	});

	it("breaks facet count ties by tag asc", async () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/tie",
				title: "Tie Breaker",
				tags: ["zzz", "aaa", "mmm"],
				createdAt: now,
				updatedAt: now,
			},
		]);

		const result = await listBookmarks(db, USER_A, {});
		expect(result.facets).toEqual([
			{ tag: "aaa", count: 1 },
			{ tag: "mmm", count: 1 },
			{ tag: "zzz", count: 1 },
		]);
	});

	it("total === matching when no q and no tags", async () => {
		await seed(taggedRows());
		const result = await listBookmarks(db, USER_A, {});
		expect(result.total).toBe(5);
		expect(result.matching).toBe(5);
	});

	it("matching in the search branch is the full count beyond the page cap", async () => {
		// 60 rows all matching q — the search page caps at 50, matching must
		// still report 60.
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		await seed(
			Array.from({ length: 60 }, (_, i) => ({
				userId: USER_A,
				url: `https://example.com/postgres-${i}`,
				title: `Postgres Article ${i}`,
				createdAt: new Date(base - i * 1000),
				updatedAt: new Date(base - i * 1000),
			})),
		);

		const result = await listBookmarks(db, USER_A, { q: "postgres" });
		expect(result.bookmarks).toHaveLength(50);
		expect(result.nextCursor).toBeNull();
		expect(result.matching).toBe(60);
		expect(result.total).toBe(60);
	});

	it("all three aggregates scope to the archived view", async () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/live-1",
				title: "Postgres Live",
				tags: ["dev"],
				createdAt: now,
				updatedAt: now,
			},
			{
				userId: USER_A,
				url: "https://example.com/live-2",
				title: "Cooking Live",
				tags: ["cooking"],
				createdAt: now,
				updatedAt: now,
			},
			{
				userId: USER_A,
				url: "https://example.com/arch-1",
				title: "Postgres Archived",
				tags: ["dev", "old"],
				createdAt: now,
				updatedAt: now,
				archivedAt: now,
			},
		]);

		const archived = await listBookmarks(db, USER_A, {
			archived: true,
			tags: ["dev"],
		});
		expect(archived.bookmarks.map((b) => b.title)).toEqual([
			"Postgres Archived",
		]);
		expect(archived.total).toBe(1);
		expect(archived.matching).toBe(1);
		expect(archived.facets).toEqual([
			{ tag: "dev", count: 1 },
			{ tag: "old", count: 1 },
		]);

		const live = await listBookmarks(db, USER_A, { q: "postgres" });
		expect(live.total).toBe(2);
		expect(live.matching).toBe(1);
		expect(live.facets).toEqual([{ tag: "dev", count: 1 }]);
	});

	it("scopes aggregates to the requesting user", async () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/a",
				title: "A's Page",
				tags: ["dev"],
				createdAt: now,
				updatedAt: now,
			},
			{
				userId: USER_B,
				url: "https://example.com/b",
				title: "B's Page",
				tags: ["dev", "b-only"],
				createdAt: now,
				updatedAt: now,
			},
		]);

		const result = await listBookmarks(db, USER_A, {});
		expect(result.total).toBe(1);
		expect(result.matching).toBe(1);
		expect(result.facets).toEqual([{ tag: "dev", count: 1 }]);
	});
});

describe("patchBookmark", () => {
	async function seedOne(userId: string) {
		await seed([
			{
				userId,
				url: "https://example.com/x",
				title: "Original Title",
				tags: ["Bookmarks Bar/Dev"],
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		]);
		const [row] = await db
			.select()
			.from(bookmarks)
			.where(eq(bookmarks.userId, userId));
		if (!row) {
			throw new Error("seed failed");
		}
		return row;
	}

	it("updates ONLY title, leaving updated_at byte-identical", async () => {
		const before = await seedOne(USER_A);
		const updated = await patchBookmark(db, USER_A, before.id, {
			title: "New Title",
		});
		expect(updated?.title).toBe("New Title");
		expect(updated?.tags).toEqual(before.tags);
		expect(updated?.archivedAt).toEqual(before.archivedAt);
		expect(updated?.updatedAt).toEqual(before.updatedAt);

		const after = await rawRow(before.id);
		expect(after?.updatedAt).toEqual(before.updatedAt);
	});

	it("updates ONLY tags, leaving updated_at byte-identical", async () => {
		const before = await seedOne(USER_A);
		const updated = await patchBookmark(db, USER_A, before.id, {
			tags: ["new-tag", "another"],
		});
		expect(updated?.tags).toEqual(["new-tag", "another"]);
		expect(updated?.title).toBe(before.title);
		expect(updated?.updatedAt).toEqual(before.updatedAt);

		const after = await rawRow(before.id);
		expect(after?.updatedAt).toEqual(before.updatedAt);
	});

	it("archives: sets archived_at, leaves updated_at byte-identical", async () => {
		const before = await seedOne(USER_A);
		expect(before.archivedAt).toBeNull();

		const updated = await patchBookmark(db, USER_A, before.id, {
			archived: true,
		});
		expect(updated?.archivedAt).not.toBeNull();
		expect(updated?.title).toBe(before.title);
		expect(updated?.tags).toEqual(before.tags);
		expect(updated?.updatedAt).toEqual(before.updatedAt);
	});

	it("unarchives: clears archived_at, leaves updated_at byte-identical", async () => {
		const before = await seedOne(USER_A);
		await patchBookmark(db, USER_A, before.id, { archived: true });

		const updated = await patchBookmark(db, USER_A, before.id, {
			archived: false,
		});
		expect(updated?.archivedAt).toBeNull();
		expect(updated?.updatedAt).toEqual(before.updatedAt);
	});

	it("returns null (route 404s) for a nonexistent id", async () => {
		const result = await patchBookmark(db, USER_A, 999_999, {
			title: "nope",
		});
		expect(result).toBeNull();
	});

	it("enforces ownership: user B cannot patch user A's row", async () => {
		const before = await seedOne(USER_A);
		const result = await patchBookmark(db, USER_B, before.id, {
			title: "hijacked",
		});
		expect(result).toBeNull();

		const after = await rawRow(before.id);
		expect(after?.title).toBe("Original Title");
	});

	it("enforces ownership: user B's list never includes user A's rows", async () => {
		await seedOne(USER_A);
		const { bookmarks: rows } = await listBookmarks(db, USER_B, {});
		expect(rows).toHaveLength(0);
	});
});

describe("pins (m13)", () => {
	const T0 = new Date("2026-01-01T00:00:00.000Z");

	async function seedOne(extra: Partial<SeedRow> = {}) {
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/pin-me",
				title: "Pin Me",
				createdAt: T0,
				updatedAt: T0,
				...extra,
			},
		]);
		const [row] = await db
			.select()
			.from(bookmarks)
			.where(eq(bookmarks.userId, USER_A));
		if (!row) {
			throw new Error("seed failed");
		}
		return row;
	}

	it("pins: sets pinned_at, leaving updated_at byte-identical", async () => {
		const before = await seedOne();
		const updated = await patchBookmark(db, USER_A, before.id, {
			pinned: true,
		});
		expect(updated?.pinnedAt).not.toBeNull();
		expect(updated?.updatedAt).toEqual(before.updatedAt);

		const after = await rawRow(before.id);
		expect(after?.updatedAt).toEqual(before.updatedAt);
	});

	it("unpins: clears pinned_at, leaving updated_at byte-identical", async () => {
		const before = await seedOne({ pinnedAt: T0 });
		const updated = await patchBookmark(db, USER_A, before.id, {
			pinned: false,
		});
		expect(updated?.pinnedAt).toBeNull();
		expect(updated?.updatedAt).toEqual(before.updatedAt);
	});

	it("re-pinning refreshes pinned_at (moves the row to the shelf front)", async () => {
		const before = await seedOne({ pinnedAt: T0 });
		const updated = await patchBookmark(db, USER_A, before.id, {
			pinned: true,
		});
		expect(updated?.pinnedAt?.getTime()).toBeGreaterThan(T0.getTime());
	});

	it("pinning unarchives (a pinned row is a live row)", async () => {
		const before = await seedOne({ archivedAt: T0 });
		const updated = await patchBookmark(db, USER_A, before.id, {
			pinned: true,
		});
		expect(updated?.pinnedAt).not.toBeNull();
		expect(updated?.archivedAt).toBeNull();
		expect(updated?.updatedAt).toEqual(before.updatedAt);
	});

	it("archiving unpins (the shelf only holds live rows)", async () => {
		const before = await seedOne({ pinnedAt: T0 });
		const updated = await patchBookmark(db, USER_A, before.id, {
			archived: true,
		});
		expect(updated?.archivedAt).not.toBeNull();
		expect(updated?.pinnedAt).toBeNull();
		expect(updated?.updatedAt).toEqual(before.updatedAt);
	});

	it("feed log excludes pinned rows; the shelf carries them, most recently pinned first", async () => {
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		await seed([
			...makeFeedRows(USER_A, 3),
			{
				userId: USER_A,
				url: "https://example.com/pin-old",
				title: "Pinned earlier",
				tags: ["tools"],
				createdAt: new Date(base - 10_000),
				updatedAt: new Date(base - 10_000),
				pinnedAt: new Date(base - 5_000),
			},
			{
				userId: USER_A,
				url: "https://example.com/pin-new",
				title: "Pinned later",
				createdAt: new Date(base - 20_000),
				updatedAt: new Date(base - 20_000),
				pinnedAt: new Date(base - 1_000),
			},
		]);

		const result = await listBookmarks(db, USER_A, {});
		// The log: only the 3 unpinned rows.
		expect(result.bookmarks.map((b) => b.title)).toEqual([
			"Page 0",
			"Page 1",
			"Page 2",
		]);
		// The shelf: pinned rows ordered pinned_at desc.
		expect(result.pinned.map((b) => b.title)).toEqual([
			"Pinned later",
			"Pinned earlier",
		]);
		// total describes the view (pins included); matching describes the log.
		expect(result.total).toBe(5);
		expect(result.matching).toBe(3);
		// Facets keep counting pinned rows — they're still part of the view.
		expect(result.facets).toEqual([{ tag: "tools", count: 1 }]);
	});

	it("search includes pinned rows (they stay findable) and counts them in matching", async () => {
		await seedOne({ pinnedAt: T0, title: "Wild strawberry patch" });
		const result = await listBookmarks(db, USER_A, { q: "strawberry" });
		expect(result.bookmarks.map((b) => b.title)).toEqual([
			"Wild strawberry patch",
		]);
		expect(result.matching).toBe(1);
		expect(result.pinned.map((b) => b.title)).toEqual([
			"Wild strawberry patch",
		]);
	});

	it("the shelf is user-scoped and identical across live/archived views", async () => {
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/a",
				title: "A's pin",
				createdAt: T0,
				updatedAt: T0,
				pinnedAt: T0,
			},
			{
				userId: USER_B,
				url: "https://example.com/b",
				title: "B's pin",
				createdAt: T0,
				updatedAt: T0,
				pinnedAt: T0,
			},
		]);

		const live = await listBookmarks(db, USER_A, {});
		expect(live.pinned.map((b) => b.title)).toEqual(["A's pin"]);

		const archived = await listBookmarks(db, USER_A, { archived: true });
		expect(archived.pinned.map((b) => b.title)).toEqual(["A's pin"]);
	});

	it("pins by raw URL (by-url patch), never bumping updated_at", async () => {
		const before = await seedOne({ url: "https://example.com/pin-me" });
		const updated = await patchBookmarkByUrl(
			db,
			USER_A,
			// Messy raw variant — normalization must land on the same row.
			"https://example.com/pin-me/#frag",
			{ pinned: true },
		);
		expect(updated?.id).toBe(before.id);
		expect(updated?.pinnedAt).not.toBeNull();
		expect(updated?.updatedAt).toEqual(before.updatedAt);
	});

	it("web-add conflict (addBookmark) keeps pinned_at while bumping", async () => {
		const before = await seedOne({ pinnedAt: T0 });
		const { bookmark, created } = await addBookmark(
			db,
			USER_A,
			"https://example.com/pin-me",
		);
		expect(created).toBe(false);
		expect(bookmark.id).toBe(before.id);
		// Bump + unarchive only (§5 web add) — the pin survives the re-save.
		expect(bookmark.pinnedAt).toEqual(T0);
		expect(bookmark.updatedAt.getTime()).toBeGreaterThan(
			before.updatedAt.getTime(),
		);
	});

	it("cursor pagination never surfaces pinned rows on any page", async () => {
		// 60 unpinned rows (2 pages) with 3 pinned rows interleaved in the
		// same updated_at range — the not-pinned condition must compose with
		// the keyset cursor on both pages.
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		await seed([
			...makeFeedRows(USER_A, 60),
			...[10, 30, 55].map((i) => ({
				userId: USER_A,
				url: `https://example.com/pinned-${i}`,
				title: `Pinned ${i}`,
				createdAt: new Date(base - i * 1000 - 500),
				updatedAt: new Date(base - i * 1000 - 500),
				pinnedAt: new Date(base),
			})),
		]);

		const page1 = await listBookmarks(db, USER_A, {});
		expect(page1.bookmarks).toHaveLength(50);
		expect(page1.nextCursor).not.toBeNull();

		const page2 = await listBookmarks(db, USER_A, {
			cursor: page1.nextCursor ?? undefined,
		});
		expect(page2.bookmarks).toHaveLength(10);
		expect(page2.nextCursor).toBeNull();

		const titles = [...page1.bookmarks, ...page2.bookmarks].map((b) => b.title);
		expect(titles).toHaveLength(60);
		expect(titles.some((t) => t.startsWith("Pinned"))).toBe(false);
		expect(page1.matching).toBe(60);
		expect(page1.total).toBe(63);
		expect(page1.pinned).toHaveLength(3);
	});
});

describe("patchBookmark — note (m10)", () => {
	async function seedOne(note: string | null = null) {
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/noted",
				title: "Noted Page",
				note,
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		]);
		const [row] = await db
			.select()
			.from(bookmarks)
			.where(eq(bookmarks.userId, USER_A));
		if (!row) {
			throw new Error("seed failed");
		}
		return row;
	}

	it("sets a note, leaving updated_at byte-identical and other fields untouched", async () => {
		const before = await seedOne();
		const updated = await patchBookmark(db, USER_A, before.id, {
			note: "read this before the meeting",
		});
		expect(updated?.note).toBe("read this before the meeting");
		expect(updated?.title).toBe(before.title);
		expect(updated?.tags).toEqual(before.tags);
		expect(updated?.updatedAt).toEqual(before.updatedAt);

		const after = await rawRow(before.id);
		expect(after?.note).toBe("read this before the meeting");
		expect(after?.updatedAt).toEqual(before.updatedAt);
	});

	it("edits an existing note in place", async () => {
		const before = await seedOne("first draft");
		const updated = await patchBookmark(db, USER_A, before.id, {
			note: "second draft",
		});
		expect(updated?.note).toBe("second draft");
		expect(updated?.updatedAt).toEqual(before.updatedAt);
	});

	it("trims surrounding whitespace", async () => {
		const before = await seedOne();
		const updated = await patchBookmark(db, USER_A, before.id, {
			note: "  keep the middle  spacing  ",
		});
		expect(updated?.note).toBe("keep the middle  spacing");
	});

	it("empty and whitespace-only notes store NULL (note removed)", async () => {
		const before = await seedOne("something");

		const cleared = await patchBookmark(db, USER_A, before.id, { note: "" });
		expect(cleared?.note).toBeNull();

		await patchBookmark(db, USER_A, before.id, { note: "back" });
		const clearedAgain = await patchBookmark(db, USER_A, before.id, {
			note: "   \n\t ",
		});
		expect(clearedAgain?.note).toBeNull();
		expect(clearedAgain?.updatedAt).toEqual(before.updatedAt);
	});

	it("note patch composes with other fields; none of them bump updated_at", async () => {
		const before = await seedOne();
		const updated = await patchBookmark(db, USER_A, before.id, {
			title: "Renamed",
			tags: ["t1"],
			note: "combined patch",
			archived: true,
		});
		expect(updated?.title).toBe("Renamed");
		expect(updated?.tags).toEqual(["t1"]);
		expect(updated?.note).toBe("combined patch");
		expect(updated?.archivedAt).not.toBeNull();
		expect(updated?.updatedAt).toEqual(before.updatedAt);
	});
});

describe("listBookmarks — note search (m10)", () => {
	// Mixed corpus: a row matched ONLY via its note, a decoy whose
	// title/url never match, and a NULL-note row (coalesce guard).
	function notedRows(): SeedRow[] {
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		const rows: Array<{ title: string; note?: string; tags?: string[] }> = [
			{
				title: "Plain Article",
				note: "revisit for the quarterly planning deck",
				tags: ["work"],
			},
			{ title: "Sourdough Bread Recipe", tags: ["cooking"] },
			{ title: "Untouched Page" },
		];
		return rows.map((r, i) => ({
			userId: USER_A,
			url: `https://example.com/noted-${i}`,
			title: r.title,
			tags: r.tags ?? [],
			note: r.note ?? null,
			createdAt: new Date(base - i * 1000),
			updatedAt: new Date(base - i * 1000),
		}));
	}

	it("matches note text via FTS (multi-word), with NULL notes coalesced", async () => {
		await seed(notedRows());
		const result = await listBookmarks(db, USER_A, {
			q: "quarterly planning",
		});
		expect(result.bookmarks.map((b) => b.title)).toEqual(["Plain Article"]);
		expect(result.bookmarks[0]?.note).toBe(
			"revisit for the quarterly planning deck",
		);
	});

	it("matches note text via ILIKE substring (partial word)", async () => {
		await seed(notedRows());
		// "quarterl" is not an FTS lexeme match and no trgm runs on note —
		// the ILIKE disjunct must catch it.
		const result = await listBookmarks(db, USER_A, { q: "quarterl" });
		expect(result.bookmarks.map((b) => b.title)).toEqual(["Plain Article"]);
	});

	it("matching and facets reflect note-only matches (shared matchCond)", async () => {
		await seed(notedRows());
		const result = await listBookmarks(db, USER_A, { q: "quarterly" });
		expect(result.matching).toBe(1);
		expect(result.total).toBe(3);
		expect(result.facets).toEqual([{ tag: "work", count: 1 }]);
	});

	it("a corpus of all-NULL notes still searches fine (coalesce)", async () => {
		await seed(makeFeedRows(USER_A, 3));
		const result = await listBookmarks(db, USER_A, { q: "page" });
		expect(result.bookmarks).toHaveLength(3);
	});

	it("note search respects the archived view filter", async () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/live",
				title: "Live",
				note: "kumquat notes",
				createdAt: now,
				updatedAt: now,
			},
			{
				userId: USER_A,
				url: "https://example.com/archived",
				title: "Archived",
				note: "kumquat notes",
				createdAt: now,
				updatedAt: now,
				archivedAt: now,
			},
		]);

		const live = await listBookmarks(db, USER_A, { q: "kumquat" });
		expect(live.bookmarks.map((b) => b.title)).toEqual(["Live"]);
	});
});

describe("by-url lookup + patch (m10)", () => {
	// Seed stores `url` as url_normalized verbatim, so seed with the
	// already-normalized form and query with messy raw spellings.
	const NORMALIZED = "https://example.com/article?x=1";
	const MESSY_RAW =
		"HTTPS://Example.com/article/?x=1&utm_source=tw&fbclid=abc#frag";

	async function seedOne(userId = USER_A) {
		await seed([
			{
				userId,
				url: NORMALIZED,
				title: "Article",
				tags: ["read later"],
				note: "existing note",
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		]);
		const [row] = await db
			.select()
			.from(bookmarks)
			.where(eq(bookmarks.userId, userId));
		if (!row) {
			throw new Error("seed failed");
		}
		return row;
	}

	it("finds a bookmark from a messy raw URL (server-side normalization)", async () => {
		const before = await seedOne();
		const found = await getBookmarkByUrl(db, USER_A, MESSY_RAW);
		expect(found?.id).toBe(before.id);
		expect(found?.urlNormalized).toBe(NORMALIZED);
		expect(found?.title).toBe("Article");
		expect(found?.note).toBe("existing note");
		// Bare row: no nested highlights on the by-url shape.
		expect(found && "highlights" in found).toBe(false);
	});

	it("returns null when the user has no bookmark for the URL", async () => {
		await seedOne();
		const found = await getBookmarkByUrl(
			db,
			USER_A,
			"https://example.com/other-page",
		);
		expect(found).toBeNull();
	});

	it("scopes lookup per user: user B cannot see user A's bookmark", async () => {
		await seedOne(USER_A);
		const found = await getBookmarkByUrl(db, USER_B, MESSY_RAW);
		expect(found).toBeNull();
	});

	it("patches by raw URL, never bumping updated_at", async () => {
		const before = await seedOne();
		const updated = await patchBookmarkByUrl(db, USER_A, MESSY_RAW, {
			title: "Renamed via popup",
			note: "  popup note  ",
			tags: ["popup"],
		});
		expect(updated?.id).toBe(before.id);
		expect(updated?.title).toBe("Renamed via popup");
		expect(updated?.note).toBe("popup note");
		expect(updated?.tags).toEqual(["popup"]);
		expect(updated?.updatedAt).toEqual(before.updatedAt);

		const after = await rawRow(before.id);
		expect(after?.updatedAt).toEqual(before.updatedAt);
	});

	it("clears the note by-url when empty after trim", async () => {
		const before = await seedOne();
		const updated = await patchBookmarkByUrl(db, USER_A, NORMALIZED, {
			note: "   ",
		});
		expect(updated?.note).toBeNull();
		expect(updated?.updatedAt).toEqual(before.updatedAt);
	});

	it("archives and restores by-url, never bumping updated_at", async () => {
		const before = await seedOne();

		const archived = await patchBookmarkByUrl(db, USER_A, MESSY_RAW, {
			archived: true,
		});
		expect(archived?.archivedAt).not.toBeNull();
		expect(archived?.updatedAt).toEqual(before.updatedAt);

		const restored = await patchBookmarkByUrl(db, USER_A, NORMALIZED, {
			archived: false,
		});
		expect(restored?.archivedAt).toBeNull();
		expect(restored?.updatedAt).toEqual(before.updatedAt);
	});

	it("returns null (route 404s) when patching an unknown URL", async () => {
		await seedOne();
		const result = await patchBookmarkByUrl(
			db,
			USER_A,
			"https://example.com/nope",
			{ note: "won't land" },
		);
		expect(result).toBeNull();
	});

	it("scopes patch per user: user B cannot patch user A's bookmark", async () => {
		const before = await seedOne(USER_A);
		const result = await patchBookmarkByUrl(db, USER_B, NORMALIZED, {
			title: "hijacked",
		});
		expect(result).toBeNull();

		const after = await rawRow(before.id);
		expect(after?.title).toBe("Article");
	});
});

// SPEC §5 web add (m11): insert with hostname-autofilled title, or
// bump+unarchive ONLY on normalized-URL conflict — the third and last
// updated_at-bumping path (with applySync live mode and applyHighlight).
describe("addBookmark", () => {
	it("inserts a new bookmark: title from hostname (www. stripped), no tags", async () => {
		const { bookmark, created } = await addBookmark(
			db,
			USER_A,
			"https://www.example.com/article/",
		);

		expect(created).toBe(true);
		expect(bookmark.title).toBe("example.com");
		expect(bookmark.url).toBe("https://www.example.com/article/");
		expect(bookmark.urlNormalized).toBe("https://www.example.com/article");
		expect(bookmark.tags).toEqual([]);
		expect(bookmark.note).toBeNull();
		expect(bookmark.archivedAt).toBeNull();
		expect(bookmark.updatedAt).toEqual(bookmark.createdAt);

		const raw = await rawRow(bookmark.id);
		expect(raw?.chromeId).toBeNull();
	});

	it("bumps + unarchives on normalized-URL conflict, touching nothing else", async () => {
		const old = new Date("2026-01-01T00:00:00.000Z");
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/a",
				title: "Kept title",
				tags: ["kept-tag"],
				note: "kept note",
				createdAt: old,
				updatedAt: old,
				archivedAt: old,
			},
		]);

		// Messy re-add: fragment + utm + trailing slash + uppercase host all
		// normalize down to the seeded url_normalized.
		const { bookmark, created } = await addBookmark(
			db,
			USER_A,
			"https://EXAMPLE.com/a/?utm_source=x#frag",
		);

		expect(created).toBe(false);
		expect(bookmark.updatedAt.getTime()).toBeGreaterThan(old.getTime());
		expect(bookmark.archivedAt).toBeNull();
		expect(bookmark.title).toBe("Kept title");
		expect(bookmark.tags).toEqual(["kept-tag"]);
		expect(bookmark.note).toBe("kept note");
		expect(bookmark.url).toBe("https://example.com/a");
		expect(bookmark.createdAt).toEqual(old);
	});

	it("dedupes per user: the same URL for another user is a fresh insert", async () => {
		const a = await addBookmark(db, USER_A, "https://example.com/shared");
		const b = await addBookmark(db, USER_B, "https://example.com/shared");

		expect(a.created).toBe(true);
		expect(b.created).toBe(true);
		expect(b.bookmark.id).not.toBe(a.bookmark.id);
	});

	it("stores unparseable input with an empty title (route rejects these first)", async () => {
		const { bookmark, created } = await addBookmark(db, USER_A, "not a url");

		expect(created).toBe(true);
		expect(bookmark.title).toBe("");
		expect(bookmark.urlNormalized).toBe("not a url");
	});
});
