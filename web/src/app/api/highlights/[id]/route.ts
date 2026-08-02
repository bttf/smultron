// DELETE /api/highlights/:id — SPEC §8. Session-authed, ownership-checked
// HARD delete (allowed for highlights — the soft-delete rule is scoped to
// bookmarks, SPEC §3). `id` is a dynamic route param — a Promise in Next 16
// (see node_modules/next/dist/docs/.../dynamic-routes.md).
import { z } from "zod";
import { db } from "../../../../db";
import { getAuthedUser } from "../../../../lib/auth";
import { deleteHighlight } from "../../../../lib/highlights";

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

	const deleted = await deleteHighlight(db, user.id, idResult.data);
	if (!deleted) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	return Response.json({ ok: true });
}
