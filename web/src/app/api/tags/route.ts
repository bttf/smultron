// GET /api/tags — SPEC §8 (m14). Token-authed (same Bearer scheme as
// /api/sync and /api/bookmarks/by-url): the extension popup's add-tag input
// needs the caller's existing tags to autocomplete against.
//
//   GET → 200 { tags: string[] } — distinct tags across ALL the caller's
//         bookmarks (archived included), ordered usage count desc then tag
//         asc, uncapped. No parameters, no body.
import { db } from "../../../db";
import { authenticateApiToken } from "../../../lib/apiTokenAuth";
import { listTags } from "../../../lib/tags";

// Node runtime: the postgres driver (and node:crypto) need it.
export const runtime = "nodejs";

export async function GET(request: Request) {
	const auth = await authenticateApiToken(request);
	if (!auth) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	return Response.json({ tags: await listTags(db, auth.userId) });
}
