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
	type Bookmark,
	InvalidCursorError,
	listBookmarks,
	patchBookmark,
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
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date | null;
};

async function seed(rows: SeedRow[]) {
	await db.insert(bookmarks).values(
		rows.map((r) => ({
			userId: r.userId,
			url: r.url,
			urlNormalized: r.url,
			title: r.title,
			tags: r.tags ?? [],
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
			archivedAt: r.archivedAt ?? null,
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

describe("patchBookmark", () => {
	async function seedOne(userId: string): Promise<Bookmark> {
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
