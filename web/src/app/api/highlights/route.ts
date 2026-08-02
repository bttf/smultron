// POST /api/highlights — SPEC §8. Token-authed (same Bearer scheme as
// /api/sync) write path for the extension's context-menu capture. Validates
// strictly, then delegates to applyHighlight, the single implementation of
// §5 highlight semantics (insert + bump + unarchive, atomically). The URL
// arrives RAW; normalization happens server-side inside applyHighlight
// (Hard rule #3). No matching bookmark → 409, which the extension treats as
// poison and drops (§6).
import { z } from "zod";
import { db } from "../../../db";
import { authenticateApiToken } from "../../../lib/apiTokenAuth";
import { applyHighlight } from "../../../lib/highlights";

// Node runtime: the postgres driver (and node:crypto) need it.
export const runtime = "nodejs";

const bodySchema = z.strictObject({
	url: z.string().min(1),
	// SPEC §8: min(1).max(10000); the extension truncates to 10 000 chars.
	text: z.string().min(1).max(10_000),
});

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

	const created = await applyHighlight(db, auth.userId, parsed.data);
	if (!created) {
		return Response.json({ error: "no_bookmark" }, { status: 409 });
	}

	return Response.json(created);
}
