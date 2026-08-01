// GET /api/bookmarks — SPEC §8. Session-authed. `q`/`cursor`/`archived` are
// URL search params (not a body), validated with a strict-ish Zod schema:
// `archived` accepts ONLY the literal "1" (see bookmarks.ts header for the
// archived-view semantics decision); unknown params are ignored since
// `URLSearchParams` access is by name, not by iterating the whole query
// string.
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
	});
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_query", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const { q, cursor, archived } = parsed.data;

	try {
		const result = await listBookmarks(db, user.id, {
			q,
			cursor,
			archived: archived === "1",
		});
		return Response.json(result);
	} catch (err) {
		if (err instanceof InvalidCursorError) {
			return Response.json({ error: "invalid_cursor" }, { status: 400 });
		}
		throw err;
	}
}
