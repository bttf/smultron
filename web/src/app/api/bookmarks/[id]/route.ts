// PATCH /api/bookmarks/:id — SPEC §8. Session-authed; body is a subset of
// { url, title, tags, note, archived, pinned } with at least one key, unknown
// fields rejected. `note` is trimmed server-side; empty-after-trim clears it
// to NULL. Site edits NEVER bump updated_at (Hard rule #1).
//
// `url` (m22) is accepted HERE ONLY — `PATCH /api/bookmarks/by-url` resolves
// rows BY url and deliberately cannot edit one. It is validated exactly like a
// web add's (POST /api/bookmarks): trimmed, parseable, http(s), dotted
// hostname — so a `chrome://`-style bookmark's URL is not editable, accepted.
// A collision with another of the caller's rows is a 409 carrying the
// conflicting row, never a silent merge.
// `id` is a dynamic route param — a Promise in Next 16 (see
// node_modules/next/dist/docs/.../dynamic-routes.md).
import { z } from "zod";
import { db } from "../../../../db";
import { getAuthedUser } from "../../../../lib/auth";
import { DuplicateUrlError, patchBookmark } from "../../../../lib/bookmarks";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

const idSchema = z
	.string()
	.regex(/^[1-9]\d*$/, "id must be a positive integer")
	.transform(Number);

const bodySchema = z
	.strictObject({
		// Same cap as POST /api/bookmarks; the shape is checked imperatively
		// below (Zod can't express "parseable http(s) with a dotted hostname").
		url: z.string().max(2048).optional(),
		title: z.string().max(2048).optional(),
		tags: z.array(z.string().min(1)).max(64).optional(),
		// Mirrors the highlights text cap (SPEC §8).
		note: z.string().max(10_000).optional(),
		archived: z.boolean().optional(),
		pinned: z.boolean().optional(),
	})
	.refine(
		(data) =>
			data.url !== undefined ||
			data.title !== undefined ||
			data.tags !== undefined ||
			data.note !== undefined ||
			data.archived !== undefined ||
			data.pinned !== undefined,
		{
			message:
				"at least one of url/title/tags/note/archived/pinned is required",
		},
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

	// m22: same URL shape check as POST /api/bookmarks — the client prepends
	// https:// to scheme-less input, the server still requires a parseable
	// http(s) URL with a dotted hostname so junk never becomes a row.
	const patch = parsed.data;
	let url: string | undefined;
	if (patch.url !== undefined) {
		url = patch.url.trim();
		let parsedUrl: URL | null = null;
		try {
			parsedUrl = new URL(url);
		} catch {
			parsedUrl = null;
		}
		if (
			!parsedUrl ||
			(parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
			!parsedUrl.hostname.includes(".")
		) {
			return Response.json({ error: "invalid_url" }, { status: 400 });
		}
	}

	let updated: Awaited<ReturnType<typeof patchBookmark>>;
	try {
		updated = await patchBookmark(db, user.id, idResult.data, {
			...patch,
			url,
		});
	} catch (err) {
		if (err instanceof DuplicateUrlError) {
			// The new key already belongs to another of the caller's rows.
			// Nothing was written; hand the client the row it collided with.
			return Response.json(
				{ error: "duplicate_url", conflict: err.conflict },
				{ status: 409 },
			);
		}
		throw err;
	}

	if (!updated) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	return Response.json(updated);
}
