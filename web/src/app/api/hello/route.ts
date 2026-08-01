// POST /api/hello — SPEC §8. Extension pairing handshake: token auth, body
// exactly `{}`, sets paired_at on FIRST hello only (§3: "set on first
// /api/hello" — subsequent hellos must not move the pairing time).
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { apiTokens } from "../../../db/schema";
import { authenticateApiToken } from "../../../lib/apiTokenAuth";

// Node runtime: the postgres driver (and node:crypto) need it.
export const runtime = "nodejs";

// Body must be exactly {} — unknown fields rejected (repo convention).
const bodySchema = z.strictObject({});

export async function POST(request: Request) {
	const auth = await authenticateApiToken(request);
	if (!auth) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid_json" }, { status: 400 });
	}

	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	// Set paired_at ONLY if currently null, preserving the first-pair time.
	await db
		.update(apiTokens)
		.set({ pairedAt: sql`now()` })
		.where(and(eq(apiTokens.userId, auth.userId), isNull(apiTokens.pairedAt)));

	return Response.json({ ok: true });
}
