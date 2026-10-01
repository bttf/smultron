/**
 * Page snapshots (m25, SPEC §17): the shared vocabulary of the capture flow.
 *
 * Chrome-free like everything in `src/`: the storage keys, the progress state
 * the service worker publishes in `chrome.storage.session` and the popup
 * renders, the popup → worker start message, the `disabledAdapters` helpers
 * Options and the injected script share, the wire form of what the injected
 * script returns, and the `POST /api/snapshots` body builder with the
 * server's size limits applied client-side (a limit the server enforces with
 * a 400 would otherwise fail the whole snapshot).
 */

import type { PageMetadata, ScrapeResult } from "./adapters/types";

/** `chrome.storage.session`: the in-flight / last snapshot's progress (§17.7). */
export const SNAPSHOT_STATE_KEY = "snapshotState";
/**
 * `chrome.storage.session`: the last snapshot's markdown, kept until the next
 * snapshot starts so the popup's `Copy markdown` works without a round trip
 * (§17.7). Its own key so the frequent state writes stay small.
 */
export const SNAPSHOT_MARKDOWN_KEY = "snapshotMarkdown";
/** `chrome.storage.sync`: adapter ids switched off in Options (§17.5). */
export const DISABLED_ADAPTERS_KEY = "disabledAdapters";

/** SPEC §17.8 request limits, mirrored so an oversized page never 400s. */
export const SNAPSHOT_URL_LIMIT = 2_048;
export const SNAPSHOT_TITLE_LIMIT = 1_000;
export const SNAPSHOT_MARKDOWN_LIMIT = 1_000_000;
/**
 * The server caps `metadata` at 512 KB serialized. Measured here in UTF-8
 * bytes (never fewer than the string's length) with headroom below 512 000, so
 * the request passes whichever unit the server counts in.
 */
export const SNAPSHOT_METADATA_LIMIT_BYTES = 500_000;
/** At most 64 assets per snapshot (§17.4). */
export const SNAPSHOT_MAX_ASSETS = 64;
/** The bucket's `file_size_limit` (§17.3); the server 400s a larger `byteSize`. */
export const SNAPSHOT_MAX_ASSET_BYTES = 50 * 1024 * 1024;

export const MARKDOWN_TRUNCATION_NOTE =
	"\n\n[Truncated: the snapshot markdown exceeded 1,000,000 characters.]";

/**
 * Upper bounds on each step, so a hung page script, a stalled CDP capture or
 * a stalled request ends the run as a failure instead of leaving it "in
 * flight" (and the popup's button disabled) for the worker's whole life.
 */
export const READ_TIMEOUT_MS = 120_000;
export const API_TIMEOUT_MS = 60_000;
export const UPLOAD_TIMEOUT_MS = 300_000;

/** `work`, or a rejection with "<label> timed out" after `ms`. */
export function withTimeout<T>(
	work: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Progress state (§17.7).

/**
 * The steps the popup shows in plain words: reading the page, capturing the
 * screenshot, uploading, done. `failed` carries `error`.
 */
export type SnapshotStep =
	| "reading"
	| "capturing"
	| "uploading"
	| "done"
	| "failed";

/**
 * `snapshotState` (§17.7): `{ tabId, url, step, error?, snapshotId?,
 * screenshotFailed? }` plus the run id that ties it to the stored markdown and
 * a few display fields.
 */
export interface SnapshotState {
	runId: string;
	tabId: number;
	/** The raw tab URL being snapshotted. */
	url: string;
	step: SnapshotStep;
	startedAtMs: number;
	/** The adapter's title, once the page has been read. */
	title?: string;
	/** `failed` only: what went wrong, in plain words. */
	error?: string;
	/** `failed` only: the server answered 401 — the popup offers Options. */
	unpaired?: boolean;
	snapshotId?: number;
	/** The CDP capture failed; the snapshot continued with zero tiles. */
	screenshotFailed?: boolean;
	screenshotCount?: number;
	markdownChars?: number;
	/** `uploading`: assets PUT so far, of `uploadTotal`. */
	uploaded?: number;
	uploadTotal?: number;
}

const STEPS: readonly SnapshotStep[] = [
	"reading",
	"capturing",
	"uploading",
	"done",
	"failed",
];

/** A snapshot is running (the popup disables its button; the worker refuses a second). */
export function isInFlight(state: SnapshotState | undefined): boolean {
	return (
		state !== undefined &&
		(state.step === "reading" ||
			state.step === "capturing" ||
			state.step === "uploading")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total: anything that is not a well-formed state reads as "no snapshot yet". */
export function readSnapshotState(raw: unknown): SnapshotState | undefined {
	if (!isRecord(raw)) return undefined;
	const { runId, tabId, url, step, startedAtMs } = raw;
	if (typeof runId !== "string") return undefined;
	if (typeof tabId !== "number") return undefined;
	if (typeof url !== "string") return undefined;
	if (typeof startedAtMs !== "number") return undefined;
	if (!STEPS.includes(step as SnapshotStep)) return undefined;
	return raw as unknown as SnapshotState;
}

/** `snapshotMarkdown`: the markdown of run `runId`. */
export interface StoredMarkdown {
	runId: string;
	markdown: string;
}

export function readStoredMarkdown(raw: unknown): StoredMarkdown | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.runId !== "string" || typeof raw.markdown !== "string")
		return undefined;
	return { runId: raw.runId, markdown: raw.markdown };
}

// ---------------------------------------------------------------------------
// Popup → service worker.

export const SNAPSHOT_START_MESSAGE = "smultron:snapshot-start";

export function snapshotStartMessage(tabId: number): {
	type: typeof SNAPSHOT_START_MESSAGE;
	tabId: number;
} {
	return { type: SNAPSHOT_START_MESSAGE, tabId };
}

export function parseSnapshotStartMessage(
	message: unknown,
): { tabId: number } | undefined {
	if (!isRecord(message) || message.type !== SNAPSHOT_START_MESSAGE)
		return undefined;
	const { tabId } = message;
	if (typeof tabId !== "number" || !Number.isInteger(tabId)) return undefined;
	return { tabId };
}

// ---------------------------------------------------------------------------
// Adapter enable/disable (§17.5): `disabledAdapters: string[]` in
// chrome.storage.sync, missing = everything enabled.

/** Total: a missing or malformed value means nothing is disabled. */
export function parseDisabledAdapters(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((id): id is string => typeof id === "string"))];
}

/** `ids` with `id` switched on (removed) or off (added). Never mutates `ids`. */
export function setAdapterEnabled(
	ids: readonly string[],
	id: string,
	enabled: boolean,
): string[] {
	const rest = ids.filter((other) => other !== id);
	return enabled ? rest : [...rest, id];
}

// ---------------------------------------------------------------------------
// What the injected `snapshot` script returns.

/** `{ result, metadata, html }` (§17.7). */
export interface PageCapture {
	result: ScrapeResult;
	metadata: PageMetadata;
	html: string;
}

/**
 * The script returns its capture as ONE JSON string rather than the object.
 * Chrome converts an injection result into its internal value type, which
 * silently drops anything nested deeper than 100 levels — an adapter's `data`
 * (a deep comment tree) can get there. A string crosses intact.
 *
 * Unserializable adapter `data` (a cycle, a BigInt) costs only the `data`.
 */
export function encodePageCapture(capture: PageCapture): string {
	try {
		return JSON.stringify(capture);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return JSON.stringify({
			...capture,
			result: { ...capture.result, data: { unserializable: message } },
		});
	}
}

/** What the script returns when it fails: the error, in its own words. */
export function encodePageCaptureError(error: unknown): string {
	return JSON.stringify({
		error: error instanceof Error ? error.message : String(error),
	});
}

/**
 * Parse the script's return value. Throws with a readable message on a script
 * error or anything that is not a capture.
 */
export function parsePageCapture(raw: unknown): PageCapture {
	if (typeof raw !== "string") throw new Error("the page returned nothing");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("the page returned malformed data");
	}
	if (!isRecord(parsed)) throw new Error("the page returned malformed data");
	if (typeof parsed.error === "string") throw new Error(parsed.error);
	const { result, metadata, html } = parsed;
	if (
		!isRecord(result) ||
		typeof result.title !== "string" ||
		typeof result.markdown !== "string" ||
		typeof result.adapterId !== "string" ||
		typeof result.adapterVersion !== "string" ||
		!isRecord(metadata) ||
		typeof html !== "string"
	) {
		throw new Error("the page returned malformed data");
	}
	return parsed as unknown as PageCapture;
}

// ---------------------------------------------------------------------------
// `POST /api/snapshots` (§17.8).

export type SnapshotAssetKind = "screenshot" | "html" | "data";

/** One asset's bytes, held by the worker until its PUT. */
export interface AssetBlob {
	kind: SnapshotAssetKind;
	idx: number;
	mime: string;
	bytes: Uint8Array<ArrayBuffer>;
	width?: number;
	height?: number;
}

/** A screenshot tile as the CDP capture produces it. */
export interface ScreenshotTile {
	bytes: Uint8Array<ArrayBuffer>;
	width: number;
	height: number;
}

export interface CreateSnapshotAsset {
	kind: SnapshotAssetKind;
	idx: number;
	mime: string;
	byteSize: number;
	width?: number;
	height?: number;
}

export interface CreateSnapshotBody {
	url: string;
	title: string;
	faviconUrl?: string;
	adapterId: string;
	adapterVersion: string;
	markdown: string;
	metadata: PageMetadata;
	capturedAt: string;
	assets: CreateSnapshotAsset[];
}

/** Cut `text` to at most `limit` UTF-16 units without splitting a surrogate pair. */
function cutAt(text: string, limit: number): string {
	if (text.length <= limit) return text;
	let end = limit;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return text.slice(0, end);
}

/** The markdown within §17.8's 1,000,000 characters, with a note when cut. */
export function capMarkdown(markdown: string): string {
	if (markdown.length <= SNAPSHOT_MARKDOWN_LIMIT) return markdown;
	return (
		cutAt(markdown, SNAPSHOT_MARKDOWN_LIMIT - MARKDOWN_TRUNCATION_NOTE.length) +
		MARKDOWN_TRUNCATION_NOTE
	);
}

function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * The metadata within §17.8's serialized-size cap. Some pages carry enormous
 * JSON-LD or meta lists. Rather than fail the snapshot, the optional lists are
 * emptied one at a time until it fits: JSON-LD, meta tags, links, then the
 * Open Graph and Twitter maps.
 */
export function fitMetadata(
	metadata: PageMetadata,
	limitBytes: number = SNAPSHOT_METADATA_LIMIT_BYTES,
): PageMetadata {
	const fits = (candidate: PageMetadata) =>
		utf8Length(JSON.stringify(candidate)) <= limitBytes;
	if (fits(metadata)) return metadata;
	const steps: Array<(m: PageMetadata) => PageMetadata> = [
		(m) => ({ ...m, jsonLd: [] }),
		(m) => ({ ...m, meta: [] }),
		(m) => ({ ...m, links: [] }),
		(m) => ({ ...m, openGraph: {}, twitter: {} }),
	];
	let current = metadata;
	for (const step of steps) {
		current = step(current);
		if (fits(current)) return current;
	}
	// Only the scalar fields are left; cut the free-text ones hard.
	return {
		...current,
		url: cutAt(current.url, SNAPSHOT_URL_LIMIT),
		canonicalUrl:
			current.canonicalUrl === undefined
				? undefined
				: cutAt(current.canonicalUrl, SNAPSHOT_URL_LIMIT),
		title: cutAt(current.title, SNAPSHOT_TITLE_LIMIT),
		description:
			current.description === undefined
				? undefined
				: cutAt(current.description, 10_000),
		userAgent: cutAt(current.userAgent, 1_000),
		favicon:
			current.favicon === undefined
				? undefined
				: cutAt(current.favicon, SNAPSHOT_URL_LIMIT),
	};
}

/** The tab's favicon only when the server could store it (absolute http(s), bounded). */
function usableFaviconUrl(raw: string | undefined): string | undefined {
	if (raw === undefined || raw.length > SNAPSHOT_URL_LIMIT) return undefined;
	return /^https?:\/\//i.test(raw) ? raw : undefined;
}

/**
 * The asset list in upload order: screenshot tiles top to bottom, then the
 * HTML, then the adapter's `data` (omitted when the adapter returned none).
 * An asset over the bucket's 50 MiB limit is left out rather than failing the
 * whole snapshot.
 */
export function buildAssets(
	capture: PageCapture,
	tiles: readonly ScreenshotTile[],
): AssetBlob[] {
	const encoder = new TextEncoder();
	const assets: AssetBlob[] = tiles.map((tile, idx) => ({
		kind: "screenshot",
		idx,
		mime: "image/webp",
		bytes: tile.bytes,
		width: tile.width,
		height: tile.height,
	}));
	assets.push({
		kind: "html",
		idx: 0,
		mime: "text/html",
		bytes: encoder.encode(capture.html),
	});
	if (capture.result.data !== undefined) {
		assets.push({
			kind: "data",
			idx: 0,
			mime: "application/json",
			bytes: encoder.encode(JSON.stringify(capture.result.data)),
		});
	}
	return assets
		.filter((asset) => asset.bytes.length <= SNAPSHOT_MAX_ASSET_BYTES)
		.slice(0, SNAPSHOT_MAX_ASSETS);
}

/** How many tiles fit beside the HTML and the data asset (§17.4's 64). */
export function maxTilesFor(capture: PageCapture): number {
	const others = capture.result.data === undefined ? 1 : 2;
	return SNAPSHOT_MAX_ASSETS - others;
}

/** `raw` in canonical ISO 8601 form, or `fallback()` when it doesn't parse. */
function isoOr(raw: string, fallback: () => string): string {
	const ms = Date.parse(raw);
	return Number.isNaN(ms) ? fallback() : new Date(ms).toISOString();
}

/** The §17.8 request body. Every limit the server enforces is applied here. */
export function buildCreateBody(input: {
	url: string;
	faviconUrl?: string;
	capture: PageCapture;
	markdown: string;
	assets: readonly AssetBlob[];
	now: () => number;
}): CreateSnapshotBody {
	const { capture } = input;
	const title =
		capture.result.title.trim() || capture.metadata.title?.trim() || input.url;
	const body: CreateSnapshotBody = {
		url: input.url,
		title: cutAt(title, SNAPSHOT_TITLE_LIMIT),
		adapterId: capture.result.adapterId,
		adapterVersion: capture.result.adapterVersion,
		markdown: input.markdown,
		metadata: fitMetadata(capture.metadata),
		capturedAt: isoOr(capture.metadata.capturedAt, () =>
			new Date(input.now()).toISOString(),
		),
		assets: input.assets.map((asset) => {
			const entry: CreateSnapshotAsset = {
				kind: asset.kind,
				idx: asset.idx,
				mime: asset.mime,
				byteSize: asset.bytes.length,
			};
			if (asset.width !== undefined) entry.width = asset.width;
			if (asset.height !== undefined) entry.height = asset.height;
			return entry;
		}),
	};
	const faviconUrl = usableFaviconUrl(input.faviconUrl);
	if (faviconUrl !== undefined) body.faviconUrl = faviconUrl;
	return body;
}
