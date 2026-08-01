// Pairing token lifecycle tests against REAL Postgres semantics: an
// in-memory PGlite database with the production migrations from web/drizzle/
// applied in journal order (same harness as sync.test.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { apiTokens } from "../db/schema";
import {
	generateRawToken,
	getPairingStatus,
	hashToken,
	issuePairingToken,
} from "./pairing";

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
	await db.execute(sql`DELETE FROM smultron.api_tokens`);
});

/**
 * authenticateApiToken-style lookup: sha256-hex the raw token and find the
 * row by token_hash (apiTokenAuth.ts does exactly this against the prod db).
 */
async function lookupByRawToken(raw: string) {
	const rows = await db
		.select({ userId: apiTokens.userId, pairedAt: apiTokens.pairedAt })
		.from(apiTokens)
		.where(eq(apiTokens.tokenHash, hashToken(raw)))
		.limit(1);
	return rows[0] ?? null;
}

/** Replicates /api/hello: set paired_at = now() only when currently null. */
async function helloStyleUpdate(userId: string) {
	await db
		.update(apiTokens)
		.set({ pairedAt: sql`now()` })
		.where(and(eq(apiTokens.userId, userId), isNull(apiTokens.pairedAt)));
}

async function tokenRow(userId: string) {
	const rows = await db
		.select()
		.from(apiTokens)
		.where(eq(apiTokens.userId, userId))
		.limit(1);
	return rows[0];
}

describe("generateRawToken", () => {
	it("is 43 chars of base64url with no padding", () => {
		const raw = generateRawToken();
		// 32 bytes -> ceil(32*8/6) = 43 base64url chars, '=' never present.
		expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("decodes to exactly 32 bytes", () => {
		expect(Buffer.from(generateRawToken(), "base64url")).toHaveLength(32);
	});

	it("never repeats across generations", () => {
		const tokens = new Set(
			Array.from({ length: 100 }, () => generateRawToken()),
		);
		expect(tokens.size).toBe(100);
	});
});

describe("hashToken", () => {
	it("is the hex-encoded sha256 of the raw token", () => {
		const raw = "some-raw-token";
		expect(hashToken(raw)).toBe(
			createHash("sha256").update(raw, "utf8").digest("hex"),
		);
		expect(hashToken(raw)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("issuePairingToken", () => {
	it("stores the sha256 hex of the returned raw token, unpaired", async () => {
		const raw = await issuePairingToken(db, USER_A);
		expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const row = await tokenRow(USER_A);
		expect(row.tokenHash).toBe(hashToken(raw));
		expect(row.pairedAt).toBeNull();
		expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(10_000);
	});

	it("bearer-style hash lookup resolves the raw token to the user", async () => {
		const raw = await issuePairingToken(db, USER_A);

		const found = await lookupByRawToken(raw);
		expect(found).toEqual({ userId: USER_A, pairedAt: null });

		// A token that was never issued finds nothing.
		expect(await lookupByRawToken(generateRawToken())).toBeNull();
	});

	it("regenerate replaces the hash — the old token stops matching", async () => {
		const oldRaw = await issuePairingToken(db, USER_A);
		const newRaw = await issuePairingToken(db, USER_A);
		expect(newRaw).not.toBe(oldRaw);

		expect(await lookupByRawToken(oldRaw)).toBeNull();
		expect(await lookupByRawToken(newRaw)).toEqual({
			userId: USER_A,
			pairedAt: null,
		});

		// Still one row per user (PK user_id).
		const rows = await db.select().from(apiTokens);
		expect(rows).toHaveLength(1);
	});

	it("regenerate resets paired_at to NULL (un-pairs) and refreshes created_at", async () => {
		await issuePairingToken(db, USER_A);
		await helloStyleUpdate(USER_A);
		const past = new Date("2024-01-15T12:00:00.000Z");
		await db
			.update(apiTokens)
			.set({ createdAt: past })
			.where(eq(apiTokens.userId, USER_A));
		expect((await tokenRow(USER_A)).pairedAt).not.toBeNull();

		await issuePairingToken(db, USER_A);

		const row = await tokenRow(USER_A);
		expect(row.pairedAt).toBeNull();
		expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(10_000);
	});
});

describe("getPairingStatus", () => {
	it("no row -> not paired, no token", async () => {
		expect(await getPairingStatus(db, USER_A)).toEqual({
			paired: false,
			hasToken: false,
		});
	});

	it("token generated but no hello yet -> hasToken without paired", async () => {
		await issuePairingToken(db, USER_A);
		expect(await getPairingStatus(db, USER_A)).toEqual({
			paired: false,
			hasToken: true,
		});
	});

	it("hello-style update flips paired to true (and only sets it once)", async () => {
		await issuePairingToken(db, USER_A);
		await helloStyleUpdate(USER_A);
		expect(await getPairingStatus(db, USER_A)).toEqual({
			paired: true,
			hasToken: true,
		});

		// Second hello must not move the original pairing time (/api/hello
		// only sets paired_at when null).
		const first = (await tokenRow(USER_A)).pairedAt;
		await helloStyleUpdate(USER_A);
		expect((await tokenRow(USER_A)).pairedAt).toEqual(first);
	});
});

describe("per-user isolation", () => {
	it("tokens, pairing, and regeneration are independent per user", async () => {
		const rawA = await issuePairingToken(db, USER_A);
		const rawB = await issuePairingToken(db, USER_B);

		// Each raw token resolves to its own user.
		expect((await lookupByRawToken(rawA))?.userId).toBe(USER_A);
		expect((await lookupByRawToken(rawB))?.userId).toBe(USER_B);

		// Pairing A does not pair B.
		await helloStyleUpdate(USER_A);
		expect((await getPairingStatus(db, USER_A)).paired).toBe(true);
		expect((await getPairingStatus(db, USER_B)).paired).toBe(false);

		// Regenerating A leaves B's token valid and A's pairing reset.
		await issuePairingToken(db, USER_A);
		expect(await lookupByRawToken(rawA)).toBeNull();
		expect((await lookupByRawToken(rawB))?.userId).toBe(USER_B);
		expect((await getPairingStatus(db, USER_A)).paired).toBe(false);
	});
});
