// listTags tests against REAL Postgres semantics: an in-memory PGlite
// database with the production migrations from web/drizzle/ applied in
// journal order, plus a stubbed auth.users (Supabase-managed in prod).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { bookmarks } from "../db/schema";
import { listTags } from "./tags";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const NOW = new Date("2024-06-01T00:00:00.000Z");

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

let seq = 0;

async function insert(
	userId: string,
	tags: string[],
	options: { archived?: boolean } = {},
) {
	seq += 1;
	const url = `https://example.com/${seq}`;
	await db.insert(bookmarks).values({
		userId,
		url,
		urlNormalized: url,
		title: `Page ${seq}`,
		tags,
		createdAt: NOW,
		updatedAt: NOW,
		archivedAt: options.archived ? NOW : null,
	});
}

describe("listTags", () => {
	it("returns [] for a user with no bookmarks", async () => {
		expect(await listTags(db, USER_A)).toEqual([]);
	});

	it("returns [] when the user's bookmarks carry no tags", async () => {
		await insert(USER_A, []);
		await insert(USER_A, []);
		expect(await listTags(db, USER_A)).toEqual([]);
	});

	it("de-duplicates tags across rows", async () => {
		await insert(USER_A, ["dev", "rust"]);
		await insert(USER_A, ["dev"]);
		await insert(USER_A, ["dev", "rust"]);
		expect(await listTags(db, USER_A)).toEqual(["dev", "rust"]);
	});

	it("orders by usage count desc, then tag asc", async () => {
		// counts: dev 3, art 2, rust 2, zig 1
		await insert(USER_A, ["dev", "rust", "zig"]);
		await insert(USER_A, ["dev", "art"]);
		await insert(USER_A, ["dev", "art", "rust"]);
		expect(await listTags(db, USER_A)).toEqual(["dev", "art", "rust", "zig"]);
	});

	it("includes tags that only live on archived rows, and counts them", async () => {
		await insert(USER_A, ["live"]);
		await insert(USER_A, ["gone"], { archived: true });
		await insert(USER_A, ["gone"], { archived: true });
		// `gone` outranks `live` on count even though every row is archived.
		expect(await listTags(db, USER_A)).toEqual(["gone", "live"]);
	});

	it("scopes to the user — another user's tags never leak", async () => {
		await insert(USER_A, ["mine"]);
		await insert(USER_B, ["theirs", "theirs-too"]);
		await insert(USER_B, ["theirs"]);

		expect(await listTags(db, USER_A)).toEqual(["mine"]);
		expect(await listTags(db, USER_B)).toEqual(["theirs", "theirs-too"]);
	});
});
