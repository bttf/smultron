// PATCH /api/bookmarks/:id — SPEC §8. Session-authed; body is a subset of
// { title, tags, archived } with at least one key, unknown fields rejected.
// `id` is a dynamic route param — a Promise in Next 16 (see
// node_modules/next/dist/docs/.../dynamic-routes.md).
import { z } from "zod";
import { db } from "../../../../db";
import { getAuthedUser } from "../../../../lib/auth";
import { patchBookmark } from "../../../../lib/bookmarks";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

const idSchema = z
	.string()
	.regex(/^[1-9]\d*$/, "id must be a positive integer")
	.transform(Number);

const bodySchema = z
	.strictObject({
		title: z.string().max(2048).optional(),
		tags: z.array(z.string().min(1)).max(64).optional(),
		archived: z.boolean().optional(),
	})
	.refine(
		(data) =>
			data.title !== undefined ||
			data.tags !== undefined ||
			data.archived !== undefined,
		{ message: "at least one of title/tags/archived is required" },
	);

export async function PATCH(
	request: Request,
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

	const updated = await patchBookmark(db, user.id, idResult.data, parsed.data);
	if (!updated) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	return Response.json(updated);
}
