// Browse-event tests (m19, SPEC §13). The DB-touching half runs against REAL
// Postgres semantics: an in-memory PGlite database with the production
// migrations from web/drizzle/ applied in journal order, plus a stubbed
// auth.users (Supabase-managed in prod) — same harness as sync.test.ts.
// The schema half is pure (no DB): the route's Zod contract.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { bookmarks, browseEvents } from "../db/schema";
import {
	applyBrowseEvents,
	type BrowseEventInput,
	browseEventsBodySchema,
	InvalidCursorError,
	listBrowseEvents,
} from "./browseEvents";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const BOOT = "33333333-3333-4333-8333-333333333333";

/** Deterministic, format-valid client event ids. */
function clientId(n: number): string {
	return `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
}

const T0 = new Date("2026-03-01T10:00:00.000Z").getTime();

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
	await db.execute(sql`DELETE FROM smultron.browse_events`);
	await db.execute(sql`DELETE FROM smultron.bookmarks`);
});

/** A `nav` event with sane defaults; `n` drives the client event id + time. */
function nav(n: number, overrides: Partial<BrowseEventInput> = {}) {
	return {
		clientEventId: clientId(n),
		bootId: BOOT,
		kind: "nav" as const,
		occurredAtMs: T0 + n * 1000,
		tabId: 7,
		url: `https://example.com/page/${n}`,
		...overrides,
	} satisfies BrowseEventInput;
}

async function allRows(userId?: string) {
	const rows = userId
		? await db
				.select()
				.from(browseEvents)
				.where(eq(browseEvents.userId, userId))
		: await db.select().from(browseEvents);
	return rows.sort((a, b) => a.id - b.id);
}

describe("applyBrowseEvents", () => {
	it("empty batch returns zeros without touching the DB", async () => {
		expect(await applyBrowseEvents(db, USER_A, [])).toEqual({
			inserted: 0,
			deduped: 0,
		});
		expect(await allRows()).toHaveLength(0);
	});

	it("inserts a full event, storing the raw url and the normalized one", async () => {
		const result = await applyBrowseEvents(db, USER_A, [
			{
				clientEventId: clientId(1),
				bootId: BOOT,
				kind: "nav",
				occurredAtMs: T0,
				tabId: 12,
				windowId: 3,
				url: "https://Example.com/Page/?utm_source=nl&x=1#frag",
				transition: "typed|from_address_bar",
				documentLifecycle: "prerender",
			},
		]);
		expect(result).toEqual({ inserted: 1, deduped: 0 });

		const [row] = await allRows();
		expect(row.userId).toBe(USER_A);
		expect(row.clientEventId).toBe(clientId(1));
		expect(row.bootId).toBe(BOOT);
		expect(row.kind).toBe("nav");
		expect(row.occurredAt).toEqual(new Date(T0));
		// Raw URL stored untouched; normalized computed server-side (SPEC §4).
		expect(row.url).toBe("https://Example.com/Page/?utm_source=nl&x=1#frag");
		expect(row.urlNormalized).toBe("https://example.com/Page?x=1");
		expect(row.tabId).toBe(12);
		expect(row.windowId).toBe(3);
		expect(row.transition).toBe("typed|from_address_bar");
		expect(row.documentLifecycle).toBe("prerender");
		// Fields the kind doesn't carry are null.
		expect(row.title).toBeNull();
		expect(row.idleState).toBeNull();
		// Server receipt clock, independent of occurred_at.
		expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(10_000);
	});

	it("stores null url_normalized when the kind carries no url", async () => {
		await applyBrowseEvents(db, USER_A, [
			{
				clientEventId: clientId(1),
				bootId: BOOT,
				kind: "idle",
				occurredAtMs: T0,
				idleState: "locked",
			},
		]);
		const [row] = await allRows();
		expect(row.url).toBeNull();
		expect(row.urlNormalized).toBeNull();
		expect(row.idleState).toBe("locked");
	});

	it("normalizes urls the same way the rest of the app does", async () => {
		await applyBrowseEvents(db, USER_A, [
			nav(1, { url: "HTTPS://WWW.Example.COM/a/?utm_campaign=x&b=2" }),
			nav(2, { url: "http://example.com/a/b/#section" }),
		]);
		const rows = await allRows();
		expect(rows.map((r) => r.urlNormalized)).toEqual([
			"https://www.example.com/a?b=2",
			"http://example.com/a/b",
		]);
	});

	it("dedupes a redelivered batch on (user_id, client_event_id)", async () => {
		const batch = [nav(1), nav(2), nav(3)];
		expect(await applyBrowseEvents(db, USER_A, batch)).toEqual({
			inserted: 3,
			deduped: 0,
		});
		// At-least-once outbox delivery: the exact same batch arrives again.
		expect(await applyBrowseEvents(db, USER_A, batch)).toEqual({
			inserted: 0,
			deduped: 3,
		});
		expect(await allRows()).toHaveLength(3);
	});

	it("counts a partially-overlapping batch correctly", async () => {
		await applyBrowseEvents(db, USER_A, [nav(1), nav(2)]);
		expect(
			await applyBrowseEvents(db, USER_A, [nav(2), nav(3), nav(4)]),
		).toEqual({ inserted: 2, deduped: 1 });
		expect(await allRows()).toHaveLength(4);
	});

	it("dedupes duplicates WITHIN one batch", async () => {
		expect(
			await applyBrowseEvents(db, USER_A, [nav(1), nav(1), nav(2)]),
		).toEqual({ inserted: 2, deduped: 1 });
		expect(await allRows()).toHaveLength(2);
	});

	it("scopes dedupe per user: the same client_event_id inserts for both", async () => {
		expect(await applyBrowseEvents(db, USER_A, [nav(1)])).toEqual({
			inserted: 1,
			deduped: 0,
		});
		expect(await applyBrowseEvents(db, USER_B, [nav(1)])).toEqual({
			inserted: 1,
			deduped: 0,
		});
		expect(await allRows()).toHaveLength(2);
		expect(await allRows(USER_A)).toHaveLength(1);
		expect(await allRows(USER_B)).toHaveLength(1);

		// And the listing is scoped too.
		const a = await listBrowseEvents(db, USER_A);
		expect(a.total).toBe(1);
		expect(a.events.every((e) => e.url === "https://example.com/page/1")).toBe(
			true,
		);
		expect((await listBrowseEvents(db, USER_B)).total).toBe(1);
	});

	it("NEVER touches the bookmarks table (Hard rule #1)", async () => {
		const past = new Date("2024-01-15T12:00:00.000Z");
		await db.insert(bookmarks).values({
			userId: USER_A,
			url: "https://example.com/page/1",
			urlNormalized: "https://example.com/page/1",
			title: "A page",
			createdAt: past,
			updatedAt: past,
		});
		const before = await db.select().from(bookmarks);

		// Events for the SAME urls as the bookmark, plus a redelivery.
		const batch = [
			nav(1, { url: "https://example.com/page/1" }),
			nav(2, { url: "https://example.com/page/1?utm_source=x" }),
			{
				clientEventId: clientId(3),
				bootId: BOOT,
				kind: "tab_activated" as const,
				occurredAtMs: T0 + 5_000,
				tabId: 1,
				windowId: 1,
				url: "https://example.com/page/1",
				title: "A page",
			},
		];
		await applyBrowseEvents(db, USER_A, batch);
		await applyBrowseEvents(db, USER_A, batch);

		const after = await db.select().from(bookmarks);
		// Byte-identical, updated_at included.
		expect(after).toEqual(before);
		expect(await allRows()).toHaveLength(3);
	});
});

describe("listBrowseEvents", () => {
	it("serializes SPEC §8 event JSON with nulls for absent fields", async () => {
		await applyBrowseEvents(db, USER_A, [
			{
				clientEventId: clientId(1),
				bootId: BOOT,
				kind: "window_focus",
				occurredAtMs: T0,
				windowId: 9,
				tabId: 4,
				title: "Tab title",
			},
		]);

		const { events, nextCursor, total } = await listBrowseEvents(db, USER_A);
		expect(total).toBe(1);
		expect(nextCursor).toBeNull();
		const [event] = events;
		expect(event).toEqual({
			id: expect.any(Number),
			kind: "window_focus",
			occurredAt: new Date(T0).toISOString(),
			bootId: BOOT,
			url: null,
			urlNormalized: null,
			title: "Tab title",
			tabId: 4,
			windowId: 9,
			idleState: null,
			transition: null,
			documentLifecycle: null,
			createdAt: expect.any(String),
		});
		expect(new Date(event.createdAt).getTime()).not.toBeNaN();
	});

	it("orders occurred_at desc, id desc (ties broken by id)", async () => {
		// Same instant for 1 and 2; 3 is later.
		await applyBrowseEvents(db, USER_A, [
			nav(1, { occurredAtMs: T0 }),
			nav(2, { occurredAtMs: T0 }),
			nav(3, { occurredAtMs: T0 + 1000 }),
		]);
		const rows = await allRows();
		const { events } = await listBrowseEvents(db, USER_A);
		expect(events.map((e) => e.id)).toEqual([
			rows[2].id,
			rows[1].id,
			rows[0].id,
		]);
	});

	it("filters by kind", async () => {
		await applyBrowseEvents(db, USER_A, [
			nav(1),
			{
				clientEventId: clientId(2),
				bootId: BOOT,
				kind: "idle",
				occurredAtMs: T0 + 2000,
				idleState: "idle",
			},
			{
				clientEventId: clientId(3),
				bootId: BOOT,
				kind: "window_blur",
				occurredAtMs: T0 + 3000,
			},
		]);

		const one = await listBrowseEvents(db, USER_A, { kinds: ["idle"] });
		expect(one.events.map((e) => e.kind)).toEqual(["idle"]);
		expect(one.total).toBe(1);

		const two = await listBrowseEvents(db, USER_A, {
			kinds: ["idle", "window_blur"],
		});
		expect(two.events.map((e) => e.kind)).toEqual(["window_blur", "idle"]);
		expect(two.total).toBe(2);

		// Empty array = no filter at all.
		expect((await listBrowseEvents(db, USER_A, { kinds: [] })).total).toBe(3);
	});

	it("filters by q over url and title, case-insensitively", async () => {
		await applyBrowseEvents(db, USER_A, [
			nav(1, { url: "https://news.ycombinator.com/item?id=1" }),
			{
				clientEventId: clientId(2),
				bootId: BOOT,
				kind: "tab_activated",
				occurredAtMs: T0 + 2000,
				tabId: 1,
				windowId: 1,
				url: "https://example.com/x",
				title: "Hacker News favourites",
			},
			nav(3, { url: "https://example.org/other" }),
		]);

		// Matches the URL only.
		const byUrl = await listBrowseEvents(db, USER_A, { q: "ycombinator" });
		expect(byUrl.total).toBe(1);
		expect(byUrl.events[0].url).toContain("ycombinator");

		// Matches the title only, case-insensitively.
		const byTitle = await listBrowseEvents(db, USER_A, { q: "hacker NEWS" });
		expect(byTitle.total).toBe(1);
		expect(byTitle.events[0].title).toBe("Hacker News favourites");

		// Blank q is no filter.
		expect((await listBrowseEvents(db, USER_A, { q: "   " })).total).toBe(3);
		expect((await listBrowseEvents(db, USER_A, { q: "nomatch" })).total).toBe(
			0,
		);
	});

	it("escapes LIKE metacharacters in q so they match literally", async () => {
		await applyBrowseEvents(db, USER_A, [
			{
				clientEventId: clientId(1),
				bootId: BOOT,
				kind: "tab_activated",
				occurredAtMs: T0,
				tabId: 1,
				windowId: 1,
				title: "100% done",
			},
			{
				clientEventId: clientId(2),
				bootId: BOOT,
				kind: "tab_activated",
				occurredAtMs: T0 + 1000,
				tabId: 1,
				windowId: 1,
				title: "a_b",
			},
			{
				clientEventId: clientId(3),
				bootId: BOOT,
				kind: "tab_activated",
				occurredAtMs: T0 + 2000,
				tabId: 1,
				windowId: 1,
				title: "axb",
			},
			{
				clientEventId: clientId(4),
				bootId: BOOT,
				kind: "tab_activated",
				occurredAtMs: T0 + 3000,
				tabId: 1,
				windowId: 1,
				title: "back\\slash",
			},
		]);

		// `_` is a single-char wildcard in LIKE — escaped, it matches only "a_b".
		const underscore = await listBrowseEvents(db, USER_A, { q: "a_b" });
		expect(underscore.events.map((e) => e.title)).toEqual(["a_b"]);

		// `%` would otherwise match everything.
		const percent = await listBrowseEvents(db, USER_A, { q: "%" });
		expect(percent.events.map((e) => e.title)).toEqual(["100% done"]);

		const backslash = await listBrowseEvents(db, USER_A, { q: "\\s" });
		expect(backslash.events.map((e) => e.title)).toEqual(["back\\slash"]);
	});

	it("pages 100 at a time with an uncapped total", async () => {
		await applyBrowseEvents(
			db,
			USER_A,
			Array.from({ length: 150 }, (_, i) => nav(i + 1)),
		);

		const page = await listBrowseEvents(db, USER_A);
		expect(page.events).toHaveLength(100);
		expect(page.total).toBe(150);
		expect(page.nextCursor).not.toBeNull();

		// `total` follows the active filter, still uncapped.
		await applyBrowseEvents(db, USER_A, [
			{
				clientEventId: clientId(9001),
				bootId: BOOT,
				kind: "idle",
				occurredAtMs: T0,
				idleState: "active",
			},
		]);
		const filtered = await listBrowseEvents(db, USER_A, { kinds: ["nav"] });
		expect(filtered.total).toBe(150);
		expect(filtered.events).toHaveLength(100);
	});

	it("keyset-paginates across pages with ties on occurred_at", async () => {
		// 250 events in blocks of 60 sharing an instant, so page boundaries
		// (100/page) land INSIDE a tie block — the id half of the keyset is
		// the only thing that can order those correctly.
		const batch = Array.from({ length: 250 }, (_, i) =>
			nav(i + 1, { occurredAtMs: T0 + Math.floor(i / 60) * 1000 }),
		);
		await applyBrowseEvents(db, USER_A, batch);

		const inserted = await allRows();
		const expected = inserted.map((r) => r.id).reverse();

		const seen: number[] = [];
		const sizes: number[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 10; i++) {
			const result = await listBrowseEvents(db, USER_A, { cursor });
			expect(result.total).toBe(250);
			sizes.push(result.events.length);
			seen.push(...result.events.map((e) => e.id));
			if (!result.nextCursor) {
				break;
			}
			cursor = result.nextCursor;
		}

		expect(sizes).toEqual([100, 100, 50]);
		// No skips, no repeats, exact global ordering.
		expect(seen).toEqual(expected);
	});

	it("applies filters on cursor pages too", async () => {
		const batch = [
			...Array.from({ length: 120 }, (_, i) => nav(i + 1)),
			...Array.from({ length: 5 }, (_, i) => ({
				clientEventId: clientId(500 + i),
				bootId: BOOT,
				kind: "idle" as const,
				occurredAtMs: T0 + 10 + i,
				idleState: "idle" as const,
			})),
		];
		await applyBrowseEvents(db, USER_A, batch);

		const first = await listBrowseEvents(db, USER_A, { kinds: ["nav"] });
		expect(first.events).toHaveLength(100);
		const second = await listBrowseEvents(db, USER_A, {
			kinds: ["nav"],
			cursor: first.nextCursor ?? undefined,
		});
		expect(second.events).toHaveLength(20);
		expect(second.total).toBe(120);
		expect(second.nextCursor).toBeNull();
		expect(second.events.every((e) => e.kind === "nav")).toBe(true);
	});

	it("throws InvalidCursorError on a cursor it did not produce", async () => {
		const bad = [
			"not-a-cursor",
			Buffer.from("not json", "utf8").toString("base64url"),
			Buffer.from(JSON.stringify({ o: 5, id: 1 }), "utf8").toString(
				"base64url",
			),
			Buffer.from(
				JSON.stringify({ o: new Date(T0).toISOString(), id: "x" }),
				"utf8",
			).toString("base64url"),
			// Not a safe integer: would overflow int8 / serialize as 1e+19.
			Buffer.from(
				JSON.stringify({ o: new Date(T0).toISOString(), id: 1e19 }),
				"utf8",
			).toString("base64url"),
			Buffer.from(JSON.stringify({ o: "nonsense", id: 1 }), "utf8").toString(
				"base64url",
			),
		];

		for (const cursor of bad) {
			await expect(
				listBrowseEvents(db, USER_A, { cursor }),
			).rejects.toBeInstanceOf(InvalidCursorError);
		}
	});
});

// ---------------------------------------------------------------------------
// Route contract (pure — SPEC §13 "Validation bounds")
// ---------------------------------------------------------------------------

function parseOne(event: Record<string, unknown>) {
	return browseEventsBodySchema.safeParse({ events: [event] });
}

const base = {
	clientEventId: clientId(1),
	bootId: BOOT,
	occurredAtMs: T0,
};

describe("browseEventsBodySchema", () => {
	it("accepts a representative event of each of the 7 kinds", () => {
		const events = [
			{ ...base, kind: "nav", tabId: 1, url: "https://a.com/" },
			{
				...base,
				kind: "nav",
				tabId: 1,
				url: "https://a.com/",
				windowId: 2,
				transition: "link|forward_back",
				documentLifecycle: "prerender",
			},
			{ ...base, kind: "tab_activated", tabId: 1, windowId: 2 },
			{
				...base,
				kind: "tab_activated",
				tabId: 1,
				windowId: 2,
				url: "https://a.com/",
				title: "A",
			},
			{ ...base, kind: "window_focus", windowId: 2 },
			{
				...base,
				kind: "window_focus",
				windowId: 2,
				tabId: 1,
				url: "https://a.com/",
				title: "A",
			},
			{ ...base, kind: "window_blur" },
			{ ...base, kind: "idle", idleState: "active" },
			{ ...base, kind: "idle", idleState: "idle" },
			{ ...base, kind: "idle", idleState: "locked" },
			{ ...base, kind: "capture_start" },
			{ ...base, kind: "capture_stop" },
		];
		for (const event of events) {
			expect(parseOne(event).success, JSON.stringify(event)).toBe(true);
		}
		// Also as one batch, and an empty batch.
		expect(browseEventsBodySchema.safeParse({ events }).success).toBe(true);
		expect(browseEventsBodySchema.safeParse({ events: [] }).success).toBe(true);
	});

	it("rejects missing required fields per kind", () => {
		const missing = [
			{ ...base, kind: "nav", url: "https://a.com/" }, // no tabId
			{ ...base, kind: "nav", tabId: 1 }, // no url
			{ ...base, kind: "tab_activated", tabId: 1 }, // no windowId
			{ ...base, kind: "tab_activated", windowId: 2 }, // no tabId
			{ ...base, kind: "window_focus", tabId: 1 }, // no windowId
			{ ...base, kind: "idle" }, // no idleState
		];
		for (const event of missing) {
			expect(parseOne(event).success, JSON.stringify(event)).toBe(false);
		}
	});

	it("rejects fields the kind does not allow", () => {
		const forbidden = [
			// nav carries no title (the tab still shows the previous page's) and
			// no idleState.
			{ ...base, kind: "nav", tabId: 1, url: "https://a.com/", title: "A" },
			{
				...base,
				kind: "nav",
				tabId: 1,
				url: "https://a.com/",
				idleState: "idle",
			},
			{
				...base,
				kind: "tab_activated",
				tabId: 1,
				windowId: 2,
				transition: "link",
			},
			{
				...base,
				kind: "tab_activated",
				tabId: 1,
				windowId: 2,
				idleState: "idle",
			},
			{
				...base,
				kind: "tab_activated",
				tabId: 1,
				windowId: 2,
				documentLifecycle: "active",
			},
			{ ...base, kind: "window_focus", windowId: 2, transition: "link" },
			{ ...base, kind: "window_blur", tabId: 1 },
			{ ...base, kind: "window_blur", url: "https://a.com/" },
			{ ...base, kind: "idle", idleState: "idle", url: "https://a.com/" },
			{ ...base, kind: "idle", idleState: "idle", tabId: 1 },
			{ ...base, kind: "capture_start", url: "https://a.com/" },
			{ ...base, kind: "capture_stop", windowId: 2 },
		];
		for (const event of forbidden) {
			expect(parseOne(event).success, JSON.stringify(event)).toBe(false);
		}
	});

	it("rejects unknown fields at every level", () => {
		expect(parseOne({ ...base, kind: "window_blur", extra: 1 }).success).toBe(
			false,
		);
		expect(
			browseEventsBodySchema.safeParse({ events: [], extra: 1 }).success,
		).toBe(false);
		expect(browseEventsBodySchema.safeParse({}).success).toBe(false);
		expect(browseEventsBodySchema.safeParse({ events: "nope" }).success).toBe(
			false,
		);
	});

	it("caps a batch at 500 events", () => {
		const event = { ...base, kind: "window_blur" };
		const make = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				...event,
				clientEventId: clientId(i + 1),
			}));
		expect(
			browseEventsBodySchema.safeParse({ events: make(500) }).success,
		).toBe(true);
		expect(
			browseEventsBodySchema.safeParse({ events: make(501) }).success,
		).toBe(false);
	});

	it("bounds occurredAtMs to the representable Date range", () => {
		const kind = "window_blur";
		expect(parseOne({ ...base, kind, occurredAtMs: 0 }).success).toBe(true);
		expect(
			parseOne({ ...base, kind, occurredAtMs: 8_640_000_000_000_000 }).success,
		).toBe(true);
		expect(parseOne({ ...base, kind, occurredAtMs: -1 }).success).toBe(false);
		expect(
			parseOne({ ...base, kind, occurredAtMs: 8_640_000_000_000_001 }).success,
		).toBe(false);
		expect(parseOne({ ...base, kind, occurredAtMs: 1.5 }).success).toBe(false);
		expect(parseOne({ ...base, kind, occurredAtMs: "1" }).success).toBe(false);
		const { occurredAtMs: _omit, ...noTime } = base;
		expect(parseOne({ ...noTime, kind }).success).toBe(false);
	});

	it("requires UUID-format clientEventId and bootId", () => {
		const kind = "window_blur";
		expect(parseOne({ ...base, kind, clientEventId: "nope" }).success).toBe(
			false,
		);
		expect(parseOne({ ...base, kind, clientEventId: "" }).success).toBe(false);
		expect(parseOne({ ...base, kind, bootId: "nope" }).success).toBe(false);
		expect(parseOne({ ...base, kind, bootId: 1 }).success).toBe(false);
	});

	it("rejects an unknown kind", () => {
		expect(parseOne({ ...base, kind: "navigate" }).success).toBe(false);
		expect(parseOne({ ...base, kind: "" }).success).toBe(false);
	});

	it("bounds the text fields so nothing valid can die in Postgres", () => {
		const nav = (over: Record<string, unknown>) =>
			parseOne({
				...base,
				kind: "nav",
				tabId: 1,
				url: "https://a.com/",
				...over,
			});

		expect(nav({ url: `https://a.com/${"x".repeat(8192 - 15)}` }).success).toBe(
			true,
		);
		expect(nav({ url: "x".repeat(8193) }).success).toBe(false);
		expect(nav({ url: "" }).success).toBe(false);
		expect(nav({ transition: "x".repeat(256) }).success).toBe(true);
		expect(nav({ transition: "x".repeat(257) }).success).toBe(false);
		expect(nav({ documentLifecycle: "x".repeat(64) }).success).toBe(true);
		expect(nav({ documentLifecycle: "x".repeat(65) }).success).toBe(false);

		const activated = (over: Record<string, unknown>) =>
			parseOne({
				...base,
				kind: "tab_activated",
				tabId: 1,
				windowId: 2,
				...over,
			});
		expect(activated({ title: "x".repeat(4096) }).success).toBe(true);
		expect(activated({ title: "x".repeat(4097) }).success).toBe(false);
		// An empty title is legitimate (Chrome allows it).
		expect(activated({ title: "" }).success).toBe(true);
	});

	it("bounds tabId/windowId to 32-bit integers", () => {
		const activated = (tabId: unknown, windowId: unknown) =>
			parseOne({ ...base, kind: "tab_activated", tabId, windowId });

		expect(activated(-1, -1).success).toBe(true);
		expect(activated(2_147_483_647, -2_147_483_648).success).toBe(true);
		expect(activated(2_147_483_648, 1).success).toBe(false);
		expect(activated(1, -2_147_483_649).success).toBe(false);
		expect(activated(1.5, 1).success).toBe(false);
		expect(activated("1", 1).success).toBe(false);
	});

	it("rejects an unknown idleState", () => {
		expect(parseOne({ ...base, kind: "idle", idleState: "away" }).success).toBe(
			false,
		);
	});
});
