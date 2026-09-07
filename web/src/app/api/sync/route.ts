// POST /api/sync — SPEC §8. Token-authed write path for the extension.
// Validates the payload (strict at every level, `syncBodySchema` in lib/sync
// beside the semantics it feeds), then delegates to applySync, the single
// implementation of §5 upsert semantics. URLs arrive RAW; normalization
// happens server-side inside applySync (Hard rule #3).
import { db } from "../../../db";
import { authenticateApiToken } from "../../../lib/apiTokenAuth";
import { applySync, syncBodySchema } from "../../../lib/sync";

// Node runtime: the postgres driver (and node:crypto) need it.
export const runtime = "nodejs";

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

	const parsed = syncBodySchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const { mode, bookmarks } = parsed.data;
	const result = await applySync(db, auth.userId, mode, bookmarks);

	return Response.json(result);
}
