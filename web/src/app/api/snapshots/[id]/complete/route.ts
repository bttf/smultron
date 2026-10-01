// POST /api/snapshots/:id/complete — SPEC §17.8 (m25). Token auth.
//
// The extension calls this after PUTting every asset to its signed upload
// URL. The server lists the snapshot's Storage folder; if every asset path
// is present the row becomes `complete`:
//
//   200 { snapshot }                               — complete (idempotent)
//   409 { error: "missing_assets", missing: [...] } — some uploads absent
//   404                                            — unknown / not the caller's
//   503/502 { error: "storage", message }          — the listing failed
//
// A row that is already complete answers 200 without touching Storage.
import { z } from "zod";
import { db } from "../../../../../db";
import { authenticateApiToken } from "../../../../../lib/apiTokenAuth";
import { PipelineError } from "../../../../../lib/pipelineError";
import {
	getSnapshot,
	markSnapshotComplete,
	type SnapshotSummary,
	snapshotFolder,
} from "../../../../../lib/snapshots";
import { listObjectPaths, snapshotBucket } from "../../../../../lib/storage";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

const idSchema = z
	.string()
	.regex(/^[1-9]\d*$/, "id must be a positive integer")
	.transform(Number)
	.pipe(z.number().max(Number.MAX_SAFE_INTEGER));

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authenticateApiToken(request);
	if (!auth) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const idResult = idSchema.safeParse((await params).id);
	if (!idResult.success) {
		return Response.json({ error: "invalid_id" }, { status: 400 });
	}

	const snapshot = await getSnapshot(db, auth.userId, idResult.data);
	if (!snapshot) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}

	const {
		markdown: _markdown,
		metadata: _metadata,
		assets,
		...summary
	} = snapshot;
	if (summary.status === "complete") {
		return Response.json({ snapshot: summary satisfies SnapshotSummary });
	}

	let present: Set<string>;
	try {
		present = new Set(
			await listObjectPaths(
				snapshotBucket(),
				snapshotFolder(auth.userId, snapshot.id),
			),
		);
	} catch (error) {
		if (error instanceof PipelineError) {
			return Response.json(
				{ error: "storage", message: error.message },
				{ status: error.retryable ? 503 : 502 },
			);
		}
		throw error;
	}

	const missing = assets
		.map((asset) => asset.path)
		.filter((path) => !present.has(path));
	if (missing.length > 0) {
		return Response.json({ error: "missing_assets", missing }, { status: 409 });
	}

	const completed = await markSnapshotComplete(db, auth.userId, snapshot.id);
	if (!completed) {
		return Response.json({ error: "not_found" }, { status: 404 });
	}
	return Response.json({ snapshot: completed });
}
