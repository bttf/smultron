// Supabase Storage access — article audio (SPEC §10) and page screenshots
// (m23, SPEC §15).
//
// Deliberately the Storage REST API over plain `fetch`, not supabase-js.
// Hard rule #5 ("supabase-js is for auth only") exists to keep application
// DATA in Postgres behind Drizzle; blobs are neither, but rather than carve an
// exception into the rule we simply don't introduce a second supabase-js
// client at all. Everything here is service-role and server-only.
//
// The two buckets have deliberately different privacy models:
//   - article audio  — PRIVATE; playback goes through short-lived signed URLs.
//   - screenshots    — PUBLIC; the privacy model is URL secrecy (SPEC §15.1).
//     The object path carries 128 random bits and surfaces only in
//     authenticated API responses, which keeps `<img src>` cacheable and free
//     of expiry handling. Do NOT add signed URLs or Storage policies to it.
import "server-only";

import { randomBytes } from "node:crypto";
import { PipelineError } from "./pipelineError";

const DEFAULT_AUDIO_BUCKET = "article-audio";
const DEFAULT_SCREENSHOT_BUCKET = "bookmark-screenshots";

/** Hard cap on a stored screenshot, mirrored by the upload route's 413. */
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** How long a playback URL stays valid. Long enough to listen to a full
 * article without the link dying mid-play; short enough to be worth signing. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60 * 6;

type StorageConfig = { baseUrl: string; serviceKey: string };

function config(): StorageConfig {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !serviceKey) {
		throw new PipelineError(
			"storage",
			"not_configured",
			"NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.",
		);
	}
	return {
		baseUrl: `${url.replace(/\/+$/, "")}/storage/v1`,
		serviceKey,
	};
}

function authHeaders(serviceKey: string): Record<string, string> {
	// Storage wants BOTH: apikey identifies the project, Authorization carries
	// the role that bypasses bucket RLS.
	return {
		apikey: serviceKey,
		Authorization: `Bearer ${serviceKey}`,
	};
}

/** Which bucket audio lands in — surfaced for docs/diagnostics. */
export function audioBucket(): string {
	return process.env.ARTICLE_AUDIO_BUCKET?.trim() || DEFAULT_AUDIO_BUCKET;
}

/** Which bucket screenshots land in (m23, SPEC §15.1). PUBLIC by design. */
export function screenshotBucket(): string {
	return (
		process.env.BOOKMARK_SCREENSHOT_BUCKET?.trim() || DEFAULT_SCREENSHOT_BUCKET
	);
}

/**
 * Prefix a stored screenshot's public URL is built from — the whole URL is
 * `screenshotPublicBase() + screenshot_path` (SPEC §15.1). Concatenation is
 * safe without encoding because the path alphabet is uuid / digits / hex /
 * `/` / `.`.
 *
 * Returns null when Storage is unconfigured, which is what makes every
 * `screenshotUrl` null on a placeholder build. Deliberately does NOT go
 * through `config()`: this is called on every bookmark query and must never
 * throw.
 */
export function screenshotPublicBase(): string | null {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
	if (!url) {
		return null;
	}
	return `${url.replace(/\/+$/, "")}/storage/v1/object/public/${screenshotBucket()}/`;
}

/**
 * A fresh object path for one bookmark's screenshot (SPEC §15.1):
 * `<userId>/<bookmarkId>/<32 lowercase hex>.jpg`. The 16 random bytes are the
 * privacy boundary — the bucket is public, so the URL's unguessability is what
 * keeps the image unlisted. User- and bookmark-scoped so the store stays
 * browsable by a human debugging it.
 */
export function screenshotObjectPath(
	userId: string,
	bookmarkId: number,
): string {
	return `${userId}/${bookmarkId}/${randomBytes(16).toString("hex")}.jpg`;
}

/**
 * Object path for one article's audio of a given kind and voice.
 * User-scoped so a listing is never cross-tenant, and voice-scoped so
 * changing `TTS_VOICE` writes a new object rather than shadowing the old one.
 */
export function audioObjectPath(
	userId: string,
	articleId: number,
	kind: string,
	voice: string,
): string {
	return `${userId}/${articleId}/${kind}-${voice}.mp3`;
}

/**
 * Does a failed create-bucket body say the bucket is already there?
 *
 * Supabase Storage does NOT reliably put that on the HTTP status: creating a
 * duplicate bucket comes back as `400` with the real code buried in the JSON
 * (`{"statusCode":"409","error":"Duplicate","code":"BucketAlreadyExists"}`).
 * So the body is the source of truth, and every field it might carry the
 * signal in gets checked.
 */
function saysAlreadyExists(body: string): boolean {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return false;
	}
	if (!payload || typeof payload !== "object") {
		return false;
	}
	const { statusCode, error, code } = payload as Record<string, unknown>;
	return (
		String(statusCode) === "409" ||
		code === "BucketAlreadyExists" ||
		error === "Duplicate"
	);
}

/** Does the bucket exist right now? Used only to settle an ambiguous create. */
async function bucketExists(
	cfg: StorageConfig,
	bucket: string,
): Promise<boolean> {
	const response = await fetch(
		`${cfg.baseUrl}/bucket/${encodeURIComponent(bucket)}`,
		{ method: "GET", headers: authHeaders(cfg.serviceKey) },
	).catch(() => null);
	return response?.ok === true;
}

/** Create-time options for a bucket, as Supabase's bucket API spells them. */
type BucketOptions = {
	public: boolean;
	allowed_mime_types: string[];
	file_size_limit?: number;
};

/**
 * Readiness memo, keyed by bucket NAME (m23): the audio bucket and the
 * screenshot bucket coexist in one process, and changing either bucket's env
 * var re-checks the new name.
 */
const readyBuckets = new Set<string>();

/**
 * Creates `bucket` with `options` if it doesn't exist yet.
 *
 * Idempotent, and cheap after the first call — but it IS a network round trip
 * on the upload path, so the result is memoized per process. Doing this in code
 * rather than as a documented manual step means a fresh Supabase project works
 * on first use instead of failing with a confusing 404.
 *
 * "Already exists" is the steady state, not an error — and since Supabase
 * reports it inconsistently, anything that isn't a recognizable duplicate is
 * settled by asking whether the bucket is there before failing the job. An
 * existing bucket keeps whatever options it was created with; `options` only
 * ever describes a bucket this call creates.
 */
async function ensureBucket(
	cfg: StorageConfig,
	bucket: string,
	options: BucketOptions,
): Promise<void> {
	if (readyBuckets.has(bucket)) {
		return;
	}

	const response = await fetch(`${cfg.baseUrl}/bucket`, {
		method: "POST",
		headers: {
			...authHeaders(cfg.serviceKey),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ id: bucket, name: bucket, ...options }),
	});

	if (response.ok || response.status === 409) {
		readyBuckets.add(bucket);
		return;
	}

	const body = await response.text().catch(() => "");
	if (saysAlreadyExists(body) || (await bucketExists(cfg, bucket))) {
		readyBuckets.add(bucket);
		return;
	}

	throw new PipelineError(
		"storage",
		`bucket_http_${response.status}`,
		`Could not create the "${bucket}" storage bucket (${response.status}): ${body.slice(0, 200)}`,
		{ retryable: response.status >= 500 },
	);
}

/**
 * Uploads JPEG bytes to `path` within the PUBLIC screenshot bucket (m23,
 * SPEC §15.1), creating the bucket on first use.
 *
 * No `x-upsert`: the path is freshly random on every capture and the row's
 * `screenshot_path` is written keep-first, so an object is never rewritten —
 * which is what makes `cache-control: max-age=31536000` correct.
 */
export async function uploadScreenshot(
	path: string,
	image: Uint8Array,
): Promise<void> {
	const cfg = config();
	const bucket = screenshotBucket();
	await ensureBucket(cfg, bucket, {
		// PUBLIC by design — the privacy model is URL secrecy (SPEC §15.1).
		public: true,
		allowed_mime_types: ["image/jpeg"],
		file_size_limit: SCREENSHOT_MAX_BYTES,
	});

	const response = await fetch(
		`${cfg.baseUrl}/object/${bucket}/${encodeURI(path)}`,
		{
			method: "POST",
			headers: {
				...authHeaders(cfg.serviceKey),
				"Content-Type": "image/jpeg",
				"cache-control": "max-age=31536000",
			},
			// `image` is a Uint8Array view; hand fetch its exact bytes.
			body: image.slice().buffer as ArrayBuffer,
		},
	);

	if (!response.ok) {
		throw new PipelineError(
			"storage",
			`upload_http_${response.status}`,
			`Uploading the screenshot failed (${response.status}): ${(
				await response.text().catch(() => "")
			).slice(0, 200)}`,
			{ retryable: response.status >= 500 },
		);
	}
}

/**
 * Removes a screenshot object, best-effort: the only caller is the race where
 * a concurrent upload already claimed the row, so the object is unreferenced
 * and a failed delete leaks a few hundred KB rather than breaking a request.
 * Never throws.
 */
export async function deleteScreenshot(path: string): Promise<void> {
	try {
		const cfg = config();
		await fetch(
			`${cfg.baseUrl}/object/${screenshotBucket()}/${encodeURI(path)}`,
			{ method: "DELETE", headers: authHeaders(cfg.serviceKey) },
		);
	} catch {
		// Unconfigured Storage, network trouble — nothing to do about it here.
	}
}

/**
 * Uploads mp3 bytes to `path` within the audio bucket, overwriting any
 * existing object (re-synthesis should replace, not accumulate).
 */
export async function uploadAudio(
	path: string,
	audio: Uint8Array,
): Promise<void> {
	const cfg = config();
	const bucket = audioBucket();
	await ensureBucket(cfg, bucket, {
		// PRIVATE: playback is via signed URLs only (see createSignedUrl).
		public: false,
		allowed_mime_types: ["audio/mpeg"],
	});

	const response = await fetch(
		`${cfg.baseUrl}/object/${bucket}/${encodeURI(path)}`,
		{
			method: "POST",
			headers: {
				...authHeaders(cfg.serviceKey),
				"Content-Type": "audio/mpeg",
				"cache-control": "max-age=31536000",
				"x-upsert": "true",
			},
			// `audio` is a Uint8Array view; hand fetch its exact bytes.
			body: audio.slice().buffer as ArrayBuffer,
		},
	);

	if (!response.ok) {
		throw new PipelineError(
			"storage",
			`upload_http_${response.status}`,
			`Uploading the audio failed (${response.status}): ${(
				await response.text().catch(() => "")
			).slice(0, 200)}`,
			{ retryable: response.status >= 500 },
		);
	}
}

export type SignedAudioUrl = { url: string; expiresAt: Date };

/**
 * Mints a time-limited playback URL for a stored object.
 *
 * Supabase returns a project-relative path (`/object/sign/...`); it is
 * resolved against the storage base URL here so callers get something an
 * `<audio src>` can use directly.
 */
export async function createSignedUrl(path: string): Promise<SignedAudioUrl> {
	const cfg = config();

	const response = await fetch(
		`${cfg.baseUrl}/object/sign/${audioBucket()}/${encodeURI(path)}`,
		{
			method: "POST",
			headers: {
				...authHeaders(cfg.serviceKey),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
		},
	);

	if (!response.ok) {
		throw new PipelineError(
			"storage",
			`sign_http_${response.status}`,
			`Could not sign the audio URL (${response.status}).`,
			{ retryable: response.status >= 500 },
		);
	}

	const payload = (await response.json()) as { signedURL?: string };
	if (!payload.signedURL) {
		throw new PipelineError(
			"storage",
			"sign_missing_url",
			"Supabase did not return a signed URL.",
			{ retryable: true },
		);
	}

	return {
		url: `${cfg.baseUrl}${payload.signedURL.startsWith("/") ? "" : "/"}${payload.signedURL}`,
		expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000),
	};
}
