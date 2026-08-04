// PATCH /api/bookmarks/:id — SPEC §8. Session-authed; body is a subset of
// { title, tags, note, archived } with at least one key, unknown fields
// rejected. `note` is trimmed server-side; empty-after-trim clears it to
// NULL. Site edits NEVER bump updated_at (Hard rule #1).
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
		// Mirrors the highlights text cap (SPEC §8).
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
	// Archiving unpins and pinning unarchives (SPEC §8, m13) — asking for
	// both at once is contradictory, so reject it instead of picking a winner.
	.refine((data) => !(data.archived === true && data.pinned === true), {
		message: "archived and pinned cannot both be true",
	});

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
