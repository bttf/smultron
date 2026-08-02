// GET /api/bookmarks — SPEC §8. Session-authed. `q`/`cursor`/`archived`/`tag`
// are URL search params (not a body), validated with a strict-ish Zod schema:
// `archived` accepts ONLY the literal "1" (see bookmarks.ts header for the
// archived-view semantics decision); `tag` is repeatable (?tag=a&tag=b, AND
// semantics — see bookmarks.ts) and each value must be non-empty; unknown
// params are ignored since `URLSearchParams` access is by name, not by
// iterating the whole query string.
import { z } from "zod";
import { db } from "../../../db";
import { getAuthedUser } from "../../../lib/auth";
import { InvalidCursorError, listBookmarks } from "../../../lib/bookmarks";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

const querySchema = z.object({
	q: z.string().optional(),
	cursor: z.string().optional(),
	archived: z.literal("1").optional(),
	tag: z.array(z.string().min(1)),
});

export async function GET(request: Request) {
	const user = await getAuthedUser();
	if (!user) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const parsed = querySchema.safeParse({
		q: url.searchParams.get("q") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
		archived: url.searchParams.get("archived") ?? undefined,
		tag: url.searchParams.getAll("tag"),
	});
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_query", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const { q, cursor, archived, tag } = parsed.data;

	try {
		const result = await listBookmarks(db, user.id, {
			q,
			cursor,
			archived: archived === "1",
			tags: tag,
		});
		return Response.json(result);
	} catch (err) {
		if (err instanceof InvalidCursorError) {
			return Response.json({ error: "invalid_cursor" }, { status: 400 });
		}
		throw err;
	}
}
