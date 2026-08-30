// PUT /api/bookmarks/pinned — SPEC §8 (m21 shelf reordering). Session-authed
// OR Bearer-token-authed, resolved exactly like GET /api/bookmarks: the
// extension's new tab page reorders its shelf with the pairing token, the
// site's feed with the session cookie (see requestAuth.ts — an Authorization
// header commits the request to the token path and never falls back).
//
// A static segment, so it wins over `[id]` the way `by-url` does.
//
// Body `{ ids }` — the caller's pinned bookmark ids in the order the shelf
// should take. Lenient by design (the shelf can change under a drag): ids
// that are not, or no longer, pinned — or not the caller's — are ignored, and
// pinned rows missing from the list trail the listed ones in their prior
// order. Nothing is created, unpinned or archived here, and the reorder NEVER
// bumps `updated_at` (Hard rule #1) or touches `pinned_at`.
//
// Returns `{ pinned }`: the whole shelf in its new order, the same shape as
// the listing's `pinned` (highlights nested), so a client swaps it in as-is.
import { z } from "zod";
import { db } from "../../../../db";
import { authenticateApiToken } from "../../../../lib/apiTokenAuth";
import { getAuthedUser } from "../../../../lib/auth";
import { reorderPinned } from "../../../../lib/bookmarks";
import { authenticateRequest } from "../../../../lib/requestAuth";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

// 1000 is a sanity bound far above any real shelf; duplicates are a client
// bug (a drag can't produce them), so they are rejected rather than silently
// collapsed — unlike ids the server merely doesn't recognize, which are a
// legitimate mid-drag race and stay lenient in `reorderPinned`.
const bodySchema = z
	.strictObject({
		ids: z.array(z.number().int().positive()).min(1).max(1000),
	})
	.refine((data) => new Set(data.ids).size === data.ids.length, {
		message: "ids must be unique",
	});

export async function PUT(request: Request) {
	const userId = await authenticateRequest(request, {
		resolveToken: authenticateApiToken,
		resolveSession: getAuthedUser,
	});
	if (!userId) {
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

	const pinned = await reorderPinned(db, userId, parsed.data.ids);
	return Response.json({ pinned });
}
