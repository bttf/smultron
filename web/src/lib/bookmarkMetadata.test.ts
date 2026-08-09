// enrichBookmarkMetadata semantics (m17, SPEC §5) against REAL Postgres:
// PGlite with the production migrations from web/drizzle/ applied in journal
// order (same harness as bookmarks.test.ts / sync.test.ts). The Firecrawl call
// is injected, so nothing here touches the network.
//
// What must hold, in order of how much a regression would cost:
//   1. the fill NEVER bumps bookmarks.updated_at (Hard rule #1)
//   2. it never overwrites a title the user (or Chrome) owns, and never a note
//      they wrote — the summary only ever seeds a NULL note
//   3. it never throws, whatever the fetch does
//   4. it doesn't scrape when there is nothing left to fill — and a missing
//      note alone is never a reason to scrape (a deleted seed stays deleted)
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
import { enrichBookmarkMetadata, settleWithin } from "./bookmarkMetadata";
import { addBookmark } from "./bookmarks";
import type { PageMetadata } from "./firecrawl";
import { PipelineError } from "./pipelineError";

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

const PAGE: PageMetadata = {
	title: "The Real Page Title",
	faviconUrl: "https://example.com/icon.png",
	summary: "What the page is about, in a sentence.",
};

/** A fetcher returning `metadata`, recording how often it was called. */
function stubFetcher(metadata: PageMetadata = PAGE) {
	const calls: string[] = [];
	return {
		calls,
		fetch: async (url: string) => {
			calls.push(url);
			return metadata;
		},
	};
}

async function rawRow(id: number) {
	const rows = await db.select().from(bookmarks).where(eq(bookmarks.id, id));
	return rows[0];
}

/** A web-added row: hostname title, no favicon — exactly what m17 fills. */
async function webAdd(url = "https://example.com/post") {
	const { bookmark } = await addBookmark(db, USER_A, url);
	return bookmark;
}

describe("enrichBookmarkMetadata", () => {
	it("fills title + favicon and seeds the note on a web-added row", async () => {
		const bookmark = await webAdd();
		expect(bookmark.title).toBe("example.com");
		expect(bookmark.faviconUrl).toBeNull();
		expect(bookmark.note).toBeNull();

		const fetcher = stubFetcher();
		const filled = await enrichBookmarkMetadata(db, fetcher.fetch, {
			userId: USER_A,
			bookmarkId: bookmark.id,
		});

		expect(fetcher.calls).toEqual(["https://example.com/post"]);
		expect(filled?.title).toBe("The Real Page Title");
		expect(filled?.faviconUrl).toBe("https://example.com/icon.png");
		expect(filled?.note).toBe("What the page is about, in a sentence.");

		const stored = await rawRow(bookmark.id);
		expect(stored?.title).toBe("The Real Page Title");
		expect(stored?.faviconUrl).toBe("https://example.com/icon.png");
		expect(stored?.note).toBe("What the page is about, in a sentence.");
	});

	it("NEVER bumps updated_at (Hard rule #1) — or any other column", async () => {
		const bookmark = await webAdd();
		const before = await rawRow(bookmark.id);

		const fetcher = stubFetcher();
		await enrichBookmarkMetadata(db, fetcher.fetch, {
			userId: USER_A,
			bookmarkId: bookmark.id,
		});

		const after = await rawRow(bookmark.id);
		// The write definitely happened — title, favicon AND the note seed.
		expect(after?.title).toBe("The Real Page Title");
		expect(after?.note).toBe("What the page is about, in a sentence.");
		expect(after?.updatedAt).toEqual(before?.updatedAt);
		expect(after?.createdAt).toEqual(before?.createdAt);
		expect(after?.url).toBe(before?.url);
		expect(after?.urlNormalized).toBe(before?.urlNormalized);
		expect(after?.tags).toEqual(before?.tags);
		expect(after?.archivedAt).toEqual(before?.archivedAt);
		expect(after?.pinnedAt).toEqual(before?.pinnedAt);
	});

	it("leaves a user-owned title alone but still fills the favicon", async () => {
		const bookmark = await webAdd();
		await db
			.update(bookmarks)
			.set({ title: "My own words" })
			.where(eq(bookmarks.id, bookmark.id));

		const fetcher = stubFetcher();
		const filled = await enrichBookmarkMetadata(db, fetcher.fetch, {
			userId: USER_A,
			bookmarkId: bookmark.id,
		});

		expect(fetcher.calls).toHaveLength(1);
		expect(filled?.title).toBe("My own words");
		expect(filled?.faviconUrl).toBe("https://example.com/icon.png");
	});

	it("fills an empty title (a Chrome capture that never had one)", async () => {
		const bookmark = await webAdd();
		await db
			.update(bookmarks)
			.set({ title: "" })
			.where(eq(bookmarks.id, bookmark.id));

		const fetcher = stubFetcher();
		const filled = await enrichBookmarkMetadata(db, fetcher.fetch, {
			userId: USER_A,
			bookmarkId: bookmark.id,
		});

		expect(filled?.title).toBe("The Real Page Title");
	});

	it("does not scrape when the row already has a real title and a favicon", async () => {
		const bookmark = await webAdd();
		await db
			.update(bookmarks)
			.set({ title: "Already known", faviconUrl: "https://example.com/i.ico" })
			.where(eq(bookmarks.id, bookmark.id));

		const fetcher = stubFetcher();
		const filled = await enrichBookmarkMetadata(db, fetcher.fetch, {
			userId: USER_A,
			bookmarkId: bookmark.id,
		});

		// Re-adding an already-filled URL must not cost a scrape (or a wait) —
		// and a NULL note is not a reason to spend one, so nothing is seeded:
		// a seeded note the user deleted must stay deleted on re-add (SPEC §5).
		expect(fetcher.calls).toEqual([]);
		expect(filled?.title).toBe("Already known");
		expect(filled?.faviconUrl).toBe("https://example.com/i.ico");
		expect(filled?.note).toBeNull();
		expect((await rawRow(bookmark.id))?.note).toBeNull();
	});

	it("keeps the existing favicon when only the title is missing", async () => {
		const bookmark = await webAdd();
		await db
			.update(bookmarks)
			.set({ faviconUrl: "https://example.com/mine.ico" })
			.where(eq(bookmarks.id, bookmark.id));

		const filled = await enrichBookmarkMetadata(db, stubFetcher().fetch, {
			userId: USER_A,
			bookmarkId: bookmark.id,
		});

		expect(filled?.title).toBe("The Real Page Title");
		expect(filled?.faviconUrl).toBe("https://example.com/mine.ico");
	});

	it("returns the row unchanged when the scrape fails, and never throws", async () => {
		const bookmark = await webAdd();

		const filled = await enrichBookmarkMetadata(
			db,
			async () => {
				throw new PipelineError("scrape", "rate_limited", "slow down", {
					retryable: true,
				});
			},
			{ userId: USER_A, bookmarkId: bookmark.id },
		);

		expect(filled?.title).toBe("example.com");
		expect(filled?.faviconUrl).toBeNull();
		const stored = await rawRow(bookmark.id);
		expect(stored?.title).toBe("example.com");
	});

	it("returns the row unchanged when the page offers nothing at all", async () => {
		const bookmark = await webAdd();

		const filled = await enrichBookmarkMetadata(
			db,
			stubFetcher({ title: null, faviconUrl: null, summary: null }).fetch,
			{ userId: USER_A, bookmarkId: bookmark.id },
		);

		expect(filled?.title).toBe("example.com");
		expect(filled?.faviconUrl).toBeNull();
		expect(filled?.note).toBeNull();
	});

	it("is user-scoped: another user's bookmark is neither read nor written", async () => {
		const bookmark = await webAdd();

		const fetcher = stubFetcher();
		const filled = await enrichBookmarkMetadata(db, fetcher.fetch, {
			userId: USER_B,
			bookmarkId: bookmark.id,
		});

		expect(filled).toBeNull();
		expect(fetcher.calls).toEqual([]);
		const stored = await rawRow(bookmark.id);
		expect(stored?.title).toBe("example.com");
		expect(stored?.faviconUrl).toBeNull();
	});

	it("returns null for a bookmark that doesn't exist", async () => {
		const filled = await enrichBookmarkMetadata(db, stubFetcher().fetch, {
			userId: USER_A,
			bookmarkId: 987_654,
		});
		expect(filled).toBeNull();
	});

	it("loses the race to a title edit made while the fetch was in flight", async () => {
		const bookmark = await webAdd();

		// The fetch is slow; the user renames the row before it comes back. The
		// write-time CASE guard must see the new title and leave it alone.
		const filled = await enrichBookmarkMetadata(
			db,
			async () => {
				await db
					.update(bookmarks)
					.set({ title: "Renamed mid-flight" })
					.where(eq(bookmarks.id, bookmark.id));
				return PAGE;
			},
			{ userId: USER_A, bookmarkId: bookmark.id },
		);

		expect(filled?.title).toBe("Renamed mid-flight");
		// The favicon had no competing write, so it still lands.
		expect(filled?.faviconUrl).toBe("https://example.com/icon.png");
	});

	it("never overwrites a note the user already wrote", async () => {
		const bookmark = await webAdd();
		await db
			.update(bookmarks)
			.set({ note: "My own thoughts" })
			.where(eq(bookmarks.id, bookmark.id));

		const filled = await enrichBookmarkMetadata(db, stubFetcher().fetch, {
			userId: USER_A,
			bookmarkId: bookmark.id,
		});

		// The scrape still happened (title + favicon were missing) and still
		// filled those — the note is simply left alone.
		expect(filled?.note).toBe("My own thoughts");
		expect(filled?.title).toBe("The Real Page Title");
		expect((await rawRow(bookmark.id))?.note).toBe("My own thoughts");
	});

	it("loses the race to a note written while the fetch was in flight", async () => {
		const bookmark = await webAdd();

		// Same shape as the title race: the write-time guard must see the note
		// that appeared mid-flight and leave it standing.
		const filled = await enrichBookmarkMetadata(
			db,
			async () => {
				await db
					.update(bookmarks)
					.set({ note: "Typed while it was loading" })
					.where(eq(bookmarks.id, bookmark.id));
				return PAGE;
			},
			{ userId: USER_A, bookmarkId: bookmark.id },
		);

		expect(filled?.note).toBe("Typed while it was loading");
		// Nothing raced the title or the favicon, so those still land.
		expect(filled?.title).toBe("The Real Page Title");
		expect(filled?.faviconUrl).toBe("https://example.com/icon.png");
	});

	it("seeds nothing from an empty or whitespace-only summary", async () => {
		const bookmark = await webAdd();

		const filled = await enrichBookmarkMetadata(
			db,
			stubFetcher({ ...PAGE, summary: "   \n  " }).fetch,
			{ userId: USER_A, bookmarkId: bookmark.id },
		);

		expect(filled?.note).toBeNull();
		expect(filled?.title).toBe("The Real Page Title");
	});

	it("seeds the note even when the title is the only other thing missing", async () => {
		const bookmark = await webAdd();
		await db
			.update(bookmarks)
			.set({ title: "My own words" })
			.where(eq(bookmarks.id, bookmark.id));

		const filled = await enrichBookmarkMetadata(db, stubFetcher().fetch, {
			userId: USER_A,
			bookmarkId: bookmark.id,
		});

		expect(filled?.title).toBe("My own words");
		expect(filled?.note).toBe("What the page is about, in a sentence.");
	});

	it("truncates a summary past the note's 10 000-char limit", async () => {
		const bookmark = await webAdd();

		const filled = await enrichBookmarkMetadata(
			db,
			stubFetcher({ ...PAGE, summary: "s".repeat(10_500) }).fetch,
			{ userId: USER_A, bookmarkId: bookmark.id },
		);

		expect(filled?.note).toBe("s".repeat(10_000));
		expect((await rawRow(bookmark.id))?.note).toHaveLength(10_000);
	});

	it("fills a re-added bookmark that predates the metadata fill", async () => {
		// A row saved before m17: hostname title, no favicon. Re-adding it (the
		// §5 bump+unarchive path) gets it filled in.
		const first = await webAdd();
		const { bookmark: again, created } = await addBookmark(
			db,
			USER_A,
			"https://example.com/post",
		);
		expect(created).toBe(false);
		expect(again.id).toBe(first.id);

		const filled = await enrichBookmarkMetadata(db, stubFetcher().fetch, {
			userId: USER_A,
			bookmarkId: again.id,
		});
		expect(filled?.title).toBe("The Real Page Title");
	});
});

describe("settleWithin", () => {
	it("returns the value when the promise wins", async () => {
		expect(await settleWithin(Promise.resolve("done"), 1000)).toBe("done");
	});

	it("returns undefined once the deadline passes (the promise keeps running)", async () => {
		let finished = false;
		const slow = new Promise<string>((resolve) => {
			setTimeout(() => {
				finished = true;
				resolve("late");
			}, 50);
		});

		expect(await settleWithin(slow, 5)).toBeUndefined();
		expect(finished).toBe(false);
		// The caller hands `slow` to after(); it still completes.
		expect(await slow).toBe("late");
		expect(finished).toBe(true);
	});

	it("returns undefined rather than rejecting when the promise rejects", async () => {
		const rejected = Promise.reject(new Error("boom"));
		expect(await settleWithin(rejected, 1000)).toBeUndefined();
	});
});
