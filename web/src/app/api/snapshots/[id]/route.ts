// /api/snapshots/:id — SPEC §17.8 (m25).
//
// GET — session or token (`authenticateRequest`). The full snapshot: summary
// fields + `markdown`, `metadata`, and `assets`, each with a signed read `url`
// and `expiresAt` (6 h, minted per response, one batch request). An asset
// whose object cannot be signed — an `uploading` snapshot's missing upload,
// or Storage being unreachable — carries `url: null, expiresAt: null`: the
// markdown, the primary export, stays readable either way.
//
// DELETE — SESSION auth only (a site action). Hard delete per SPEC §17.3: the
// Storage objects go first, best-effort, then the row. A Storage failure never
// blocks the row delete. `204`.
//
// Both answer `404` for an unknown or another user's id (user-scoped query,
// never a 403). `id` is a dynamic route param — a Promise in Next 16.
import { z } from "zod";
import { db } from "../../../../db";
import { authenticateApiToken } from "../../../../lib/apiTokenAuth";
import { getAuthedUser } from "../../../../lib/auth";
import { PipelineError } from "../../../../lib/pipelineError";
import { authenticateRequest } from "../../../../lib/requestAuth";
import { deleteSnapshot, getSnapshot } from "../../../../lib/snapshots";
import {
	createSignedUrls,
	removeObjects,
	type SignedUrl,
	snapshotBucket,
} from "../../../../lib/storage";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

const idSchema = z
	.string()
	.regex(/^[1-9]\d*$/, "id must be a positive integer")
	.transform(Number)
	.pipe(z.number().max(Number.MAX_SAFE_INTEGER));

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const userId = await authenticateRequest(request, {
		resolveToken: authenticateApiToken,
		resolveSession: getAuthedUser,
	});
	if (!userId) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const idResult = idSchema.safeParse((await params).id);
	if (!idResult.success) {
		return Response.json({ error: "invalid_id" }, { status: 400 });
	}

	const snapshot = await getSnapshot(db, userId, idResult.data);
	if (!snapshot) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	let signed = new Map<string, SignedUrl | null>();
	try {
		signed = await createSignedUrls(
			snapshotBucket(),
			snapshot.assets.map((asset) => asset.path),
		);
	} catch (error) {
		if (!(error instanceof PipelineError)) {
			throw error;
		}
	}

	return Response.json({
		snapshot: {
			...snapshot,
			assets: snapshot.assets.map((asset) => {
				const entry = signed.get(asset.path) ?? null;
				return {
					...asset,
					url: entry?.url ?? null,
					expiresAt: entry?.expiresAt ?? null,
				};
			}),
		},
	});
}

export async function DELETE(_request: Request, { params }: Params) {
	const user = await getAuthedUser();
	if (!user) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const idResult = idSchema.safeParse((await params).id);
	if (!idResult.success) {
		return Response.json({ error: "invalid_id" }, { status: 400 });
	}

	const snapshot = await getSnapshot(db, user.id, idResult.data);
	if (!snapshot) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	// Best-effort: a failed delete leaks objects under a folder no row points
	// at, which beats a snapshot the user cannot get rid of.
	await removeObjects(
		snapshotBucket(),
		snapshot.assets.map((asset) => asset.path),
	).catch(() => {});

	const deleted = await deleteSnapshot(db, user.id, idResult.data);
	if (!deleted) {
		// Deleted concurrently between the read and here.
		return Response.json({ error: "not_found" }, { status: 404 });
	}
	return new Response(null, { status: 204 });
}
