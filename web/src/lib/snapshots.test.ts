// createSnapshot's bookmark upsert (m25, SPEC §17.8 / §17.10) against REAL
// Postgres semantics: an in-memory PGlite database with the production
// migrations from web/drizzle/ applied in journal order, plus a stubbed
// auth.users (Supabase-managed in prod). Same harness as sync.test.ts.
//
// A snapshot create is a LIVE CAPTURE of its bookmark (Hard rule #1):
// insert, or on conflict bump `updated_at` + unarchive + fill `favicon_url`
// when null — and nothing else.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { bookmarks, snapshots } from "../db/schema";
import { addBookmark, listBookmarks, patchBookmark } from "./bookmarks";
import {
	type CreateSnapshotInput,
	createSnapshot,
	createSnapshotBodySchema,
} from "./snapshots";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const PAST = new Date("2024-01-15T12:00:00.000Z");

const drizzleDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../drizzle",
);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
	client = new PGlite({ extensions: { pg_trgm } });

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
	await db.execute(sql`DELETE FROM smultron.snapshots`);
	await db.execute(sql`DELETE FROM smultron.bookmarks`);
});

/** A valid manifest, parsed through the route's own schema. */
function manifest(
	overrides: Partial<Record<keyof CreateSnapshotInput, unknown>> = {},
): CreateSnapshotInput {
	return createSnapshotBodySchema.parse({
		url: "https://www.reddit.com/r/test/comments/abc/a_post/?utm_source=x",
		title: "A post",
		adapterId: "reddit-post",
		adapterVersion: "1",
		markdown: "# A post\n\nbody",
		metadata: { url: "https://www.reddit.com/r/test/comments/abc/a_post/" },
		capturedAt: "2026-10-01T10:00:00.000Z",
		assets: [
			{ kind: "html", idx: 0, mime: "text/html", byteSize: 10 },
			{
				kind: "screenshot",
				idx: 1,
				mime: "image/webp",
				byteSize: 20,
				width: 1280,
				height: 8000,
			},
			{
				kind: "screenshot",
				idx: 0,
				mime: "image/jpeg",
				byteSize: 30,
				width: 1280,
				height: 8000,
			},
			{ kind: "data", idx: 0, mime: "application/json", byteSize: 5 },
		],
		...overrides,
	});
}

async function bookmarkRows(userId?: string) {
	const rows = userId
		? await db.select().from(bookmarks).where(eq(bookmarks.userId, userId))
		: await db.select().from(bookmarks);
	return rows.sort((a, b) => a.id - b.id);
}

/** Seeds a bookmark the way an earlier capture would have left it. */
async function seedBookmark(values: Partial<typeof bookmarks.$inferInsert>) {
	const [row] = await db
		.insert(bookmarks)
		.values({
			userId: USER_A,
			url: "https://www.reddit.com/r/test/comments/abc/a_post/",
			urlNormalized: "https://www.reddit.com/r/test/comments/abc/a_post",
			title: "Owned title",
			tags: ["reddit", "keep"],
			createdAt: PAST,
			updatedAt: PAST,
			...values,
		})
		.returning();
	return row;
}

describe("createSnapshot bookmark upsert", () => {
	it("inserts a new bookmark as a live capture", async () => {
		const { snapshot } = await createSnapshot(
			db,
			USER_A,
			manifest({ faviconUrl: "https://www.reddit.com/favicon-32.png" }),
		);

		const [row] = await bookmarkRows();
		expect(row.userId).toBe(USER_A);
		// Raw URL stored untouched; the key is normalized server-side.
		expect(row.url).toBe(
			"https://www.reddit.com/r/test/comments/abc/a_post/?utm_source=x",
		);
		expect(row.urlNormalized).toBe(
			"https://www.reddit.com/r/test/comments/abc/a_post",
		);
		expect(row.title).toBe("A post");
		expect(row.tags).toEqual([]);
		expect(row.chromeId).toBeNull();
		expect(row.faviconUrl).toBe("https://www.reddit.com/favicon-32.png");
		expect(row.archivedAt).toBeNull();
		expect(row.pinnedAt).toBeNull();
		expect(row.updatedAt).toEqual(row.createdAt);
		expect(Math.abs(row.updatedAt.getTime() - Date.now())).toBeLessThan(10_000);
		expect(snapshot.bookmarkId).toBe(row.id);
	});

	it("stores an invalid favicon as null rather than failing", async () => {
		await createSnapshot(
			db,
			USER_A,
			manifest({ faviconUrl: "data:image/png;base64,AAAA" }),
		);
		const [row] = await bookmarkRows();
		expect(row.faviconUrl).toBeNull();
	});

	it("bumps and unarchives an existing bookmark, touching nothing else", async () => {
		const archivedAt = new Date("2025-06-01T00:00:00.000Z");
		const seeded = await seedBookmark({
			note: "a note",
			chromeId: "c9",
			screenshotPath: `${USER_A}/1/abc.jpg`,
			archivedAt,
		});

		await createSnapshot(
			db,
			USER_A,
			manifest({ title: "A different adapter title" }),
		);

		const rows = await bookmarkRows();
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row.id).toBe(seeded.id);
		expect(row.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
		expect(row.archivedAt).toBeNull();
		// Untouched on conflict.
		expect(row.title).toBe("Owned title");
		expect(row.tags).toEqual(["reddit", "keep"]);
		expect(row.url).toBe(seeded.url);
		expect(row.urlNormalized).toBe(seeded.urlNormalized);
		expect(row.note).toBe("a note");
		expect(row.chromeId).toBe("c9");
		expect(row.createdAt).toEqual(PAST);
		expect(row.screenshotPath).toBe(`${USER_A}/1/abc.jpg`);
	});

	it("keeps pins on conflict", async () => {
		const pinTime = new Date("2025-03-01T00:00:00.000Z");
		const seeded = await seedBookmark({ pinnedAt: pinTime, pinPosition: 3 });

		await createSnapshot(db, USER_A, manifest());

		const [row] = await bookmarkRows();
		expect(row.id).toBe(seeded.id);
		expect(row.pinnedAt).toEqual(pinTime);
		expect(row.pinPosition).toBe(3);
		expect(row.updatedAt.getTime()).toBeGreaterThan(PAST.getTime());
	});

	it("fills favicon_url only when null", async () => {
		await seedBookmark({ faviconUrl: null });
		await createSnapshot(
			db,
			USER_A,
			manifest({ faviconUrl: "https://www.reddit.com/first.png" }),
		);
		expect((await bookmarkRows())[0].faviconUrl).toBe(
			"https://www.reddit.com/first.png",
		);

		// A resolved icon is never overwritten...
		await createSnapshot(
			db,
			USER_A,
			manifest({ faviconUrl: "https://www.reddit.com/second.png" }),
		);
		expect((await bookmarkRows())[0].faviconUrl).toBe(
			"https://www.reddit.com/first.png",
		);

		// ...and a capture without one never erases it.
		await createSnapshot(db, USER_A, manifest());
		expect((await bookmarkRows())[0].faviconUrl).toBe(
			"https://www.reddit.com/first.png",
		);
	});

	it("is user-scoped: another user's bookmark is neither bumped nor reused", async () => {
		const other = await seedBookmark({ userId: USER_B, archivedAt: PAST });

		const { snapshot } = await createSnapshot(db, USER_A, manifest());

		const [b] = await bookmarkRows(USER_B);
		expect(b.id).toBe(other.id);
		expect(b.updatedAt).toEqual(PAST);
		expect(b.archivedAt).toEqual(PAST);
		expect(b.title).toBe("Owned title");

		const [a] = await bookmarkRows(USER_A);
		expect(a.id).not.toBe(other.id);
		expect(snapshot.bookmarkId).toBe(a.id);

		const [stored] = await db
			.select({ userId: snapshots.userId })
			.from(snapshots)
			.where(eq(snapshots.id, snapshot.id));
		expect(stored.userId).toBe(USER_A);
	});

	it("inserts the snapshot as uploading with server-assigned asset paths", async () => {
		const { snapshot, assets } = await createSnapshot(db, USER_A, manifest());

		expect(snapshot.status).toBe("uploading");
		expect(snapshot.adapterId).toBe("reddit-post");
		expect(snapshot.markdownChars).toBe("# A post\n\nbody".length);
		expect(snapshot.screenshotCount).toBe(2);
		expect(snapshot.capturedAt).toEqual(new Date("2026-10-01T10:00:00.000Z"));

		const folder = `${USER_A}/${snapshot.id}`;
		expect(assets.map((a) => a.path)).toEqual([
			`${folder}/screenshot-0.jpg`,
			`${folder}/screenshot-1.webp`,
			`${folder}/page.html`,
			`${folder}/data.json`,
		]);

		const [row] = await db
			.select({ assets: snapshots.assets })
			.from(snapshots)
			.where(eq(snapshots.id, snapshot.id));
		expect(row.assets).toEqual(assets);
	});

	it("counts snapshots on the bookmark rows of the listing", async () => {
		await createSnapshot(db, USER_A, manifest());
		await createSnapshot(db, USER_A, manifest());

		const listing = await listBookmarks(db, USER_A);
		expect(listing.bookmarks).toHaveLength(1);
		expect(listing.bookmarks[0].snapshotCount).toBe(2);

		const other = await listBookmarks(db, USER_B);
		expect(other.bookmarks).toHaveLength(0);

		// The count rides the shared column set, so INSERT/UPDATE … RETURNING
		// rows carry it too (the correlated subquery must bind to the outer
		// bookmark there, not to snapshots.id).
		const id = listing.bookmarks[0].id;
		const patched = await patchBookmark(db, USER_A, id, { note: "n" });
		expect(patched?.snapshotCount).toBe(2);
		const { bookmark } = await addBookmark(
			db,
			USER_A,
			"https://www.reddit.com/r/test/comments/abc/a_post/",
		);
		expect(bookmark.id).toBe(id);
		expect(bookmark.snapshotCount).toBe(2);
	});
});
