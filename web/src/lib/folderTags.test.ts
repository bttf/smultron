// folderTags (SPEC §5 leaf-folder tag rule) + migration 0004's data
// transform, which retags pre-existing rows to match it. The migration test
// runs on PGlite with the real production migrations — all EXCEPT 0004 —
// applied first, seeds old-style rows, then applies 0004 alone.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { folderTags } from "./sync";

describe("folderTags", () => {
	it("no folderPath -> no tags", () => {
		expect(folderTags(undefined)).toEqual([]);
		expect(folderTags("")).toEqual([]);
	});

	it("default root containers alone -> no tags (matched by name)", () => {
		expect(folderTags("Bookmarks Bar")).toEqual([]);
		expect(folderTags("Other Bookmarks")).toEqual([]);
		expect(folderTags("Mobile Bookmarks")).toEqual([]);
	});

	it("a user's own single-segment folder IS tagged", () => {
		expect(folderTags("My Stuff")).toEqual(["My Stuff"]);
	});

	it("nested paths tag the leafmost folder only", () => {
		expect(folderTags("Bookmarks Bar/Dev")).toEqual(["Dev"]);
		expect(folderTags("Bookmarks Bar/Dev/Postgres")).toEqual(["Postgres"]);
		expect(folderTags("Other Bookmarks/read later")).toEqual(["read later"]);
	});

	it("a nested folder NAMED like a container is still a real tag", () => {
		expect(folderTags("Bookmarks Bar/Other Bookmarks")).toEqual([
			"Other Bookmarks",
		]);
	});
});

describe("migration 0004_leaf-folder-tags data transform", () => {
	const MIGRATION_TAG = "0004_leaf-folder-tags";
	const USER = "33333333-3333-4333-8333-333333333333";
	const drizzleDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"../../drizzle",
	);

	let client: PGlite;

	function applyMigrationFile(tag: string) {
		const migration = readFileSync(join(drizzleDir, `${tag}.sql`), "utf8");
		return (async () => {
			for (const statement of migration.split("--> statement-breakpoint")) {
				await client.exec(statement);
			}
		})();
	}

	async function seed(url: string, tags: string[]): Promise<number> {
		const res = await client.query<{ id: number }>(
			`INSERT INTO smultron.bookmarks (user_id, url, url_normalized, title, tags, created_at, updated_at)
			 VALUES ($1, $2, $2, 't', $3, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')
			 RETURNING id`,
			[USER, url, tags],
		);
		return res.rows[0].id;
	}

	async function tagsOf(id: number): Promise<string[]> {
		const res = await client.query<{ tags: string[]; same: boolean }>(
			"SELECT tags, updated_at = '2024-01-01T00:00:00Z'::timestamptz AS same FROM smultron.bookmarks WHERE id = $1",
			[id],
		);
		// The data migration must never bump updated_at (Hard rule #1).
		expect(res.rows[0].same).toBe(true);
		return res.rows[0].tags;
	}

	beforeAll(async () => {
		client = new PGlite({ extensions: { pg_trgm } });
		await client.exec(
			"CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);",
		);
		const journal = JSON.parse(
			readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"),
		) as { entries: Array<{ tag: string }> };
		for (const entry of journal.entries) {
			if (entry.tag === MIGRATION_TAG) continue;
			await applyMigrationFile(entry.tag);
		}
		await client.exec(`INSERT INTO auth.users (id) VALUES ('${USER}');`);
	});

	afterAll(async () => {
		await client.close();
	});

	it("rewrites old-style rows, leaves site-edited tags alone", async () => {
		const bare = await seed("https://a.com/1", ["Bookmarks Bar"]);
		const bareOther = await seed("https://a.com/2", ["Other Bookmarks"]);
		const path = await seed("https://a.com/3", ["Bookmarks Bar/Dev/Postgres"]);
		const containerLeaf = await seed("https://a.com/4", [
			"Bookmarks Bar/Other Bookmarks",
		]);
		const pathPlusManual = await seed("https://a.com/5", [
			"Bookmarks Bar/dev",
			"manual",
		]);
		const edited = await seed("https://a.com/6", ["reading"]);
		const empty = await seed("https://a.com/7", []);

		await applyMigrationFile(MIGRATION_TAG);

		expect(await tagsOf(bare)).toEqual([]);
		expect(await tagsOf(bareOther)).toEqual([]);
		expect(await tagsOf(path)).toEqual(["Postgres"]);
		// A real folder NAMED like a container survives as a tag — this is why
		// the migration's bare-container drop runs before leaf-replacement.
		expect(await tagsOf(containerLeaf)).toEqual(["Other Bookmarks"]);
		expect(await tagsOf(pathPlusManual)).toEqual(["dev", "manual"]);
		expect(await tagsOf(edited)).toEqual(["reading"]);
		expect(await tagsOf(empty)).toEqual([]);
	});
});
