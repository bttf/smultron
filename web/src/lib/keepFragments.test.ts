// Migration 0013_keep-fragments (m22, SPEC §4/§13): recomputes
// `url_normalized` for bookmarks AND browse_events under the fragment-keeping
// rule. Runs on PGlite with the real production migrations — all EXCEPT 0013
// — applied first, seeds rows whose `url_normalized` is HAND-WRITTEN the
// pre-m22 way (fragment stripped), then applies 0013 alone.
//
// The assertion that matters: after the migration, every parse-success row's
// `url_normalized` is byte-identical to what the TypeScript `normalizeUrl`
// returns for the same raw URL. The SQL and the single implementation
// (Hard rule #3) must not drift.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeUrl } from "./normalizeUrl";

const MIGRATION_TAG = "0013_keep-fragments";
const USER_A = "44444444-4444-4444-8444-444444444444";
// Gmail's inbox route and one of its messages normalized to the SAME key
// before m22 — the collision this milestone exists to fix. They cannot
// coexist for one user under the old unique index, so the corpus parks them
// on two users, exactly as prod would have.
const USER_B = "55555555-5555-4555-8555-555555555555";

const drizzleDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../drizzle",
);

/**
 * A seeded row: the raw URL as captured, plus its `url_normalized` as the
 * PRE-m22 rules produced it — written out by hand so the test never shares a
 * bug with the implementation it checks.
 */
type Case = {
	name: string;
	userId?: string;
	url: string;
	old: string;
	/** Parse-failure fallback rows must come out byte-unchanged. */
	unchanged?: boolean;
};

const CASES: Case[] = [
	{
		name: "gmail inbox route",
		url: "https://mail.google.com/mail/u/0/#inbox",
		old: "https://mail.google.com/mail/u/0",
	},
	{
		name: "gmail single message (same old key — hence the other user)",
		userId: USER_B,
		url: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQbfWxyz",
		old: "https://mail.google.com/mail/u/0",
	},
	{
		name: "mid-fragment text directive",
		url: "https://example.com/docs#usage:~:text=foo",
		old: "https://example.com/docs",
	},
	{
		name: "fragment that is only a text directive",
		url: "https://example.com/spec#:~:text=hello%20there",
		old: "https://example.com/spec",
	},
	{
		name: "bare trailing #",
		url: "https://example.com/bare#",
		old: "https://example.com/bare",
	},
	{
		name: "second # inside the fragment",
		url: "https://example.com/multi#one#two",
		old: "https://example.com/multi",
	},
	{
		name: "space in the fragment (encoding parity)",
		url: "https://example.com/space#fr ag",
		old: "https://example.com/space",
	},
	{
		name: "non-ASCII fragment (UTF-8 percent-escapes)",
		url: "https://example.com/uni#café",
		old: "https://example.com/uni",
	},
	{
		name: "the rest of the fragment percent-encode set",
		url: 'https://example.com/set#a`b<c>d"e',
		old: "https://example.com/set",
	},
	{
		name: "stray % and an existing percent-sequence are left alone",
		url: "https://example.com/pct#100%25 vs 100%",
		old: "https://example.com/pct",
	},
	{
		name: "already-encoded fragment stays stable",
		url: "https://example.com/enc#a%20b",
		old: "https://example.com/enc",
	},
	{
		name: "tracking params + fragment",
		url: "https://example.com/track/?utm_source=z&b=1#frag",
		old: "https://example.com/track?b=1",
	},
	{
		name: "trailing slash + fragment",
		url: "https://slash.example.com/a/#frag",
		old: "https://slash.example.com/a",
	},
	{
		name: "root path + path-shaped fragment",
		url: "https://root.example.com/#/settings/profile",
		old: "https://root.example.com",
	},
	{
		name: "tab inside the fragment + surrounding whitespace",
		url: "  https://ws.example.com/a#fr\tag  ",
		old: "https://ws.example.com/a",
	},
	{
		name: "non-http scheme keeps its fragment",
		url: "chrome://settings/passwords#top",
		old: "chrome://settings/passwords",
	},
	{
		name: "non-http scheme, directive still stripped",
		url: "data:text/html,<p>hi</p>#a:~:text=x",
		old: "data:text/html,<p>hi</p>",
	},
	{
		name: "non-http scheme, fragment drops to nothing",
		url: "javascript:void(0)#:~:text=x",
		old: "javascript:void(0)",
	},
	{
		name: "no fragment at all",
		url: "https://example.com/plain",
		old: "https://example.com/plain",
	},
	{
		name: "no fragment, trailing slash stripped",
		url: "https://example.com/plain2/",
		old: "https://example.com/plain2",
	},
	{
		name: "parse failure: raw stored verbatim, fragment included",
		url: "not a url#frag",
		old: "not a url#frag",
		unchanged: true,
	},
	{
		name: "parse failure with a directive, stored verbatim",
		url: "example.com/a#:~:text=foo",
		old: "example.com/a#:~:text=foo",
		unchanged: true,
	},
	{
		name: "parse failure with no fragment (nothing to append)",
		url: "not a url either",
		old: "not a url either",
		unchanged: true,
	},
];

let client: PGlite;

function applyMigrationFile(tag: string) {
	const migration = readFileSync(join(drizzleDir, `${tag}.sql`), "utf8");
	return (async () => {
		for (const statement of migration.split("--> statement-breakpoint")) {
			await client.exec(statement);
		}
	})();
}

const SEEDED_AT = "2026-01-01T00:00:00Z";

beforeAll(async () => {
	client = new PGlite({ extensions: { pg_trgm } });
	await client.exec(
		"CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);",
	);
	const journal = JSON.parse(
		readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"),
	) as { entries: Array<{ tag: string }> };
	for (const entry of journal.entries) {
		if (entry.tag === MIGRATION_TAG) {
			continue;
		}
		await applyMigrationFile(entry.tag);
	}
	await client.exec(
		`INSERT INTO auth.users (id) VALUES ('${USER_A}'), ('${USER_B}');`,
	);

	// Bookmarks: one row per case, url_normalized written the OLD way.
	for (const [i, c] of CASES.entries()) {
		await client.query(
			`INSERT INTO smultron.bookmarks
			   (user_id, url, url_normalized, title, tags, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, '{}', $5, $5)`,
			[c.userId ?? USER_A, c.url, c.old, `row ${i}`, SEEDED_AT],
		);
	}

	// Browse events: the same corpus, plus a url-less event.
	for (const [i, c] of CASES.entries()) {
		await client.query(
			`INSERT INTO smultron.browse_events
			   (user_id, client_event_id, boot_id, kind, occurred_at, url, url_normalized)
			 VALUES ($1, $2, 'boot', 'nav', $3, $4, $5)`,
			[c.userId ?? USER_A, `evt-${i}`, SEEDED_AT, c.url, c.old],
		);
	}
	await client.query(
		`INSERT INTO smultron.browse_events
		   (user_id, client_event_id, boot_id, kind, occurred_at, url, url_normalized)
		 VALUES ($1, 'evt-null', 'boot', 'window_blur', $2, NULL, NULL)`,
		[USER_A, SEEDED_AT],
	);

	await applyMigrationFile(MIGRATION_TAG);
});

afterAll(async () => {
	await client.close();
});

async function bookmarkRow(title: string) {
	const res = await client.query<{
		url: string;
		url_normalized: string;
		same_updated: boolean;
		same_created: boolean;
	}>(
		`SELECT url, url_normalized,
		        updated_at = $2::timestamptz AS same_updated,
		        created_at = $2::timestamptz AS same_created
		 FROM smultron.bookmarks WHERE title = $1`,
		[title, SEEDED_AT],
	);
	return res.rows[0];
}

async function eventRow(clientEventId: string) {
	const res = await client.query<{
		url: string | null;
		url_normalized: string | null;
	}>(
		"SELECT url, url_normalized FROM smultron.browse_events WHERE client_event_id = $1",
		[clientEventId],
	);
	return res.rows[0];
}

describe("migration 0013_keep-fragments", () => {
	it.each(CASES.map((c, i) => [c.name, c, i] as const))(
		"bookmarks: %s",
		async (_name, c, i) => {
			const row = await bookmarkRow(`row ${i}`);
			if (c.unchanged) {
				// Parse-failure fallback rows are guarded by the `#` test (or have
				// no fragment to append) — byte-unchanged either way.
				expect(row.url_normalized).toBe(c.old);
			}
			expect(row.url_normalized).toBe(normalizeUrl(c.url));
			// A data migration, not a live capture (Hard rule #1).
			expect(row.same_updated).toBe(true);
			expect(row.same_created).toBe(true);
		},
	);

	it.each(CASES.map((c, i) => [c.name, c, i] as const))(
		"browse_events: %s",
		async (_name, c, i) => {
			const row = await eventRow(`evt-${i}`);
			if (c.unchanged) {
				expect(row.url_normalized).toBe(c.old);
			}
			expect(row.url_normalized).toBe(normalizeUrl(c.url));
		},
	);

	it("leaves a browse_event with a null url untouched", async () => {
		const row = await eventRow("evt-null");
		expect(row.url).toBeNull();
		expect(row.url_normalized).toBeNull();
	});

	it("rewrote the rows that had a fragment and nothing else", async () => {
		const changed = CASES.filter((c) => normalizeUrl(c.url) !== c.old);
		// Sanity: the corpus really does exercise the rewrite path.
		expect(changed.length).toBeGreaterThan(10);
		const untouched = CASES.filter((c) => normalizeUrl(c.url) === c.old);
		expect(untouched.map((c) => c.name)).toContain("no fragment at all");
	});

	it("splits the two Gmail routes that used to share one key", async () => {
		const inbox = await bookmarkRow(
			`row ${CASES.findIndex((c) => c.url.endsWith("/#inbox"))}`,
		);
		const message = await bookmarkRow(
			`row ${CASES.findIndex((c) => c.url.endsWith("FMfcgzQbfWxyz"))}`,
		);
		expect(inbox.url_normalized).toBe("https://mail.google.com/mail/u/0#inbox");
		expect(message.url_normalized).toBe(
			"https://mail.google.com/mail/u/0#inbox/FMfcgzQbfWxyz",
		);
		expect(inbox.url_normalized).not.toBe(message.url_normalized);
	});

	it("re-running the migration is a no-op (the # guard)", async () => {
		const before = await client.query<{ url_normalized: string }>(
			"SELECT url_normalized FROM smultron.bookmarks ORDER BY id",
		);
		await applyMigrationFile(MIGRATION_TAG);
		const after = await client.query<{ url_normalized: string }>(
			"SELECT url_normalized FROM smultron.bookmarks ORDER BY id",
		);
		expect(after.rows).toEqual(before.rows);
	});
});
