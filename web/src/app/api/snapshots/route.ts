// /api/snapshots — SPEC §17.8 (m25).
//
// POST — token auth (the extension's Snapshot button). Body = the manifest:
// the adapter's markdown, the page metadata, and the asset list WITHOUT
// bytes. In one transaction the page's bookmark is upserted as a LIVE
// CAPTURE (Hard rule #1: insert, or bump + unarchive + favicon fill-when-null
// and nothing else) and the snapshot row is inserted as `uploading` with
// server-assigned asset paths. Then one signed upload URL is minted per
// asset; the extension PUTs the bytes straight to Storage (Vercel rejects
// request bodies over 4.5 MB, which tall screenshots and HTML exceed) and
// calls `POST /api/snapshots/:id/complete`.
//
//   201 { snapshot: SnapshotSummary, uploads: [{ kind, idx, path, uploadUrl }] }
//   503 { error: "storage", message } — Storage unconfigured or signing failed
//
// The bucket is ensured BEFORE the transaction, so an unconfigured Storage
// writes nothing. A signing failure after the commit deletes the fresh
// snapshot row again (a row with no way to upload its assets would only ever
// show as incomplete); the bookmark bump stands — the capture happened.
//
// GET — session or token (`authenticateRequest`): summaries, `created_at
// desc, id desc`, keyset `cursor`, `limit` 1..100 (default 20), optional
// `bookmarkId`.
//
// The path stays inside the proxy matcher: it shares its prefix with the
// session-authed GET/DELETE `/api/snapshots/:id`, and matched `/api/*` is
// never redirected.
import { z } from "zod";
import { db } from "../../../db";
import { authenticateApiToken } from "../../../lib/apiTokenAuth";
import { getAuthedUser } from "../../../lib/auth";
import { PipelineError } from "../../../lib/pipelineError";
import { authenticateRequest } from "../../../lib/requestAuth";
import {
	createSnapshot,
	createSnapshotBodySchema,
	deleteSnapshot,
	InvalidSnapshotCursorError,
	listSnapshots,
	SNAPSHOT_PAGE_DEFAULT,
	SNAPSHOT_PAGE_MAX,
	type SnapshotAsset,
} from "../../../lib/snapshots";
import {
	createSignedUploadUrl,
	ensureSnapshotBucket,
	snapshotBucket,
} from "../../../lib/storage";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

/** Signing requests in flight at once (≤ 64 assets per snapshot). */
const SIGN_CONCURRENCY = 8;

async function signUploads(
	assets: SnapshotAsset[],
): Promise<
	Array<{ kind: string; idx: number; path: string; uploadUrl: string }>
> {
	const bucket = snapshotBucket();
	const uploads = new Array<{
		kind: string;
		idx: number;
		path: string;
		uploadUrl: string;
	}>(assets.length);
	let next = 0;
	async function worker() {
		while (next < assets.length) {
			const i = next++;
			const asset = assets[i];
			uploads[i] = {
				kind: asset.kind,
				idx: asset.idx,
				path: asset.path,
				uploadUrl: await createSignedUploadUrl(bucket, asset.path),
			};
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(SIGN_CONCURRENCY, assets.length) }, worker),
	);
	return uploads;
}

function storageError(error: PipelineError) {
	return Response.json(
		{ error: "storage", message: error.message },
		{ status: 503 },
	);
}

export async function POST(request: Request) {
	const auth = await authenticateApiToken(request);
	if (!auth) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid_json" }, { status: 400 });
	}

	const parsed = createSnapshotBodySchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	try {
		await ensureSnapshotBucket();
	} catch (error) {
		if (error instanceof PipelineError) {
			return storageError(error);
		}
		throw error;
	}

	const { snapshot, assets } = await createSnapshot(
		db,
		auth.userId,
		parsed.data,
	);

	try {
		const uploads = await signUploads(assets);
		return Response.json({ snapshot, uploads }, { status: 201 });
	} catch (error) {
		// Nothing has been uploaded yet (the extension never saw a URL), so the
		// row has no objects to clean up.
		await deleteSnapshot(db, auth.userId, snapshot.id).catch(() => {});
		if (error instanceof PipelineError) {
			return storageError(error);
		}
		throw error;
	}
}

const positiveInt = z
	.string()
	.regex(/^[1-9]\d*$/)
	.transform(Number)
	.pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

const querySchema = z.object({
	bookmarkId: positiveInt.optional(),
	limit: positiveInt.pipe(z.number().max(SNAPSHOT_PAGE_MAX)).optional(),
	cursor: z.string().min(1).optional(),
});

export async function GET(request: Request) {
	const userId = await authenticateRequest(request, {
		resolveToken: authenticateApiToken,
		resolveSession: getAuthedUser,
	});
	if (!userId) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const parsed = querySchema.safeParse({
		bookmarkId: url.searchParams.get("bookmarkId") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
	});
	if (!parsed.success) {
		return Response.json(
			{ error: "invalid_query", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	try {
		const result = await listSnapshots(db, userId, {
			bookmarkId: parsed.data.bookmarkId,
			limit: parsed.data.limit ?? SNAPSHOT_PAGE_DEFAULT,
			cursor: parsed.data.cursor,
		});
		return Response.json(result);
	} catch (error) {
		if (error instanceof InvalidSnapshotCursorError) {
			return Response.json({ error: "invalid_cursor" }, { status: 400 });
		}
		throw error;
	}
}
