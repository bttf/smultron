// GET/PATCH /api/bookmarks/by-url — SPEC §8 (m10). Token-authed (same Bearer
// scheme as /api/sync and /api/highlights): the extension popup lives in
// URL-space, so it addresses the bookmark by the tab's RAW URL and the server
// normalizes (Hard rule #3, single implementation) to resolve the row by
// (user_id, url_normalized).
//
//   GET  ?url=<raw>  → 200 { bookmark: {...} | null } — bare bookmark, no
//                      nested highlights; null (still 200) when the user has
//                      no bookmark for that URL.
//   PATCH { url, title?, tags?, note?, archived? } → the bare updated
//                      bookmark; 404 when no bookmark matches. Same patch
//                      semantics as PATCH /api/bookmarks/:id — NEVER bumps
//                      `updated_at` (Hard rule #1).
import { z } from "zod";
import { db } from "../../../../db";
import { authenticateApiToken } from "../../../../lib/apiTokenAuth";
import {
	getBookmarkByUrl,
	patchBookmarkByUrl,
} from "../../../../lib/bookmarks";

// Node runtime: the postgres driver (and node:crypto) need it.
export const runtime = "nodejs";

const urlSchema = z.string().min(1);

export async function GET(request: Request) {
	const auth = await authenticateApiToken(request);
	if (!auth) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const raw = new URL(request.url).searchParams.get("url");
	const parsed = urlSchema.safeParse(raw ?? undefined);
	if (!parsed.success) {
		return Response.json({ error: "invalid_url" }, { status: 400 });
	}

	const bookmark = await getBookmarkByUrl(db, auth.userId, parsed.data);
	return Response.json({ bookmark });
}

const patchSchema = z
	.strictObject({
		url: z.string().min(1),
		// Field constraints mirror PATCH /api/bookmarks/:id exactly.
		title: z.string().max(2048).optional(),
		tags: z.array(z.string().min(1)).max(64).optional(),
		note: z.string().max(10_000).optional(),
		archived: z.boolean().optional(),
		pinned: z.boolean().optional(),
	})
	.refine(
		(data) =>
			data.title !== undefined ||
			data.tags !== undefined ||
			data.note !== undefined ||
			data.archived !== undefined ||
			data.pinned !== undefined,
		{ message: "at least one of title/tags/note/archived/pinned is required" },
	)
	// Mirrors PATCH /api/bookmarks/:id — archived+pinned both true is
	// contradictory (archiving unpins, pinning unarchives; SPEC §8, m13).
	.refine((data) => !(data.archived === true && data.pinned === true), {
		message: "archived and pinned cannot both be true",
	});

export async function PATCH(request: Request) {
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

	const parsed = patchSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const { url, ...input } = parsed.data;
	const updated = await patchBookmarkByUrl(db, auth.userId, url, input);
	if (!updated) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	return Response.json(updated);
}
