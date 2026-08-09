// GET /api/bookmarks — SPEC §8. Session-authed. `q`/`cursor`/`archived`/`tag`
// are URL search params (not a body), validated with a strict-ish Zod schema:
// `archived` accepts ONLY the literal "1" (see bookmarks.ts header for the
// archived-view semantics decision); `tag` is repeatable (?tag=a&tag=b, AND
// semantics — see bookmarks.ts) and each value must be non-empty; unknown
// params are ignored since `URLSearchParams` access is by name, not by
// iterating the whole query string.
//
// POST /api/bookmarks — SPEC §8 (m11 web add). Session-authed; body
// `{ url }`, unknown fields rejected. Applies the §5 web-add upsert
// (insert with hostname-autofilled title, or bump+unarchive on conflict)
// and returns that row IMMEDIATELY (m18); the metadata fill runs in
// `after()`, never in the request the user is waiting on.
import { after } from "next/server";
import { z } from "zod";
import { db } from "../../../db";
import { getAuthedUser } from "../../../lib/auth";
import { enrichBookmarkMetadata } from "../../../lib/bookmarkMetadata";
import {
	addBookmark,
	InvalidCursorError,
	listBookmarks,
} from "../../../lib/bookmarks";
import { scrapePageMetadata } from "../../../lib/firecrawl";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

// The POST response ships immediately, but the invocation stays alive for the
// `after()` metadata fill (a Firecrawl summary scrape: ~5-15s on a cache miss)
// — that needs headroom over Vercel's 10s default. 60s is the Hobby-plan
// ceiling and far more than the fill uses.
export const maxDuration = 60;

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

// Mirrors the title cap on PATCH (url column has no DB limit; this is a
// sanity bound, not a spec constant).
const postBodySchema = z.strictObject({
	url: z.string().min(1).max(2048),
});

export async function POST(request: Request) {
	const user = await getAuthedUser();
	if (!user) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid_json" }, { status: 400 });
	}

	const parsed = postBodySchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	// The UI prepends https:// to scheme-less input before sending; the server
	// still requires a parseable http(s) URL with a dotted hostname so junk
	// never becomes a row (SPEC §8).
	const raw = parsed.data.url.trim();
	let parsedUrl: URL | null = null;
	try {
		parsedUrl = new URL(raw);
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

	const { bookmark, created } = await addBookmark(db, user.id, raw);

	// m17 (SPEC §5): a typed-in URL has no title beyond its hostname and no
	// favicon, so ask the page. The add itself is already committed — this only
	// ever fills columns in, never fails the request, and never bumps
	// `updated_at`. m18 (SPEC §5/§8): NOTHING waits on it. The response below
	// carries the un-filled row and the fill always finishes in `after()`,
	// reaching the feed on a later SWR poll; the client owns the "still
	// filling" affordance (§9), so the server keeps no fill-status state. A
	// re-add of an already-filled bookmark short-circuits inside
	// `enrichBookmarkMetadata` without scraping.
	after(
		enrichBookmarkMetadata(db, scrapePageMetadata, {
			userId: user.id,
			bookmarkId: bookmark.id,
		}),
	);

	return Response.json({ bookmark, created }, { status: created ? 201 : 200 });
}
