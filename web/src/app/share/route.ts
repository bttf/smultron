// GET /share — the manifest's Web Share Target action (m16, SPEC §8 web add).
// Android hands us `?title=&text=&url=`; we pull one URL out of whatever
// arrived (extractSharedUrl) and run the SAME `addBookmark` upsert as
// POST /api/bookmarks. A share IS a live capture, so bumping `updated_at` on
// conflict is correct here.
//
// Always answers with a 303 back to the feed carrying a `shared` status, since
// the browser navigates the user here — never JSON.
import { after } from "next/server";
import { z } from "zod";
import { db } from "../../db";
import { getAuthedUser } from "../../lib/auth";
import { enrichBookmarkMetadata } from "../../lib/bookmarkMetadata";
import { addBookmark } from "../../lib/bookmarks";
import { scrapePageMetadata } from "../../lib/firecrawl";
import { extractSharedUrl } from "../../lib/shareTarget";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

// The metadata fill (below) runs in `after()`, inside this invocation.
export const maxDuration = 60;

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
	// CSRF guard: this GET writes to the DB, and auth cookies are SameSite=Lax,
	// so any site could top-level-navigate a signed-in user here. Real share
	// launches arrive as Sec-Fetch-Site "none" (or without the header on older
	// WebViews) and in-app navigations as "same-origin" — only reject what is
	// provably cross-site.
	if (request.headers.get("sec-fetch-site") === "cross-site") {
		return seeOther(request, "/?shared=invalid");
	}

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

	// A transient DB failure should land the user back on the feed, not on a
	// bare 500 — this is a browser navigation, never an API call.
	try {
		const { bookmark, created } = await addBookmark(db, user.id, sharedUrl);
		// m17 metadata fill (SPEC §5), same as the Add composer's — but never
		// waited on: this response is a redirect the share sheet is holding the
		// user on. The title/favicon land on the feed's next poll.
		after(
			enrichBookmarkMetadata(db, scrapePageMetadata, {
				userId: user.id,
				bookmarkId: bookmark.id,
			}),
		);
		return seeOther(request, created ? "/?shared=added" : "/?shared=exists");
	} catch {
		return seeOther(request, "/?shared=error");
	}
}
