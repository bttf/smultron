// Extension API token auth — SPEC §7 (API auth).
// `Authorization: Bearer <token>` → sha256 → lookup in smultron.api_tokens.
// The raw token is never stored; the hash is the lookup key. Hashes are
// hex-encoded sha256 — token generation (pairing flow, milestone 5) must use
// the same encoding.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiTokens } from "../db/schema";

export type ApiTokenAuth = {
	userId: string;
	pairedAt: Date | null;
};

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Resolves the user behind a Bearer token, or null (caller responds 401).
 * Uses the service-role Drizzle client — never callable client-side.
 */
export async function authenticateApiToken(
	request: Request,
): Promise<ApiTokenAuth | null> {
	const header = request.headers.get("authorization");
	if (!header) {
		return null;
	}

	const match = BEARER_RE.exec(header.trim());
	const token = match?.[1]?.trim();
	if (!token) {
		return null;
	}

	const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

	const rows = await db
		.select({ userId: apiTokens.userId, pairedAt: apiTokens.pairedAt })
		.from(apiTokens)
		.where(eq(apiTokens.tokenHash, tokenHash))
		.limit(1);

	return rows[0] ?? null;
}
