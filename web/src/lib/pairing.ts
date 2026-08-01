// Extension pairing token lifecycle — SPEC §7 (Extension pairing).
//
// The raw token is 32 random bytes, base64url-encoded (43 chars, no padding).
// Only its sha256 HEX digest is ever stored (`api_tokens.token_hash`) — the
// same encoding `authenticateApiToken` (apiTokenAuth.ts) hashes Bearer tokens
// with, so a token issued here is found by that lookup verbatim.
//
// Regenerating a token REPLACES the stored hash and resets `paired_at` to
// NULL: the old token stops authenticating immediately AND the user is
// un-paired — the extension must save the new token and send /api/hello again
// before /api/sync traffic counts as paired.
import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { apiTokens } from "../db/schema";

// Accept any Drizzle Postgres database (postgres-js in prod, PGlite in
// tests) — same pattern as SyncDb in sync.ts.
// biome-ignore lint/suspicious/noExplicitAny: variance of Drizzle's driver-specific generics requires it; the schema/relations generics are irrelevant here.
export type PairingDb = PgDatabase<PgQueryResultHKT, any, any>;

export const TOKEN_BYTES = 32;

/** 32 random bytes as base64url — 43 chars, URL-safe, no padding. */
export function generateRawToken(): string {
	return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** sha256 of the raw token, HEX-encoded — the api_tokens.token_hash format. */
export function hashToken(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Issues a fresh pairing token for the user (PK user_id — one token per
 * user). Upsert: a first-time generate inserts; a regenerate overwrites the
 * hash, resets paired_at to NULL (un-pairs), and refreshes created_at to the
 * new token's creation time.
 *
 * Returns the RAW token — the only place it ever exists outside the
 * caller's response; it is never stored or logged.
 */
export async function issuePairingToken(
	db: PairingDb,
	userId: string,
): Promise<string> {
	const raw = generateRawToken();
	const tokenHash = hashToken(raw);

	await db
		.insert(apiTokens)
		.values({ userId, tokenHash, pairedAt: null })
		.onConflictDoUpdate({
			target: apiTokens.userId,
			set: { tokenHash, pairedAt: null, createdAt: sql`now()` },
		});

	return raw;
}

export type PairingStatus = {
	/** A token row exists AND the extension has said hello (paired_at set). */
	paired: boolean;
	/** A token has been generated (whether or not it's been paired yet). */
	hasToken: boolean;
};

export async function getPairingStatus(
	db: PairingDb,
	userId: string,
): Promise<PairingStatus> {
	const rows = await db
		.select({ pairedAt: apiTokens.pairedAt })
		.from(apiTokens)
		.where(eq(apiTokens.userId, userId))
		.limit(1);

	const row = rows[0];
	return { hasToken: row !== undefined, paired: row?.pairedAt != null };
}
