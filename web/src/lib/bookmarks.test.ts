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
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import * as schema from "../db/schema";
import { bookmarks } from "../db/schema";
import {
	addBookmark,
	getBookmarkByUrl,
	InvalidCursorError,
	listBookmarks,
	patchBookmark,
	patchBookmarkByUrl,
	reorderPinned,
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
	/** m21 shelf slot; auto-seated (see `seed`) when omitted on a pinned row. */
	pinPosition?: number | null;
};

/**
 * m21: `pin_position` is null iff `pinned_at` is (a CHECK constraint), so a
 * pinned seed row always needs a slot. One left unset is seated the way
 * migration 0012 seats existing pins — per user, `pinned_at desc` then latest
 * row first — so seeds written against the m13 shelf order still describe the
 * same shelf.
 */
function autoPinPositions(rows: SeedRow[]): Map<SeedRow, number> {
	const seats = new Map<SeedRow, number>();
	const byUser = new Map<string, Array<{ row: SeedRow; i: number }>>();
	rows.forEach((row, i) => {
		if (row.pinnedAt && row.pinPosition == null) {
			const list = byUser.get(row.userId) ?? [];
			list.push({ row, i });
			byUser.set(row.userId, list);
		}
	});
	for (const list of byUser.values()) {
		list
			.sort(
				(a, b) =>
					(b.row.pinnedAt?.getTime() ?? 0) - (a.row.pinnedAt?.getTime() ?? 0) ||
					b.i - a.i,
			)
			.forEach(({ row }, pos) => {
				seats.set(row, pos);
			});
	}
	return seats;
}

async function seed(rows: SeedRow[]) {
	const seats = autoPinPositions(rows);
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
			pinPosition: r.pinPosition ?? seats.get(r) ?? null,
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

	it("re-pinning is a no-op on BOTH pin columns (m21: it keeps its slot)", async () => {
		const before = await seedOne({ pinnedAt: T0, pinPosition: 3 });
		const updated = await patchBookmark(db, USER_A, before.id, {
			pinned: true,
		});
		// m13 refreshed pinned_at here to jump to the shelf front; since the
		// order is hand-arranged (m21) a re-pin must not move the card at all.
		expect(updated?.pinnedAt).toEqual(T0);
		expect(updated?.updatedAt).toEqual(before.updatedAt);
		const after = await rawRow(before.id);
		expect(after?.pinPosition).toBe(3);
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

	it("feed log INCLUDES pinned rows in updated_at order (m22); the shelf carries them too", async () => {
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		await seed([
			// Page 0 @ base, Page 1 @ base-1s, Page 2 @ base-2s.
			...makeFeedRows(USER_A, 3),
			{
				userId: USER_A,
				url: "https://example.com/pin-old",
				title: "Pinned earlier",
				tags: ["tools"],
				// Sits between Page 0 and Page 1 in the log's chronology.
				createdAt: new Date(base - 500),
				updatedAt: new Date(base - 500),
				pinnedAt: new Date(base - 5_000),
			},
			{
				userId: USER_A,
				url: "https://example.com/pin-new",
				title: "Pinned later",
				// Oldest row of all — the log must not float it to the top.
				createdAt: new Date(base - 20_000),
				updatedAt: new Date(base - 20_000),
				pinnedAt: new Date(base - 1_000),
			},
		]);

		const result = await listBookmarks(db, USER_A, {});
		// The log: every row, pinned or not, in plain updated_at desc order.
		expect(result.bookmarks.map((b) => b.title)).toEqual([
			"Page 0",
			"Pinned earlier",
			"Page 1",
			"Page 2",
			"Pinned later",
		]);
		// The shelf still carries them, ordered by pin_position (seeded in the
		// m13 order) — a pinned row appears in BOTH.
		expect(result.pinned.map((b) => b.title)).toEqual([
			"Pinned later",
			"Pinned earlier",
		]);
		// m22: nothing is subtracted any more, so the plain feed has
		// matching === total.
		expect(result.total).toBe(5);
		expect(result.matching).toBe(5);
		// Facets keep counting pinned rows — they always described the view.
		expect(result.facets).toEqual([{ tag: "tools", count: 1 }]);
	});

	it("tag filters apply to pinned rows like any others (m22)", async () => {
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		await seed([
			{
				userId: USER_A,
				url: "https://example.com/pinned-tagged",
				title: "Pinned + tagged",
				tags: ["tools"],
				createdAt: new Date(base),
				updatedAt: new Date(base),
				pinnedAt: new Date(base),
			},
			{
				userId: USER_A,
				url: "https://example.com/pinned-untagged",
				title: "Pinned, other tag",
				tags: ["misc"],
				createdAt: new Date(base - 1_000),
				updatedAt: new Date(base - 1_000),
				pinnedAt: new Date(base - 1_000),
			},
			{
				userId: USER_A,
				url: "https://example.com/plain-tagged",
				title: "Unpinned + tagged",
				tags: ["tools"],
				createdAt: new Date(base - 2_000),
				updatedAt: new Date(base - 2_000),
			},
		]);

		const result = await listBookmarks(db, USER_A, { tags: ["tools"] });
		expect(result.bookmarks.map((b) => b.title)).toEqual([
			"Pinned + tagged",
			"Unpinned + tagged",
		]);
		expect(result.matching).toBe(2);
		expect(result.total).toBe(3);
		// The shelf ignores the tag filter — it is always the whole shelf.
		expect(result.pinned).toHaveLength(2);
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
			"https://example.com/pin-me/?utm_source=x#:~:text=frag",
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

	it("cursor pagination walks across pinned rows without gap or overlap (m22)", async () => {
		// 60 unpinned rows with 3 pinned rows interleaved in the same
		// updated_at range: 63 rows = 2 pages, and the keyset must step over a
		// pinned row exactly like an unpinned one.
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
		expect(page2.bookmarks).toHaveLength(13);
		expect(page2.nextCursor).toBeNull();

		const titles = [...page1.bookmarks, ...page2.bookmarks].map((b) => b.title);
		expect(titles).toHaveLength(63);
		expect(new Set(titles).size).toBe(63);
		// Each pinned row lands right after the unpinned row it follows in
		// updated_at order (pinned-i is 500ms older than Page i).
		expect(titles.indexOf("Pinned 10")).toBe(titles.indexOf("Page 10") + 1);
		expect(titles.indexOf("Pinned 30")).toBe(titles.indexOf("Page 30") + 1);
		// …including the one that straddles the page boundary.
		expect(titles.indexOf("Pinned 55")).toBe(titles.indexOf("Page 55") + 1);
		expect(page1.matching).toBe(63);
		expect(page1.total).toBe(63);
		expect(page1.pinned).toHaveLength(3);
	});
});

describe("shelf ordering + reorder (m21)", () => {
	const T0 = new Date("2026-01-01T00:00:00.000Z");

	type PinSeed = {
		title: string;
		pinnedAt?: Date | null;
		pinPosition?: number | null;
		archivedAt?: Date | null;
	};

	/** Seeds rows for one user; returns their ids keyed by title. */
	async function seedShelf(
		userId: string,
		rows: PinSeed[],
	): Promise<Record<string, number>> {
		await seed(
			rows.map((r) => ({
				userId,
				url: `https://example.com/${encodeURIComponent(r.title)}`,
				title: r.title,
				createdAt: T0,
				updatedAt: T0,
				archivedAt: r.archivedAt ?? null,
				pinnedAt: r.pinnedAt ?? null,
				pinPosition: r.pinPosition ?? null,
			})),
		);
		const inserted = await db
			.select()
			.from(bookmarks)
			.where(eq(bookmarks.userId, userId));
		return Object.fromEntries(inserted.map((row) => [row.title, row.id]));
	}

	/** Every row's (pin_position, pinned_at, updated_at), keyed by id. */
	async function snapshot() {
		const rows = await db.select().from(bookmarks);
		return new Map(
			rows.map((row) => [
				row.id,
				{
					pinPosition: row.pinPosition,
					pinnedAt: row.pinnedAt,
					updatedAt: row.updatedAt,
				},
			]),
		);
	}

	it("a new pin lands at the END of the shelf (max + 1; 0 when it is the first)", async () => {
		// Another user's shelf must not influence the max.
		await seedShelf(USER_B, [
			{ title: "B pinned", pinnedAt: T0, pinPosition: 9 },
		]);
		const ids = await seedShelf(USER_A, [
			{ title: "First" },
			{ title: "Second" },
		]);

		const first = await patchBookmark(db, USER_A, ids.First, { pinned: true });
		expect(first?.pinnedAt).not.toBeNull();
		expect((await rawRow(ids.First))?.pinPosition).toBe(0);
		expect(first?.updatedAt).toEqual(T0);

		const second = await patchBookmark(db, USER_A, ids.Second, {
			pinned: true,
		});
		expect(second?.pinnedAt).not.toBeNull();
		expect((await rawRow(ids.Second))?.pinPosition).toBe(1);
		expect(second?.updatedAt).toEqual(T0);

		// User B's shelf is untouched by A's pins.
		expect((await rawRow(ids["B pinned"] ?? -1))?.pinPosition).toBeUndefined();
	});

	it("slots are never compacted on unpin — the next pin still appends past the gap", async () => {
		const ids = await seedShelf(USER_A, [
			{ title: "A", pinnedAt: T0, pinPosition: 0 },
			{ title: "B", pinnedAt: T0, pinPosition: 1 },
			{ title: "C", pinnedAt: T0, pinPosition: 2 },
			{ title: "D" },
		]);

		await patchBookmark(db, USER_A, ids.B, { pinned: false });
		expect((await rawRow(ids.B))?.pinPosition).toBeNull();
		expect((await rawRow(ids.B))?.pinnedAt).toBeNull();

		await patchBookmark(db, USER_A, ids.D, { pinned: true });
		expect((await rawRow(ids.D))?.pinPosition).toBe(3);
	});

	it("unpinning and archiving both clear pin_position with pinned_at", async () => {
		const ids = await seedShelf(USER_A, [
			{ title: "Unpin me", pinnedAt: T0, pinPosition: 0 },
			{ title: "Archive me", pinnedAt: T0, pinPosition: 1 },
		]);

		const unpinned = await patchBookmark(db, USER_A, ids["Unpin me"], {
			pinned: false,
		});
		expect(unpinned?.pinnedAt).toBeNull();
		expect((await rawRow(ids["Unpin me"]))?.pinPosition).toBeNull();
		expect(unpinned?.updatedAt).toEqual(T0);

		const archived = await patchBookmark(db, USER_A, ids["Archive me"], {
			archived: true,
		});
		expect(archived?.pinnedAt).toBeNull();
		expect((await rawRow(ids["Archive me"]))?.pinPosition).toBeNull();
		expect(archived?.updatedAt).toEqual(T0);
	});

	it("pinning an archived row unarchives it and gives it a slot", async () => {
		const ids = await seedShelf(USER_A, [
			{ title: "Seated", pinnedAt: T0, pinPosition: 0 },
			{ title: "Archived", archivedAt: T0 },
		]);

		const updated = await patchBookmark(db, USER_A, ids.Archived, {
			pinned: true,
		});
		expect(updated?.archivedAt).toBeNull();
		expect(updated?.pinnedAt).not.toBeNull();
		expect((await rawRow(ids.Archived))?.pinPosition).toBe(1);
		expect(updated?.updatedAt).toEqual(T0);
	});

	it("the shelf sorts by pin_position, NOT pinned_at", async () => {
		// Positions deliberately contradict the pinned_at order.
		await seedShelf(USER_A, [
			{
				title: "Pinned first, sits last",
				pinnedAt: new Date("2026-01-01T00:00:00.000Z"),
				pinPosition: 2,
			},
			{
				title: "Pinned last, sits first",
				pinnedAt: new Date("2026-03-01T00:00:00.000Z"),
				pinPosition: 0,
			},
			{
				title: "Middle",
				pinnedAt: new Date("2026-02-01T00:00:00.000Z"),
				pinPosition: 1,
			},
		]);

		const result = await listBookmarks(db, USER_A, {});
		expect(result.pinned.map((b) => b.title)).toEqual([
			"Pinned last, sits first",
			"Middle",
			"Pinned first, sits last",
		]);
		// pin_position is NOT part of the wire shape — the array order is.
		expect(result.pinned[0]).not.toHaveProperty("pinPosition");
	});

	describe("reorderPinned", () => {
		// One test seeds a highlight; the shared beforeEach truncates bookmarks,
		// which the highlights FK would block.
		afterEach(async () => {
			await db.execute(sql`DELETE FROM smultron.highlights`);
		});

		async function seedThree() {
			return seedShelf(USER_A, [
				{ title: "A", pinnedAt: T0, pinPosition: 0 },
				{
					title: "B",
					pinnedAt: new Date("2026-02-01T00:00:00.000Z"),
					pinPosition: 1,
				},
				{
					title: "C",
					pinnedAt: new Date("2026-03-01T00:00:00.000Z"),
					pinPosition: 2,
				},
			]);
		}

		it("a full permutation densifies 0..k-1 in list order", async () => {
			const ids = await seedThree();
			const before = await snapshot();

			const shelf = await reorderPinned(db, USER_A, [ids.C, ids.A, ids.B]);
			expect(shelf.map((b) => b.title)).toEqual(["C", "A", "B"]);
			expect((await rawRow(ids.C))?.pinPosition).toBe(0);
			expect((await rawRow(ids.A))?.pinPosition).toBe(1);
			expect((await rawRow(ids.B))?.pinPosition).toBe(2);

			// The listing agrees with what the reorder returned.
			const result = await listBookmarks(db, USER_A, {});
			expect(result.pinned.map((b) => b.title)).toEqual(["C", "A", "B"]);

			// Hard rule #1: neither clock moved.
			for (const [id, row] of await snapshot()) {
				expect(row.updatedAt).toEqual(before.get(id)?.updatedAt);
				expect(row.pinnedAt).toEqual(before.get(id)?.pinnedAt);
			}
		});

		it("a partial list puts the listed rows first, the rest trailing in their prior order", async () => {
			const ids = await seedThree();
			const shelf = await reorderPinned(db, USER_A, [ids.C]);
			expect(shelf.map((b) => b.title)).toEqual(["C", "A", "B"]);
			expect((await rawRow(ids.C))?.pinPosition).toBe(0);
			expect((await rawRow(ids.A))?.pinPosition).toBe(1);
			expect((await rawRow(ids.B))?.pinPosition).toBe(2);
		});

		it("ignores unpinned, archived and other users' ids, changing nothing else", async () => {
			const ids = await seedShelf(USER_A, [
				{ title: "A", pinnedAt: T0, pinPosition: 0 },
				{ title: "B", pinnedAt: T0, pinPosition: 1 },
				{ title: "Loose", pinnedAt: null },
				{ title: "Archived", archivedAt: T0 },
			]);
			const other = await seedShelf(USER_B, [
				{ title: "B's pin", pinnedAt: T0, pinPosition: 0 },
				{ title: "B's other pin", pinnedAt: T0, pinPosition: 1 },
			]);
			const before = await snapshot();

			const shelf = await reorderPinned(db, USER_A, [
				ids.Loose,
				ids.Archived,
				other["B's other pin"],
				999_999,
				ids.B,
				ids.A,
			]);
			expect(shelf.map((b) => b.title)).toEqual(["B", "A"]);
			expect((await rawRow(ids.B))?.pinPosition).toBe(0);
			expect((await rawRow(ids.A))?.pinPosition).toBe(1);

			// Ignored rows keep their state exactly.
			const loose = await rawRow(ids.Loose);
			expect(loose?.pinnedAt).toBeNull();
			expect(loose?.pinPosition).toBeNull();
			const archivedRow = await rawRow(ids.Archived);
			expect(archivedRow?.archivedAt).toEqual(T0);
			expect(archivedRow?.pinPosition).toBeNull();
			// User B's shelf is untouched — order and clocks alike.
			expect((await rawRow(other["B's pin"]))?.pinPosition).toBe(0);
			expect((await rawRow(other["B's other pin"]))?.pinPosition).toBe(1);
			for (const [id, row] of await snapshot()) {
				expect(row.updatedAt).toEqual(before.get(id)?.updatedAt);
				expect(row.pinnedAt).toEqual(before.get(id)?.pinnedAt);
			}
		});

		it("de-duplicates repeated ids defensively", async () => {
			const ids = await seedThree();
			const shelf = await reorderPinned(db, USER_A, [
				ids.B,
				ids.B,
				ids.A,
				ids.B,
			]);
			expect(shelf.map((b) => b.title)).toEqual(["B", "A", "C"]);
			expect((await rawRow(ids.B))?.pinPosition).toBe(0);
			expect((await rawRow(ids.A))?.pinPosition).toBe(1);
			expect((await rawRow(ids.C))?.pinPosition).toBe(2);
		});

		it("returns the shelf with nested highlights, exactly like the listing", async () => {
			const ids = await seedThree();
			await db.insert(schema.highlights).values({
				userId: USER_A,
				bookmarkId: ids.B,
				text: "a snippet",
			});

			const shelf = await reorderPinned(db, USER_A, [ids.B]);
			expect(shelf[0]?.title).toBe("B");
			expect(shelf[0]?.highlights.map((h) => h.text)).toEqual(["a snippet"]);
			expect(shelf[1]?.highlights).toEqual([]);

			const result = await listBookmarks(db, USER_A, {});
			expect(result.pinned).toEqual(shelf);
		});

		it("an empty shelf is a no-op returning []", async () => {
			await seedShelf(USER_A, [{ title: "Not pinned" }]);
			expect(await reorderPinned(db, USER_A, [1, 2, 3])).toEqual([]);
		});
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
		"HTTPS://Example.com/article/?x=1&utm_source=tw&fbclid=abc#:~:text=frag";

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

		// Messy re-add: text-fragment directive + utm + trailing slash +
		// uppercase host all normalize down to the seeded url_normalized.
		const { bookmark, created } = await addBookmark(
			db,
			USER_A,
			"https://EXAMPLE.com/a/?utm_source=x#:~:text=frag",
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

// Migration 0012's data transform, on its own PGlite: every migration EXCEPT
// 0012 is applied first, old-style pinned rows (no pin_position) are seeded,
// then 0012 alone runs — the shape a real deploy has.
describe("migration 0012_pin-position data transform", () => {
	const MIGRATION_TAG = "0012_pin-position";
	const USER_1 = "44444444-4444-4444-8444-444444444444";
	const USER_2 = "55555555-5555-4555-8555-555555555555";

	let migClient: PGlite;

	async function applyMigrationFile(tag: string) {
		const migration = readFileSync(join(drizzleDir, `${tag}.sql`), "utf8");
		for (const statement of migration.split("--> statement-breakpoint")) {
			await migClient.exec(statement);
		}
	}

	async function seedOld(
		userId: string,
		url: string,
		pinnedAt: string | null,
	): Promise<number> {
		const res = await migClient.query<{ id: number }>(
			`INSERT INTO smultron.bookmarks (user_id, url, url_normalized, title, tags, created_at, updated_at, pinned_at)
			 VALUES ($1, $2, $2, 't', '{}', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', $3)
			 RETURNING id`,
			[userId, url, pinnedAt],
		);
		return res.rows[0].id;
	}

	async function rowOf(id: number) {
		const res = await migClient.query<{
			pin_position: number | null;
			same_clocks: boolean;
		}>(
			`SELECT pin_position,
			        (updated_at = '2024-01-01T00:00:00Z'::timestamptz) AS same_clocks
			 FROM smultron.bookmarks WHERE id = $1`,
			[id],
		);
		// A data migration is not a live capture (Hard rule #1).
		expect(res.rows[0].same_clocks).toBe(true);
		return res.rows[0].pin_position;
	}

	beforeAll(async () => {
		migClient = new PGlite({ extensions: { pg_trgm } });
		await migClient.exec(
			"CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);",
		);
		const journal = JSON.parse(
			readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"),
		) as { entries: Array<{ tag: string }> };
		for (const entry of journal.entries) {
			if (entry.tag === MIGRATION_TAG) continue;
			await applyMigrationFile(entry.tag);
		}
		await migClient.exec(
			`INSERT INTO auth.users (id) VALUES ('${USER_1}'), ('${USER_2}');`,
		);
	});

	afterAll(async () => {
		await migClient.close();
	});

	it("seats each user's existing pins in their m13 order and leaves the rest null", async () => {
		// USER_1: three pins, seeded out of pinned_at order.
		const oldest = await seedOld(USER_1, "https://a.com/1", "2026-01-01Z");
		const newest = await seedOld(USER_1, "https://a.com/2", "2026-03-01Z");
		const middle = await seedOld(USER_1, "https://a.com/3", "2026-02-01Z");
		// A tie on pinned_at breaks by id desc, like the m13 shelf query.
		const tieOld = await seedOld(USER_1, "https://a.com/4", "2025-01-01Z");
		const tieNew = await seedOld(USER_1, "https://a.com/5", "2025-01-01Z");
		const unpinned = await seedOld(USER_1, "https://a.com/6", null);
		// A second user's shelf is numbered independently, from 0.
		const otherPin = await seedOld(USER_2, "https://b.com/1", "2026-01-01Z");
		const otherPin2 = await seedOld(USER_2, "https://b.com/2", "2026-02-01Z");

		await applyMigrationFile(MIGRATION_TAG);

		// pinned_at desc, id desc — exactly what the m13 shelf showed.
		expect(await rowOf(newest)).toBe(0);
		expect(await rowOf(middle)).toBe(1);
		expect(await rowOf(oldest)).toBe(2);
		expect(await rowOf(tieNew)).toBe(3);
		expect(await rowOf(tieOld)).toBe(4);
		expect(await rowOf(unpinned)).toBeNull();
		expect(await rowOf(otherPin2)).toBe(0);
		expect(await rowOf(otherPin)).toBe(1);

		// The CHECK is live afterwards, in both directions.
		await expect(
			migClient.query(
				"UPDATE smultron.bookmarks SET pin_position = NULL WHERE id = $1",
				[newest],
			),
		).rejects.toThrow(/bookmarks_pin_position_check/);
		await expect(
			migClient.query(
				"UPDATE smultron.bookmarks SET pin_position = 7 WHERE id = $1",
				[unpinned],
			),
		).rejects.toThrow(/bookmarks_pin_position_check/);
	});
});
