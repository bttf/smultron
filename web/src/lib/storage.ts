// Supabase Storage access for article audio — SPEC §10.
//
// Deliberately the Storage REST API over plain `fetch`, not supabase-js.
// Hard rule #5 ("supabase-js is for auth only") exists to keep application
// DATA in Postgres behind Drizzle; audio blobs are neither, but rather than
// carve an exception into the rule we simply don't introduce a second
// supabase-js client at all. Everything here is service-role and
// server-only: the bucket is PRIVATE and playback goes through short-lived
// signed URLs, so the key never reaches a browser.
import "server-only";

import { PipelineError } from "./pipelineError";

const DEFAULT_BUCKET = "article-audio";

/** How long a playback URL stays valid. Long enough to listen to a full
 * article without the link dying mid-play; short enough to be worth signing. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60 * 6;

type StorageConfig = { baseUrl: string; serviceKey: string; bucket: string };

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
		bucket: process.env.ARTICLE_AUDIO_BUCKET?.trim() || DEFAULT_BUCKET,
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
	return config().bucket;
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
async function bucketExists(cfg: StorageConfig): Promise<boolean> {
	const response = await fetch(
		`${cfg.baseUrl}/bucket/${encodeURIComponent(cfg.bucket)}`,
		{ method: "GET", headers: authHeaders(cfg.serviceKey) },
	).catch(() => null);
	return response?.ok === true;
}

/**
 * Creates the audio bucket if it doesn't exist yet.
 *
 * Idempotent, and cheap after the first call — but it IS a network round trip
 * on the upload path, so the result is memoized per process (keyed by bucket
 * name, so changing `ARTICLE_AUDIO_BUCKET` re-checks). Doing this in code
 * rather than as a documented manual step means a fresh Supabase project works
 * on first use instead of failing with a confusing 404.
 *
 * "Already exists" is the steady state, not an error — and since Supabase
 * reports it inconsistently, anything that isn't a recognizable duplicate is
 * settled by asking whether the bucket is there before failing the job.
 */
let readyBucket: string | null = null;

async function ensureBucket(cfg: StorageConfig): Promise<void> {
	if (readyBucket === cfg.bucket) {
		return;
	}

	const response = await fetch(`${cfg.baseUrl}/bucket`, {
		method: "POST",
		headers: {
			...authHeaders(cfg.serviceKey),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			id: cfg.bucket,
			name: cfg.bucket,
			// PRIVATE: playback is via signed URLs only (see createSignedUrl).
			public: false,
			allowed_mime_types: ["audio/mpeg"],
		}),
	});

	if (response.ok || response.status === 409) {
		readyBucket = cfg.bucket;
		return;
	}

	const body = await response.text().catch(() => "");
	if (saysAlreadyExists(body) || (await bucketExists(cfg))) {
		readyBucket = cfg.bucket;
		return;
	}

	throw new PipelineError(
		"storage",
		`bucket_http_${response.status}`,
		`Could not create the "${cfg.bucket}" storage bucket (${response.status}): ${body.slice(0, 200)}`,
		{ retryable: response.status >= 500 },
	);
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
	await ensureBucket(cfg);

	const response = await fetch(
		`${cfg.baseUrl}/object/${cfg.bucket}/${encodeURI(path)}`,
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
		`${cfg.baseUrl}/object/sign/${cfg.bucket}/${encodeURI(path)}`,
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
