// POST /api/bookmarks/:id/article/audio — SPEC §10.
//
// Returns a playable, time-limited URL for one of the article's two spoken
// forms: the LLM summary, or the full cleaned transcript. Synthesis happens
// on first request for a given (article, kind, voice) and is cached in
// Supabase Storage thereafter, so replays and seeking cost nothing.
//
// Synchronous, unlike the article pipeline: a summary is a single TTS call,
// and even a long transcript's segments are synthesized concurrently. The
// caller sees one "preparing audio" spinner rather than a second poll loop.
import { z } from "zod";
import { db } from "../../../../../../db";
import {
	type AudioKind,
	getArticle,
	getAudio,
	getBookmarkUrl,
	saveAudio,
} from "../../../../../../lib/articles";
import { getAuthedUser } from "../../../../../../lib/auth";
import { PipelineError } from "../../../../../../lib/pipelineError";
import {
	audioObjectPath,
	createSignedUrl,
	uploadAudio,
} from "../../../../../../lib/storage";
import { configuredVoice, synthesizeSpeech } from "../../../../../../lib/tts";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

// Synthesis of a long transcript is many chunked TTS calls; give it room.
export const maxDuration = 300;

const idSchema = z
	.string()
	.regex(/^[1-9]\d*$/, "id must be a positive integer")
	.transform(Number);

const bodySchema = z.strictObject({
	kind: z.enum(["summary", "transcript"]),
});

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
	const kind: AudioKind = parsed.data.kind;

	if ((await getBookmarkUrl(db, user.id, bookmarkId)) === null) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	const voice = configuredVoice();
	const article = await getArticle(db, user.id, bookmarkId, voice);
	if (!article) {
		return Response.json({ error: "no_article" }, { status: 404 });
	}

	// The text must exist before it can be spoken. `ready` is the only status
	// that guarantees both the transcript and the summary are final.
	if (article.status !== "ready") {
		return Response.json(
			{ error: "not_ready", status: article.status },
			{ status: 409 },
		);
	}

	const text = kind === "summary" ? article.summary : article.transcript;
	if (!text || text.trim() === "") {
		return Response.json({ error: "no_text" }, { status: 409 });
	}

	// Cache hit: skip synthesis entirely and just re-sign the stored object.
	const cached = await getAudio(db, article.id, kind, voice);
	if (cached) {
		try {
			const signed = await createSignedUrl(cached.storagePath);
			return Response.json({
				kind,
				voice,
				url: signed.url,
				expiresAt: signed.expiresAt,
				byteSize: cached.byteSize,
				segmentCount: cached.segmentCount,
				cached: true,
			});
		} catch (error) {
			// A stored object that can no longer be signed (bucket wiped,
			// object deleted) falls through to re-synthesis below.
			if (!(error instanceof PipelineError)) {
				throw error;
			}
		}
	}

	try {
		const synthesized = await synthesizeSpeech(text, { voice });
		const path = audioObjectPath(user.id, article.id, kind, voice);
		await uploadAudio(path, synthesized.audio);

		const saved = await saveAudio(db, user.id, article.id, {
			kind,
			voice: synthesized.voice,
			storagePath: path,
			byteSize: synthesized.audio.byteLength,
			charCount: synthesized.charCount,
			segmentCount: synthesized.segmentCount,
		});

		const signed = await createSignedUrl(path);
		return Response.json({
			kind,
			voice: synthesized.voice,
			url: signed.url,
			expiresAt: signed.expiresAt,
			byteSize: saved.byteSize,
			segmentCount: saved.segmentCount,
			cached: false,
		});
	} catch (error) {
		if (error instanceof PipelineError) {
			return Response.json(
				{ error: "synthesis_failed", detail: error.toDisplayString() },
				// Retryable causes (rate limit, upstream 5xx) map to 503 so the
				// UI can say "try again" rather than "this is broken".
				{ status: error.retryable ? 503 : 502 },
			);
		}
		throw error;
	}
}
