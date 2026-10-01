// Supabase Storage access — article audio (SPEC §10), page screenshots
// (m23, SPEC §15) and page snapshots (m25, SPEC §17.3).
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
//   - snapshots      — PRIVATE (SPEC §17.3): a snapshot can hold logged-in
//     content. The extension uploads straight to Storage through signed
//     UPLOAD URLs minted here (Vercel rejects request bodies over 4.5 MB), and
//     reads go through signed URLs like audio.
import "server-only";

import { randomBytes } from "node:crypto";
import { PipelineError } from "./pipelineError";

const DEFAULT_AUDIO_BUCKET = "article-audio";
const DEFAULT_SCREENSHOT_BUCKET = "bookmark-screenshots";
const DEFAULT_SNAPSHOT_BUCKET = "page-snapshots";

/** Hard cap on a stored screenshot, mirrored by the upload route's 413. */
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** Per-object cap in the snapshot bucket (SPEC §17.3): 50 MiB. */
export const SNAPSHOT_MAX_OBJECT_BYTES = 50 * 1024 * 1024;

/** The snapshot bucket's mime allow-list (SPEC §17.3). */
export const SNAPSHOT_MIME_TYPES = [
	"image/webp",
	"image/jpeg",
	"text/html",
	"application/json",
] as const;

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

/** Which bucket snapshot assets land in (m25, SPEC §17.3). PRIVATE. */
export function snapshotBucket(): string {
	return process.env.SNAPSHOT_BUCKET?.trim() || DEFAULT_SNAPSHOT_BUCKET;
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

export type SignedUrl = { url: string; expiresAt: Date };

/** Resolves a project-relative path Storage hands back (`/object/...`). */
function absolute(cfg: StorageConfig, relative: string): string {
	return `${cfg.baseUrl}${relative.startsWith("/") ? "" : "/"}${relative}`;
}

/**
 * Mints a time-limited read URL for an object in a PRIVATE bucket — audio
 * playback (SPEC §10) and snapshot assets (SPEC §17.3). Generalized in m25 to
 * take the bucket.
 *
 * Supabase returns a project-relative path (`/object/sign/...`); it is
 * resolved against the storage base URL here so callers get something an
 * `<audio src>` / `<img src>` can use directly.
 */
export async function createSignedUrl(
	bucket: string,
	path: string,
): Promise<SignedUrl> {
	const cfg = config();

	const response = await fetch(
		`${cfg.baseUrl}/object/sign/${bucket}/${encodeURI(path)}`,
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
			`Could not sign the storage URL (${response.status}).`,
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
		url: absolute(cfg, payload.signedURL),
		expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000),
	};
}

/**
 * Signs many objects in one bucket with ONE request (`POST /object/sign/
 * <bucket>` with `paths`), for the snapshot detail response (SPEC §17.8).
 *
 * Per-path failures come back inside the 200 (an object that is not there —
 * an `uploading` snapshot's missing asset — answers with an `error` and no
 * `signedURL`); those map to null rather than failing the whole batch. A
 * failure of the request itself throws `PipelineError`.
 */
export async function createSignedUrls(
	bucket: string,
	paths: string[],
): Promise<Map<string, SignedUrl | null>> {
	const result = new Map<string, SignedUrl | null>();
	if (paths.length === 0) {
		return result;
	}
	const cfg = config();

	const response = await fetch(`${cfg.baseUrl}/object/sign/${bucket}`, {
		method: "POST",
		headers: {
			...authHeaders(cfg.serviceKey),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS, paths }),
	});

	if (!response.ok) {
		throw new PipelineError(
			"storage",
			`sign_http_${response.status}`,
			`Could not sign the storage URLs (${response.status}).`,
			{ retryable: response.status >= 500 },
		);
	}

	const payload = (await response.json().catch(() => null)) as Array<{
		path?: string | null;
		signedURL?: string | null;
	}> | null;
	const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
	for (const path of paths) {
		result.set(path, null);
	}
	for (const entry of Array.isArray(payload) ? payload : []) {
		if (entry?.path && entry.signedURL && result.has(entry.path)) {
			result.set(entry.path, {
				url: absolute(cfg, entry.signedURL),
				expiresAt,
			});
		}
	}
	return result;
}

/**
 * Creates the PRIVATE snapshot bucket on first use (SPEC §17.3). Called before
 * any snapshot row is written, so an unconfigured or unreachable Storage fails
 * the request before it has touched the database.
 */
export async function ensureSnapshotBucket(): Promise<void> {
	const cfg = config();
	await ensureBucket(cfg, snapshotBucket(), {
		public: false,
		allowed_mime_types: [...SNAPSHOT_MIME_TYPES],
		file_size_limit: SNAPSHOT_MAX_OBJECT_BYTES,
	});
}

/**
 * Mints a signed UPLOAD URL for one object (SPEC §17.3): the absolute URL the
 * extension `PUT`s the bytes to, with the object's mime type as
 * `Content-Type`. Storage enforces the bucket's mime allow-list and size cap
 * on that PUT. The service-role key stays on the server; the URL carries a
 * short-lived token scoped to this one path (Supabase: 2 h).
 *
 * No `x-upsert`: each path belongs to one snapshot row and is written once.
 */
export async function createSignedUploadUrl(
	bucket: string,
	path: string,
): Promise<string> {
	const cfg = config();

	const response = await fetch(
		`${cfg.baseUrl}/object/upload/sign/${bucket}/${encodeURI(path)}`,
		{
			method: "POST",
			headers: {
				...authHeaders(cfg.serviceKey),
				"Content-Type": "application/json",
			},
			body: "{}",
		},
	);

	if (!response.ok) {
		throw new PipelineError(
			"storage",
			`sign_upload_http_${response.status}`,
			`Could not sign an upload URL (${response.status}): ${(
				await response.text().catch(() => "")
			).slice(0, 200)}`,
			{ retryable: response.status >= 500 },
		);
	}

	const payload = (await response.json().catch(() => null)) as {
		url?: string;
	} | null;
	if (!payload?.url) {
		throw new PipelineError(
			"storage",
			"sign_upload_missing_url",
			"Supabase did not return a signed upload URL.",
			{ retryable: true },
		);
	}

	return absolute(cfg, payload.url);
}

/** Page size for `listObjectPaths`; Storage's own default. */
const LIST_PAGE = 100;

/**
 * Full paths of the objects directly under `prefix` (a "folder", e.g.
 * `<userId>/<snapshotId>`), for the snapshot complete check (SPEC §17.8).
 * Folder placeholders (entries without an `id`) are skipped.
 */
export async function listObjectPaths(
	bucket: string,
	prefix: string,
): Promise<string[]> {
	const cfg = config();
	const folder = prefix.replace(/\/+$/, "");
	const paths: string[] = [];

	for (let offset = 0; ; offset += LIST_PAGE) {
		const response = await fetch(`${cfg.baseUrl}/object/list/${bucket}`, {
			method: "POST",
			headers: {
				...authHeaders(cfg.serviceKey),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				prefix: folder,
				limit: LIST_PAGE,
				offset,
				sortBy: { column: "name", order: "asc" },
			}),
		});

		if (!response.ok) {
			throw new PipelineError(
				"storage",
				`list_http_${response.status}`,
				`Could not list storage objects (${response.status}).`,
				{ retryable: response.status >= 500 },
			);
		}

		const page = (await response.json().catch(() => null)) as Array<{
			name?: string;
			id?: string | null;
		}> | null;
		const entries = Array.isArray(page) ? page : [];
		for (const entry of entries) {
			if (entry?.name && entry.id) {
				paths.push(`${folder}/${entry.name}`);
			}
		}
		if (entries.length < LIST_PAGE) {
			return paths;
		}
	}
}

/**
 * Deletes objects from a bucket in one request (`DELETE /object/<bucket>`
 * with `prefixes`). Throws `PipelineError` on failure; the snapshot delete
 * route treats it as best-effort (SPEC §17.3).
 */
export async function removeObjects(
	bucket: string,
	paths: string[],
): Promise<void> {
	if (paths.length === 0) {
		return;
	}
	const cfg = config();

	const response = await fetch(`${cfg.baseUrl}/object/${bucket}`, {
		method: "DELETE",
		headers: {
			...authHeaders(cfg.serviceKey),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ prefixes: paths }),
	});

	if (!response.ok) {
		throw new PipelineError(
			"storage",
			`remove_http_${response.status}`,
			`Could not delete storage objects (${response.status}).`,
			{ retryable: response.status >= 500 },
		);
	}
}
