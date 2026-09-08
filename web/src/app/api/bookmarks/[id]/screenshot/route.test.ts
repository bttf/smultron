// DELETE /api/bookmarks/:id/screenshot — SPEC §15.2 (RED-206).
//
// Real Postgres (PGlite with the production migrations, the sync.test.ts
// harness) so the UPDATE, its user scoping and hard rule #1 are exercised as
// written. Only the session lookup and Supabase Storage are faked: the first
// has no HTTP surface to drive here, the second is covered in storage.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as schema from "../../../../../db/schema";
import { bookmarks } from "../../../../../db/schema";

const SHOT_BASE =
	"https://project.supabase.co/storage/v1/object/public/bookmark-screenshots/";

const mocks = vi.hoisted(() => ({
	// biome-ignore lint/suspicious/noExplicitAny: the PGlite drizzle instance is installed after the mock is registered.
	dbRef: { current: null as any },
	user: { current: null as { id: string } | null },
	deleteScreenshot: vi.fn(async (_path: string) => {}),
}));

// Mirrors the production lazy-singleton proxy (src/db/index.ts).
vi.mock("../../../../../db", () => ({
	db: new Proxy(
		{},
		{
			get(_target, prop, receiver) {
				return Reflect.get(mocks.dbRef.current as object, prop, receiver);
			},
		},
	),
}));

vi.mock("../../../../../lib/auth", () => ({
	getAuthedUser: async () => mocks.user.current,
}));

vi.mock("../../../../../lib/storage", () => ({
	screenshotPublicBase: () => SHOT_BASE,
	deleteScreenshot: mocks.deleteScreenshot,
}));

const { DELETE } = await import("./route");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const URL_A = "https://example.com/article";
const SHOT_PATH = `${USER_A}/1/0123456789abcdef0123456789abcdef.jpg`;
const SAVED_AT = new Date("2026-02-02T03:04:05.678Z");

const drizzleDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../../../drizzle",
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
	mocks.dbRef.current = db;
});

afterAll(async () => {
	await client.close();
});

beforeEach(async () => {
	await db.execute(sql`DELETE FROM smultron.bookmarks`);
	mocks.user.current = { id: USER_A };
	mocks.deleteScreenshot.mockReset();
	mocks.deleteScreenshot.mockResolvedValue(undefined);
});

async function seedBookmark(
	options: { userId?: string; screenshotPath?: string | null } = {},
): Promise<number> {
	const [row] = await db
		.insert(bookmarks)
		.values({
			userId: options.userId ?? USER_A,
			url: URL_A,
			urlNormalized: URL_A,
			title: "Article",
			tags: ["t"],
			faviconUrl: "https://example.com/icon.png",
			createdAt: SAVED_AT,
			updatedAt: SAVED_AT,
			pinnedAt: SAVED_AT,
			pinPosition: 0,
			// `??` would swallow an explicit null — the point of the option.
			screenshotPath:
				"screenshotPath" in options ? options.screenshotPath : SHOT_PATH,
		})
		.returning({ id: bookmarks.id });
	return row.id;
}

async function rawRow(id: number) {
	const [row] = await db.select().from(bookmarks).where(eq(bookmarks.id, id));
	return row;
}

function del(id: number | string): Promise<Response> {
	return DELETE(
		new Request(`http://localhost:3000/api/bookmarks/${id}/screenshot`, {
			method: "DELETE",
		}),
		{ params: Promise.resolve({ id: String(id) }) },
	);
}

describe("auth and addressing", () => {
	it("401s with no session", async () => {
		const id = await seedBookmark();
		mocks.user.current = null;

		const response = await del(id);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
		expect((await rawRow(id)).screenshotPath).toBe(SHOT_PATH);
		expect(mocks.deleteScreenshot).not.toHaveBeenCalled();
	});

	it("400s on an id that isn't a positive integer", async () => {
		const response = await del("abc");

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_id" });
	});

	it("404s — never 403 — for another user's bookmark", async () => {
		const id = await seedBookmark({ userId: USER_B });

		const response = await del(id);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
		expect((await rawRow(id)).screenshotPath).toBe(SHOT_PATH);
		expect(mocks.deleteScreenshot).not.toHaveBeenCalled();
	});

	it("404s for an id that doesn't exist", async () => {
		expect((await del(999_999)).status).toBe(404);
	});
});

describe("clearing", () => {
	it("nulls the path, deletes the object, and returns the bare row", async () => {
		const id = await seedBookmark();

		const response = await del(id);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			bookmark: Record<string, unknown>;
		};
		expect(body.bookmark).toMatchObject({ id, url: URL_A });
		expect(body.bookmark.screenshotUrl).toBeNull();
		expect(body.bookmark).not.toHaveProperty("screenshotPath");
		expect(body.bookmark).not.toHaveProperty("highlights");
		expect(mocks.deleteScreenshot).toHaveBeenCalledWith(SHOT_PATH);
		expect((await rawRow(id)).screenshotPath).toBeNull();
	});

	it("is idempotent: a row with no screenshot answers 200, untouched", async () => {
		const id = await seedBookmark({ screenshotPath: null });

		const response = await del(id);

		expect(response.status).toBe(200);
		const { bookmark } = (await response.json()) as {
			bookmark: { screenshotUrl: string | null };
		};
		expect(bookmark.screenshotUrl).toBeNull();
		// Nothing was stored, so nothing is deleted.
		expect(mocks.deleteScreenshot).not.toHaveBeenCalled();
	});

	// Hard rule #1 — removing a screenshot is enrichment in reverse, never a
	// live capture.
	it("writes screenshot_path and nothing else", async () => {
		const id = await seedBookmark();
		const before = await rawRow(id);

		await del(id);

		const after = await rawRow(id);
		expect({ ...after, screenshotPath: null }).toEqual({
			...before,
			screenshotPath: null,
		});
		expect(after.updatedAt).toEqual(SAVED_AT);
		expect(after.pinnedAt).toEqual(SAVED_AT);
		expect(after.pinPosition).toBe(0);
	});

	it("still succeeds when the Storage delete fails", async () => {
		const id = await seedBookmark();
		mocks.deleteScreenshot.mockRejectedValue(new Error("storage is down"));

		const response = await del(id);

		// The row is what the user asked to change; an unreferenced object left
		// behind in Storage is not their problem.
		expect(response.status).toBe(200);
		expect((await rawRow(id)).screenshotPath).toBeNull();
	});
});
