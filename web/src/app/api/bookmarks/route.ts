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
// (insert with hostname-autofilled title, or bump+unarchive on conflict),
// then WAITS (bounded) on the m15 Firecrawl metadata fill so the row it
// returns already carries the page's real title and favicon.
import { after } from "next/server";
import { z } from "zod";
import { db } from "../../../db";
import { getAuthedUser } from "../../../lib/auth";
import {
	enrichBookmarkMetadata,
	METADATA_WAIT_MS,
	settleWithin,
} from "../../../lib/bookmarkMetadata";
import {
	addBookmark,
	InvalidCursorError,
	listBookmarks,
} from "../../../lib/bookmarks";
import { scrapePageMetadata } from "../../../lib/firecrawl";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

// POST holds the request open for the metadata fill (METADATA_WAIT_MS) and,
// past that, lets it finish in `after()` inside this same invocation — both
// need headroom over Vercel's 10s default. 60s is the Hobby-plan ceiling and
// is far more than either path uses.
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

	// m15 (SPEC §5): a typed-in URL has no title beyond its hostname and no
	// favicon, so ask the page. The add itself is already committed — this only
	// ever fills columns in, never fails the request, and never bumps
	// `updated_at`. We wait on it (bounded) rather than firing it into the
	// background so the row the composer flashes is the finished one; past the
	// deadline the fill continues in `after()` and reaches the UI on the next
	// SWR poll. A re-add of an already-filled bookmark short-circuits inside
	// `enrichBookmarkMetadata` without scraping, so duplicates stay instant.
	const fill = enrichBookmarkMetadata(db, scrapePageMetadata, {
		userId: user.id,
		bookmarkId: bookmark.id,
	});
	const filled = await settleWithin(fill, METADATA_WAIT_MS);
	if (filled === undefined) {
		after(fill);
	}

	return Response.json(
		{ bookmark: filled ?? bookmark, created },
		{ status: created ? 201 : 200 },
	);
}
