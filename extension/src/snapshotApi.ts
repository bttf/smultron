/**
 * The snapshot API (m25, SPEC §17.8) as the extension calls it: Chrome-free
 * and fetch-injected like `putPinnedOrder`, so the service worker and the
 * popup share one client and its result mapping is testable.
 *
 * Every call is a direct request with the pairing token — snapshots never go
 * through the outbox (§17.1). Results keep 401 distinguishable from other
 * statuses and from a network failure, the same three-way split the popup and
 * the new tab page use everywhere.
 */

import {
	API_TIMEOUT_MS,
	type CreateSnapshotBody,
	type SnapshotAssetKind,
	UPLOAD_TIMEOUT_MS,
} from "./snapshot";

export interface ApiConfig {
	token: string;
	baseUrl: string;
}

export type ApiResult<T> =
	| { ok: true; value: T }
	| { ok: false; status: number; body?: unknown }
	| { ok: false; status: null; message: string };

/** `SnapshotSummary` (§17.8). */
export interface SnapshotSummary {
	id: number;
	bookmarkId: number;
	url: string;
	title: string;
	adapterId: string;
	adapterVersion: string;
	status: "uploading" | "complete";
	capturedAt: string;
	createdAt: string;
	markdownChars: number;
	screenshotCount: number;
}

/** One signed upload target from `POST /api/snapshots`. */
export interface UploadTarget {
	kind: SnapshotAssetKind;
	idx: number;
	path: string;
	uploadUrl: string;
}

function failure(error: unknown): { ok: false; status: null; message: string } {
	return {
		ok: false,
		status: null,
		message: error instanceof Error ? error.message : String(error),
	};
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant summary reader: one junk row costs that row, never the list. */
export function asSnapshotSummary(raw: unknown): SnapshotSummary | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.id !== "number" || typeof raw.url !== "string")
		return undefined;
	return {
		id: raw.id,
		bookmarkId: typeof raw.bookmarkId === "number" ? raw.bookmarkId : 0,
		url: raw.url,
		title: typeof raw.title === "string" ? raw.title : raw.url,
		adapterId: typeof raw.adapterId === "string" ? raw.adapterId : "",
		adapterVersion:
			typeof raw.adapterVersion === "string" ? raw.adapterVersion : "",
		status: raw.status === "complete" ? "complete" : "uploading",
		capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : "",
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
		markdownChars:
			typeof raw.markdownChars === "number" ? raw.markdownChars : 0,
		screenshotCount:
			typeof raw.screenshotCount === "number" ? raw.screenshotCount : 0,
	};
}

function asUploadTargets(raw: unknown): UploadTarget[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item): UploadTarget[] => {
		if (!isRecord(item)) return [];
		const { kind, idx, path, uploadUrl } = item;
		if (
			(kind !== "screenshot" && kind !== "html" && kind !== "data") ||
			typeof idx !== "number" ||
			typeof uploadUrl !== "string"
		)
			return [];
		return [
			{ kind, idx, path: typeof path === "string" ? path : "", uploadUrl },
		];
	});
}

async function call(
	config: ApiConfig,
	fetchImpl: typeof fetch,
	path: string,
	init: RequestInit,
): Promise<ApiResult<unknown>> {
	try {
		const response = await fetchImpl(`${config.baseUrl}${path}`, {
			...init,
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
			headers: {
				Authorization: `Bearer ${config.token}`,
				...init.headers,
			},
		});
		const body = await readJson(response);
		if (!response.ok) return { ok: false, status: response.status, body };
		return { ok: true, value: body };
	} catch (error) {
		return failure(error);
	}
}

/** `POST /api/snapshots` → `201 { snapshot, uploads }` (§17.8). */
export async function createSnapshot(
	config: ApiConfig,
	fetchImpl: typeof fetch,
	body: CreateSnapshotBody,
): Promise<ApiResult<{ snapshot: SnapshotSummary; uploads: UploadTarget[] }>> {
	const result = await call(config, fetchImpl, "/api/snapshots", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!result.ok) return result;
	const parsed = isRecord(result.value) ? result.value : {};
	const snapshot = asSnapshotSummary(parsed.snapshot);
	if (snapshot === undefined)
		return failure(new Error("the server returned no snapshot"));
	return {
		ok: true,
		value: { snapshot, uploads: asUploadTargets(parsed.uploads) },
	};
}

/**
 * PUT one asset's bytes to its signed Storage URL (§17.3). No pairing token:
 * the URL carries its own; the service-role key never leaves the server.
 */
export async function uploadAsset(
	fetchImpl: typeof fetch,
	uploadUrl: string,
	mime: string,
	bytes: Uint8Array<ArrayBuffer>,
): Promise<ApiResult<void>> {
	try {
		const response = await fetchImpl(uploadUrl, {
			method: "PUT",
			headers: { "Content-Type": mime },
			body: bytes,
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		});
		if (!response.ok) return { ok: false, status: response.status };
		return { ok: true, value: undefined };
	} catch (error) {
		return failure(error);
	}
}

/**
 * `POST /api/snapshots/:id/complete` → `200 { snapshot }`, or
 * `409 { error: "missing_assets", missing }` (kept in `body`).
 */
export async function completeSnapshot(
	config: ApiConfig,
	fetchImpl: typeof fetch,
	id: number,
): Promise<ApiResult<SnapshotSummary | undefined>> {
	const result = await call(
		config,
		fetchImpl,
		`/api/snapshots/${encodeURIComponent(String(id))}/complete`,
		{ method: "POST" },
	);
	if (!result.ok) return result;
	const parsed = isRecord(result.value) ? result.value : {};
	return { ok: true, value: asSnapshotSummary(parsed.snapshot) };
}

/** The `missing` paths of a 409 `missing_assets` body; [] when absent. */
export function missingAssets(body: unknown): string[] {
	if (!isRecord(body) || !Array.isArray(body.missing)) return [];
	return body.missing.filter((m): m is string => typeof m === "string");
}

/** `GET /api/snapshots?limit=` — the newest summaries first (§17.8). */
export async function listRecentSnapshots(
	config: ApiConfig,
	fetchImpl: typeof fetch,
	limit: number,
): Promise<ApiResult<SnapshotSummary[]>> {
	const result = await call(
		config,
		fetchImpl,
		`/api/snapshots?limit=${encodeURIComponent(String(limit))}`,
		{ method: "GET" },
	);
	if (!result.ok) return result;
	const raw = Array.isArray(result.value)
		? result.value
		: isRecord(result.value)
			? result.value.snapshots
			: undefined;
	const list = Array.isArray(raw) ? raw : [];
	return {
		ok: true,
		value: list.flatMap((row) => {
			const summary = asSnapshotSummary(row);
			return summary === undefined ? [] : [summary];
		}),
	};
}

/** `GET /api/snapshots/:id` → the snapshot's markdown (§17.8). */
export async function getSnapshotMarkdown(
	config: ApiConfig,
	fetchImpl: typeof fetch,
	id: number,
): Promise<ApiResult<string>> {
	const result = await call(
		config,
		fetchImpl,
		`/api/snapshots/${encodeURIComponent(String(id))}`,
		{ method: "GET" },
	);
	if (!result.ok) return result;
	const parsed = isRecord(result.value) ? result.value : {};
	const snapshot = isRecord(parsed.snapshot) ? parsed.snapshot : parsed;
	if (typeof snapshot.markdown !== "string")
		return failure(new Error("the server returned no markdown"));
	return { ok: true, value: snapshot.markdown };
}

/** The site's page for one snapshot (§17.9). */
export function snapshotPageUrl(baseUrl: string, id: number): string {
	return `${baseUrl.replace(/\/+$/, "")}/snapshots/${encodeURIComponent(String(id))}`;
}

/** "HTTP 503" / "network error: …" — the popup's failure wording. */
export function describeFailure(result: {
	status: number | null;
	message?: string;
}): string {
	return result.status === null
		? `network error: ${result.message ?? "unreachable"}`
		: `HTTP ${result.status}`;
}

/**
 * Run `task` over `items` with at most `limit` in flight. Stops starting new
 * tasks after the first failure, lets the running ones finish, and returns
 * that first failure (or undefined when every task succeeded).
 */
export async function runPool<T, F>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<F | undefined>,
): Promise<F | undefined> {
	let next = 0;
	let firstFailure: F | undefined;
	async function worker(): Promise<void> {
		while (firstFailure === undefined && next < items.length) {
			const item = items[next] as T;
			next += 1;
			const failed = await task(item);
			if (failed !== undefined && firstFailure === undefined)
				firstFailure = failed;
		}
	}
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		() => worker(),
	);
	await Promise.all(workers);
	return firstFailure;
}
