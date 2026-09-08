// DELETE /api/bookmarks/:id/screenshot — SPEC §15.2 (RED-206).
//
// The site's "Clear screenshot" action: the capture is wrong, blank or simply
// unwanted, so the row goes back to the plain card style and becomes eligible
// for a fresh upload (the upload endpoint is keep-first, so it only ever fills
// an empty slot).
//
// SESSION-authed, like `PATCH /api/bookmarks/:id` — this is a site edit, not
// an extension write, and the by-url/Bearer family deliberately has no
// overwrite path. 401 unauthenticated; 404 when the row is not the caller's or
// does not exist (another user's row is invisible to the user-scoped query, so
// it is a 404 and never a 403).
//
//   200 { bookmark }  — the bare row (no nested highlights), `screenshotUrl`
//                       now null. A row that had no screenshot answers the
//                       same way: clearing is idempotent.
//
// The Storage object is deleted best-effort AFTER the row stops pointing at
// it: a failed delete leaks an unreferenced object, which is strictly better
// than a card still showing a screenshot the user asked to remove.
//
// CRITICAL (Hard rule #1): the UPDATE writes `screenshot_path` and nothing
// else — `updated_at`, `pinned_at`, `pin_position` and `archived_at` are
// untouched.
//
// `id` is a dynamic route param — a Promise in Next 16.
import { z } from "zod";
import { db } from "../../../../../db";
import { getAuthedUser } from "../../../../../lib/auth";
import { clearScreenshot } from "../../../../../lib/bookmarks";
import { deleteScreenshot } from "../../../../../lib/storage";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

const idSchema = z
	.string()
	.regex(/^[1-9]\d*$/, "id must be a positive integer")
	.transform(Number);

export async function DELETE(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const user = await getAuthedUser();
	if (!user) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const { id: idParam } = await params;
	const idResult = idSchema.safeParse(idParam);
	if (!idResult.success) {
		return Response.json({ error: "invalid_id" }, { status: 400 });
	}

	const result = await clearScreenshot(db, user.id, idResult.data);
	if (!result) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	if (result.clearedPath !== null) {
		// `deleteScreenshot` already swallows its own failures; the catch keeps
		// the "a failed delete never fails the request" guarantee local to the
		// route, where it is part of the contract rather than a detail of the
		// helper.
		await deleteScreenshot(result.clearedPath).catch(() => {});
	}

	return Response.json({ bookmark: result.bookmark });
}
