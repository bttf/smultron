// POST /api/browse-events — SPEC §8/§13. Token-authed write path for the
// extension's attention-tracking capture. Validates the batch (strict at
// every level, per-kind field requirements) then delegates to
// applyBrowseEvents, which normalizes URLs server-side (Hard rule #3) and
// inserts append-only with ON CONFLICT DO NOTHING.
//
// GET /api/browse-events — SPEC §8/§9. Session-authed feed for the /events
// log view: `q`, repeatable `kind`, and `cursor` search params.
//
// This path is deliberately still covered by the proxy matcher (SPEC §7):
// the same path carries both a Bearer-authed POST and a session-authed GET,
// and matched `/api/*` is never redirected.
//
// NOTHING here touches the bookmarks table (Hard rule #1 / SPEC §13).
import { z } from "zod";
import { db } from "../../../db";
import { BROWSE_EVENT_KINDS } from "../../../db/schema";
import { authenticateApiToken } from "../../../lib/apiTokenAuth";
import { getAuthedUser } from "../../../lib/auth";
import {
	applyBrowseEvents,
	browseEventsBodySchema,
	InvalidCursorError,
	listBrowseEvents,
} from "../../../lib/browseEvents";

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

	const parsed = browseEventsBodySchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const result = await applyBrowseEvents(db, auth.userId, parsed.data.events);

	return Response.json(result);
}

// `kind` is repeatable (?kind=nav&kind=idle) and each value must be one of the
// §13 kinds — an unknown value is a 400, not a silently-empty filter. Unknown
// params are ignored: `URLSearchParams` access is by name, not by iterating
// the whole query string (same as GET /api/bookmarks).
const querySchema = z.object({
	q: z.string().optional(),
	kind: z.array(z.enum(BROWSE_EVENT_KINDS)),
	cursor: z.string().optional(),
});

export async function GET(request: Request) {
	const user = await getAuthedUser();
	if (!user) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const parsed = querySchema.safeParse({
		q: url.searchParams.get("q") ?? undefined,
		kind: url.searchParams.getAll("kind"),
		cursor: url.searchParams.get("cursor") ?? undefined,
	});
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_query", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const { q, kind, cursor } = parsed.data;

	try {
		const result = await listBrowseEvents(db, user.id, {
			q,
			kinds: kind,
			cursor,
		});
		return Response.json(result);
	} catch (err) {
		if (err instanceof InvalidCursorError) {
			return Response.json({ error: "invalid_cursor" }, { status: 400 });
		}
		throw err;
	}
}
