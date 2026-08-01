// POST /api/sync — SPEC §8. Token-authed write path for the extension.
// Validates the payload (strict at every level), then delegates to
// applySync, the single implementation of §5 upsert semantics. URLs arrive
// RAW; normalization happens server-side inside applySync (Hard rule #3).
import { z } from "zod";
import { db } from "../../../db";
import { authenticateApiToken } from "../../../lib/apiTokenAuth";
import { applySync } from "../../../lib/sync";

// Node runtime: the postgres driver (and node:crypto) need it.
export const runtime = "nodejs";

// Max representable JS Date timestamp — bounds dateAddedMs so `new Date()`
// can never produce an Invalid Date.
const MAX_DATE_MS = 8_640_000_000_000_000;

const bookmarkSchema = z.strictObject({
	// URL must be non-empty; title MAY be empty (Chrome allows empty titles).
	url: z.string().min(1),
	title: z.string(),
	chromeId: z.string().min(1),
	dateAddedMs: z.number().int().min(0).max(MAX_DATE_MS).optional(),
	folderPath: z.string().optional(),
});

const bodySchema = z.strictObject({
	mode: z.enum(["live", "backfill"]),
	// SPEC §8: max 500 per batch. Violation is a plain 400 (not 413) with a
	// descriptive issue list, like every other validation failure.
	bookmarks: z.array(bookmarkSchema).max(500),
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

	const { mode, bookmarks } = parsed.data;
	const result = await applySync(db, auth.userId, mode, bookmarks);

	return Response.json(result);
}
