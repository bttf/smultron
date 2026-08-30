// applyHighlight/deleteHighlight tests against REAL Postgres semantics: an
// in-memory PGlite database with the production migrations from web/drizzle/
// applied in journal order (same harness as sync.test.ts / bookmarks.test.ts).
// Covers the AGENTS.md-mandated highlight semantics: insert + bump +
// unarchive, the no-bookmark (409) path, normalization matching, duplicate
// texts, created_at-asc nesting in listBookmarks, and ownership-checked
// hard delete.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { bookmarks, highlights } from "../db/schema";
import { listBookmarks } from "./bookmarks";
import { applyHighlight, deleteHighlight } from "./highlights";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

// A fixed past instant so "bump moves updated_at" is unambiguous.
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
	// highlights first: it has an FK to bookmarks.
	await db.execute(sql`DELETE FROM smultron.highlights`);
	await db.execute(sql`DELETE FROM smultron.bookmarks`);
});

type SeedBookmark = {
	userId: string;
	url: string;
	/** Stored dedupe key — pass the ALREADY-normalized form. */
	urlNormalized: string;
	title?: string;
	tags?: string[];
	archivedAt?: Date | null;
	pinnedAt?: Date | null;
};

async function seedBookmark(row: SeedBookmark) {
	const inserted = await db
		.insert(bookmarks)
		.values({
			userId: row.userId,
			url: row.url,
			urlNormalized: row.urlNormalized,
			title: row.title ?? "A title",
			chromeId: "c1",
			tags: row.tags ?? ["Bookmarks Bar/Dev"],
			createdAt: PAST,
			updatedAt: PAST,
			archivedAt: row.archivedAt ?? null,
			pinnedAt: row.pinnedAt ?? null,
			// m21: a pinned row always carries a slot (a CHECK constraint).
			pinPosition: row.pinnedAt ? 0 : null,
		})
		.returning();
	const bookmark = inserted[0];
	if (!bookmark) {
		throw new Error("seed failed");
	}
	return bookmark;
}

async function rawBookmark(id: number) {
	const rows = await db.select().from(bookmarks).where(eq(bookmarks.id, id));
	const row = rows[0];
	if (!row) {
		throw new Error(`bookmark ${id} not found`);
	}
	return row;
}

async function allHighlights() {
	const rows = await db.select().from(highlights);
	return rows.sort((a, b) => a.id - b.id);
}

function expectRecent(d: Date) {
	expect(Math.abs(d.getTime() - Date.now())).toBeLessThan(10_000);
}

describe("applyHighlight", () => {
	it("inserts the highlight and bumps + unarchives an archived bookmark; title/tags/created_at untouched", async () => {
		const before = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
			archivedAt: new Date("2025-06-01T00:00:00.000Z"),
		});

		const created = await applyHighlight(db, USER_A, {
			url: "https://a.com/x",
			text: "a memorable snippet",
		});

		// Returned shape (SPEC §8): {id, bookmarkId, text, createdAt}.
		expect(created).not.toBeNull();
		expect(created?.bookmarkId).toBe(before.id);
		expect(created?.text).toBe("a memorable snippet");
		expectRecent(created?.createdAt as Date);

		// The row itself, with ownership recorded.
		const rows = await allHighlights();
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(created?.id);
		expect(rows[0].userId).toBe(USER_A);
		expect(rows[0].bookmarkId).toBe(before.id);
		expect(rows[0].text).toBe("a memorable snippet");

		// Live-capture semantics on the bookmark (§5): bump + unarchive only.
		const after = await rawBookmark(before.id);
		expect(after.archivedAt).toBeNull();
		expectRecent(after.updatedAt);
		expect(after.updatedAt.getTime()).toBeGreaterThan(
			before.updatedAt.getTime(),
		);
		// Byte-identical everything else.
		expect(after.title).toBe(before.title);
		expect(after.tags).toEqual(before.tags);
		expect(after.createdAt).toEqual(before.createdAt);
		expect(after.url).toBe(before.url);
		expect(after.urlNormalized).toBe(before.urlNormalized);
		expect(after.chromeId).toBe(before.chromeId);
	});

	it("live (non-archived) bookmark: archived_at stays null, updated_at still bumps", async () => {
		const before = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
		});
		expect(before.archivedAt).toBeNull();

		const created = await applyHighlight(db, USER_A, {
			url: "https://a.com/x",
			text: "snippet",
		});
		expect(created).not.toBeNull();

		const after = await rawBookmark(before.id);
		expect(after.archivedAt).toBeNull();
		expect(after.updatedAt.getTime()).toBeGreaterThan(
			before.updatedAt.getTime(),
		);
	});

	it("keeps pinned_at intact while bumping (pins are site-owned, m13)", async () => {
		const pinTime = new Date("2026-02-01T00:00:00.000Z");
		const before = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
			pinnedAt: pinTime,
		});

		const created = await applyHighlight(db, USER_A, {
			url: "https://a.com/x",
			text: "snippet",
		});
		expect(created).not.toBeNull();

		const after = await rawBookmark(before.id);
		expect(after.pinnedAt).toEqual(pinTime);
		expect(after.updatedAt.getTime()).toBeGreaterThan(
			before.updatedAt.getTime(),
		);
	});

	it("matches a raw variant URL (tracking params/fragment/case) via normalization", async () => {
		const bookmark = await seedBookmark({
			userId: USER_A,
			url: "https://Example.com/Page/?utm_source=nl&x=1#frag",
			// What applySync would have stored for that raw URL.
			urlNormalized: "https://example.com/Page?x=1",
		});

		const created = await applyHighlight(db, USER_A, {
			// A DIFFERENT raw spelling of the same page.
			url: "https://EXAMPLE.com/Page?x=1&fbclid=abc#other",
			text: "matched through normalization",
		});

		expect(created?.bookmarkId).toBe(bookmark.id);
		expect(await allHighlights()).toHaveLength(1);
	});

	it("missing bookmark: returns null, writes NO rows, touches NO bookmark", async () => {
		const other = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
		});

		const result = await applyHighlight(db, USER_A, {
			url: "https://never-bookmarked.com/page",
			text: "orphan snippet",
		});

		expect(result).toBeNull();
		expect(await allHighlights()).toHaveLength(0);
		// The unrelated bookmark is byte-identical (no bump, no unarchive).
		const after = await rawBookmark(other.id);
		expect(after).toEqual(other);
	});

	it("allows duplicate texts on the same bookmark (no unique constraint)", async () => {
		const bookmark = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
		});

		const first = await applyHighlight(db, USER_A, {
			url: "https://a.com/x",
			text: "same text",
		});
		const second = await applyHighlight(db, USER_A, {
			url: "https://a.com/x",
			text: "same text",
		});

		expect(first?.id).not.toBe(second?.id);
		const rows = await allHighlights();
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.bookmarkId === bookmark.id)).toBe(true);
		expect(rows.every((r) => r.text === "same text")).toBe(true);
	});

	it("attaches to the requesting user's bookmark, not another user's same-URL row", async () => {
		const rowA = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
		});
		const rowB = await seedBookmark({
			userId: USER_B,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
		});

		const created = await applyHighlight(db, USER_B, {
			url: "https://a.com/x",
			text: "B's snippet",
		});

		expect(created?.bookmarkId).toBe(rowB.id);
		// A's bookmark untouched by B's capture.
		const afterA = await rawBookmark(rowA.id);
		expect(afterA).toEqual(rowA);
	});
});

describe("listBookmarks — nested highlights", () => {
	it("returns each bookmark's highlights ordered created_at asc, as {id, text, createdAt}", async () => {
		const bookmark = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
		});

		// Insert out of chronological order to prove the ORDER BY.
		const t1 = new Date("2025-01-01T00:00:00.000Z");
		const t2 = new Date("2025-02-01T00:00:00.000Z");
		const t3 = new Date("2025-03-01T00:00:00.000Z");
		await db.insert(highlights).values([
			{
				userId: USER_A,
				bookmarkId: bookmark.id,
				text: "second",
				createdAt: t2,
			},
			{ userId: USER_A, bookmarkId: bookmark.id, text: "third", createdAt: t3 },
			{ userId: USER_A, bookmarkId: bookmark.id, text: "first", createdAt: t1 },
		]);

		const { bookmarks: rows } = await listBookmarks(db, USER_A, {});
		expect(rows).toHaveLength(1);
		// toEqual is exact: proves the nested shape has ONLY id/text/createdAt.
		expect(rows[0]?.highlights).toEqual([
			{ id: expect.any(Number), text: "first", createdAt: t1 },
			{ id: expect.any(Number), text: "second", createdAt: t2 },
			{ id: expect.any(Number), text: "third", createdAt: t3 },
		]);
	});

	it("bookmarks with zero highlights get highlights: []", async () => {
		const withHighlight = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
		});
		await seedBookmark({
			userId: USER_A,
			url: "https://b.com/y",
			urlNormalized: "https://b.com/y",
		});
		await db.insert(highlights).values({
			userId: USER_A,
			bookmarkId: withHighlight.id,
			text: "only here",
		});

		const { bookmarks: rows } = await listBookmarks(db, USER_A, {});
		expect(rows).toHaveLength(2);
		const bare = rows.find((r) => r.id !== withHighlight.id);
		const hydrated = rows.find((r) => r.id === withHighlight.id);
		expect(bare?.highlights).toEqual([]);
		expect(hydrated?.highlights.map((h) => h.text)).toEqual(["only here"]);
	});

	it("the search branch nests highlights too", async () => {
		const bookmark = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/pg",
			urlNormalized: "https://a.com/pg",
			title: "PostgreSQL Tutorial",
		});
		await db.insert(highlights).values({
			userId: USER_A,
			bookmarkId: bookmark.id,
			text: "MVCC explained",
		});

		const { bookmarks: rows } = await listBookmarks(db, USER_A, {
			q: "postgresql",
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.highlights.map((h) => h.text)).toEqual(["MVCC explained"]);
	});

	it("user B never sees user A's highlights (or bookmarks)", async () => {
		const rowA = await seedBookmark({
			userId: USER_A,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
		});
		await db.insert(highlights).values({
			userId: USER_A,
			bookmarkId: rowA.id,
			text: "A's private snippet",
		});
		await seedBookmark({
			userId: USER_B,
			url: "https://b.com/y",
			urlNormalized: "https://b.com/y",
		});

		const { bookmarks: rows } = await listBookmarks(db, USER_B, {});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.urlNormalized).toBe("https://b.com/y");
		expect(rows[0]?.highlights).toEqual([]);
	});
});

describe("deleteHighlight", () => {
	async function seedHighlight(userId: string) {
		const bookmark = await seedBookmark({
			userId,
			url: "https://a.com/x",
			urlNormalized: "https://a.com/x",
		});
		const inserted = await db
			.insert(highlights)
			.values({ userId, bookmarkId: bookmark.id, text: "snippet" })
			.returning();
		const highlight = inserted[0];
		if (!highlight) {
			throw new Error("seed failed");
		}
		return highlight;
	}

	it("hard-deletes the row and returns true; a second delete returns false", async () => {
		const highlight = await seedHighlight(USER_A);

		expect(await deleteHighlight(db, USER_A, highlight.id)).toBe(true);
		expect(await allHighlights()).toHaveLength(0);

		expect(await deleteHighlight(db, USER_A, highlight.id)).toBe(false);
	});

	it("returns false for a nonexistent id", async () => {
		expect(await deleteHighlight(db, USER_A, 999_999)).toBe(false);
	});

	it("enforces ownership: user B cannot delete user A's highlight", async () => {
		const highlight = await seedHighlight(USER_A);

		expect(await deleteHighlight(db, USER_B, highlight.id)).toBe(false);
		expect(await allHighlights()).toHaveLength(1);
	});
});
