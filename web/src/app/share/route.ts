// GET /share — the manifest's Web Share Target action (m14, SPEC §8 web add).
// Android hands us `?title=&text=&url=`; we pull one URL out of whatever
// arrived (extractSharedUrl) and run the SAME `addBookmark` upsert as
// POST /api/bookmarks. A share IS a live capture, so bumping `updated_at` on
// conflict is correct here.
//
// Always answers with a 303 back to the feed carrying a `shared` status, since
// the browser navigates the user here — never JSON.
import { z } from "zod";
import { db } from "../../db";
import { getAuthedUser } from "../../lib/auth";
import { addBookmark } from "../../lib/bookmarks";
import { extractSharedUrl } from "../../lib/shareTarget";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

// Share sheets append junk params; we read by name and ignore the rest.
const shareSchema = z.object({
	title: z.string().optional(),
	text: z.string().optional(),
	url: z.string().optional(),
});

function seeOther(request: Request, target: string): Response {
	return Response.redirect(new URL(target, request.url), 303);
}

export async function GET(request: Request) {
	// The proxy already redirects unauthenticated page requests, but routes
	// are the authority (src/proxy.ts header) — guard anyway.
	const user = await getAuthedUser();
	if (!user) {
		return seeOther(request, "/login");
	}

	const { searchParams } = new URL(request.url);
	const parsed = shareSchema.safeParse({
		title: searchParams.get("title") ?? undefined,
		text: searchParams.get("text") ?? undefined,
		url: searchParams.get("url") ?? undefined,
	});
	if (!parsed.success) {
		return seeOther(request, "/?shared=invalid");
	}

	const sharedUrl = extractSharedUrl(parsed.data);
	if (!sharedUrl) {
		return seeOther(request, "/?shared=invalid");
	}

	const { created } = await addBookmark(db, user.id, sharedUrl);
	return seeOther(request, created ? "/?shared=added" : "/?shared=exists");
}
