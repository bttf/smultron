// POST /api/bookmarks/by-url/screenshot?url=<raw> — SPEC §15.2 (m23).
//
// The extension uploads the JPEG it captured of the page it just bookmarked
// (or of a bookmarked page it happens to be visiting again). Token-authed like
// the rest of the by-url family — there is no session caller — and addressed
// by RAW URL, normalized here (Hard rule #3) to resolve the row by
// (user_id, url_normalized).
//
// Body = the raw JPEG bytes. Multipart would need a boundary parser for one
// field and base64 JSON would inflate the payload by a third, so neither
// earns its keep. Every rejection below is a deterministic 4xx: the extension's
// poison rule drops a payload that will never be accepted instead of retrying
// it forever, while 502/503 (Storage trouble) leave it queued.
//
//   200 { bookmark, stored: true }   — the row now points at this upload
//   200 { bookmark, stored: false }  — the row already had a screenshot
//                                      (nothing uploaded), or a concurrent
//                                      upload won the race (object deleted)
//
// `bookmark` is the bare row (no nested highlights), exactly like
// GET /api/bookmarks/by-url, carrying the derived `screenshotUrl`.
//
// CRITICAL (Hard rule #1): the write path touches `screenshot_path` and
// nothing else — a screenshot is enrichment, never a live capture.
import { z } from "zod";
import { db } from "../../../../../db";
import { authenticateApiToken } from "../../../../../lib/apiTokenAuth";
import {
	getBookmarkByUrl,
	getBookmarkForScreenshot,
	setScreenshotIfMissing,
} from "../../../../../lib/bookmarks";
import { PipelineError } from "../../../../../lib/pipelineError";
import {
	deleteScreenshot,
	SCREENSHOT_MAX_BYTES,
	screenshotObjectPath,
	uploadScreenshot,
} from "../../../../../lib/storage";

// Node runtime: the postgres driver (and node:crypto, for the random object
// path) need it.
export const runtime = "nodejs";

const urlSchema = z.string().min(1);

/** JPEG start-of-image marker — the whole server-side allow-list (SPEC §15.2). */
const SOI = [0xff, 0xd8, 0xff];

function isJpeg(bytes: Uint8Array): boolean {
	return (
		bytes.length >= SOI.length && SOI.every((byte, i) => bytes[i] === byte)
	);
}

/** `image/jpeg` exactly, ignoring parameters (`; charset=…`) and case. */
function isJpegContentType(header: string | null): boolean {
	return (header ?? "").split(";")[0].trim().toLowerCase() === "image/jpeg";
}

/**
 * `Content-Length`, when the client sent a usable one. A missing or malformed
 * header is not an error — the ACTUAL body length is re-checked below, which
 * is the check that matters; the header is only there to reject an oversized
 * upload before reading it.
 */
function declaredLength(header: string | null): number | null {
	if (header === null) {
		return null;
	}
	const value = Number(header);
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function POST(request: Request) {
	const auth = await authenticateApiToken(request);
	if (!auth) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const raw = new URL(request.url).searchParams.get("url");
	const parsed = urlSchema.safeParse(raw ?? undefined);
	if (!parsed.success) {
		return Response.json({ error: "invalid_url" }, { status: 400 });
	}

	// Addressing before the body (SPEC §15.2 order): an unknown URL is settled
	// without reading a payload nothing will ever use. Another user's row is
	// invisible to this lookup, so it is a 404 too — never a 403.
	const target = await getBookmarkForScreenshot(db, auth.userId, parsed.data);
	if (!target) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	if (!isJpegContentType(request.headers.get("content-type"))) {
		return Response.json({ error: "unsupported_media_type" }, { status: 415 });
	}

	const declared = declaredLength(request.headers.get("content-length"));
	if (declared !== null && declared > SCREENSHOT_MAX_BYTES) {
		return Response.json({ error: "too_large" }, { status: 413 });
	}

	const body = await request.arrayBuffer();
	if (body.byteLength > SCREENSHOT_MAX_BYTES) {
		return Response.json({ error: "too_large" }, { status: 413 });
	}

	const image = new Uint8Array(body);
	if (!isJpeg(image)) {
		return Response.json({ error: "invalid_image" }, { status: 400 });
	}

	// Keep-first, BEFORE the upload: a row that already has a screenshot costs
	// zero Storage calls. There is no overwrite path in m23 — a recapture would
	// be a new endpoint, not a flag on this one.
	if (target.hasScreenshot) {
		return Response.json({ bookmark: target.bookmark, stored: false });
	}

	const path = screenshotObjectPath(auth.userId, target.bookmark.id);

	try {
		await uploadScreenshot(path, image);
	} catch (error) {
		if (error instanceof PipelineError) {
			// Retryable (Storage 5xx, network) → 503; anything else → 502. Both
			// are 5xx, so the extension keeps the entry and retries.
			return Response.json(
				{ error: "storage", message: error.message },
				{ status: error.retryable ? 503 : 502 },
			);
		}
		throw error;
	}

	const stored = await setScreenshotIfMissing(
		db,
		auth.userId,
		target.bookmark.id,
		path,
	);

	if (!stored) {
		// A concurrent upload claimed the row between the check above and this
		// UPDATE. The object just written is unreferenced, so drop it —
		// best-effort: a failed delete leaks a couple of hundred KB, nothing
		// worse.
		await deleteScreenshot(path);
	}

	// Re-read so the response carries whichever screenshot the row actually
	// ended up with — this upload's, or the winner's. `screenshotUrl` is always
	// derived in the shared column set; no route maps it by hand.
	const bookmark =
		(await getBookmarkByUrl(db, auth.userId, parsed.data)) ?? target.bookmark;

	return Response.json({ bookmark, stored });
}
