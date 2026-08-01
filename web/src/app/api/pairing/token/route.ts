// POST /api/pairing/token — SPEC §7. Session-authed (site user, NOT the
// extension token). Generates a fresh pairing token and returns the RAW
// token — the ONLY time it ever leaves the server; only its sha256 hex is
// stored. Regenerating invalidates the previous token AND un-pairs
// (paired_at reset to NULL): the extension must save the new token and
// /api/hello again.
import { z } from "zod";
import { db } from "../../../../db";
import { getAuthedUser } from "../../../../lib/auth";
import { issuePairingToken } from "../../../../lib/pairing";

// Node runtime: the postgres driver and node:crypto need it.
export const runtime = "nodejs";

// Body must be exactly {} — unknown fields rejected (repo convention).
const bodySchema = z.strictObject({});

export async function POST(request: Request) {
	const user = await getAuthedUser();
	if (!user) {
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

	const token = await issuePairingToken(db, user.id);
	return Response.json({ token });
}
