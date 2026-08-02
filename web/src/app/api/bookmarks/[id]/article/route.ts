// GET/POST /api/bookmarks/:id/article — SPEC §10.
//
// POST starts (or resumes) the scrape → clean → summarize pipeline and
// returns 202 immediately; the work runs in `after()`, past the response.
// GET is the poll the UI drives from SWR.
//
// Why 202 + poll rather than one blocking request: a scrape alone can take a
// minute, and the clean pass over a long article is several LLM round trips.
// Holding the request open for that invites platform timeouts and gives the
// user no progress. The status machine lives in lib/articles.ts.
//
// `id` is a dynamic route param — a Promise in Next 16.
import { after } from "next/server";
import { z } from "zod";
import { db } from "../../../../../db";
import {
	type ArticleView,
	claimArticleRun,
	getArticle,
	getBookmarkUrl,
	runArticleJob,
} from "../../../../../lib/articles";
import { getAuthedUser } from "../../../../../lib/auth";
import { scrapeArticle } from "../../../../../lib/firecrawl";
import {
	cleanToTranscript,
	summarizeTranscript,
} from "../../../../../lib/transcript";
import { configuredVoice } from "../../../../../lib/tts";

// Node runtime: the postgres driver and the Anthropic SDK need it.
export const runtime = "nodejs";

// The `after()` callback runs inside this same invocation and counts against
// this budget. 300s is Vercel's ceiling on paid plans (60s on Hobby); a run
// that gets killed anyway is resumable — its finished steps are already
// persisted, so a retry picks up where it stopped (SPEC §10).
export const maxDuration = 300;

const idSchema = z
	.string()
	.regex(/^[1-9]\d*$/, "id must be a positive integer")
	.transform(Number);

const bodySchema = z.strictObject({
	/** Discard the cached scrape/transcript and redo the whole pipeline. */
	refresh: z.boolean().optional(),
});

/** Wire shape for an article. `transcript` can be large but the reader needs it. */
function serialize(article: ArticleView) {
	return {
		id: article.id,
		bookmarkId: article.bookmarkId,
		status: article.status,
		error: article.error,
		sourceUrl: article.sourceUrl,
		title: article.title,
		transcript: article.transcript,
		summary: article.summary,
		wordCount: article.wordCount,
		audioKinds: article.audioKinds,
		createdAt: article.createdAt,
		updatedAt: article.updatedAt,
	};
}

export async function GET(
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

	// 404 on someone else's (or a missing) bookmark, so this endpoint can't be
	// used to probe which ids exist.
	if ((await getBookmarkUrl(db, user.id, idResult.data)) === null) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	const article = await getArticle(
		db,
		user.id,
		idResult.data,
		configuredVoice(),
	);

	// 200 with `article: null` — "not scraped yet" is a normal state, not an
	// error (same shape as GET /api/bookmarks/by-url).
	return Response.json({ article: article ? serialize(article) : null });
}

export async function POST(
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
	const bookmarkId = idResult.data;

	// An empty body is a valid "just start it" request.
	let body: unknown = {};
	const raw = await request.text();
	if (raw.trim() !== "") {
		try {
			body = JSON.parse(raw);
		} catch {
			return Response.json({ error: "invalid_json" }, { status: 400 });
		}
	}

	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const url = await getBookmarkUrl(db, user.id, bookmarkId);
	if (url === null) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	const claimed = await claimArticleRun(db, user.id, bookmarkId, {
		reset: parsed.data.refresh,
	});

	if (!claimed) {
		// A run is already in flight — report its state rather than starting a
		// second pipeline over the same bookmark.
		const current = await getArticle(
			db,
			user.id,
			bookmarkId,
			configuredVoice(),
		);
		return Response.json(
			{ article: current ? serialize(current) : null, started: false },
			{ status: 202 },
		);
	}

	// Fire-and-forget past the response. runArticleJob never rejects — it
	// writes failures onto the row — so there is nothing here to catch.
	after(async () => {
		await runArticleJob(
			db,
			{
				scrape: scrapeArticle,
				clean: cleanToTranscript,
				summarize: summarizeTranscript,
			},
			{ articleId: claimed.id, url },
		);
	});

	const view = await getArticle(db, user.id, bookmarkId, configuredVoice());
	return Response.json(
		{ article: view ? serialize(view) : null, started: true },
		{ status: 202 },
	);
}
