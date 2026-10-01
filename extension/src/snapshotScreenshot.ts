/**
 * Full-page snapshot screenshot over the Chrome DevTools Protocol (m25,
 * SPEC §17.7 step 2).
 *
 * Chrome-free: the debugger calls are injected (`attach`/`send`/`detach`),
 * so the tile plan, the capture sequence and the detach-in-finally rule are
 * unit-testable. `entrypoints/background.ts` binds them to `chrome.debugger`.
 */

import { base64ToBytes } from "./screenshot";
import { type ScreenshotTile, withTimeout } from "./snapshot";

/** Tallest tile in IMAGE pixels: GPU texture limits on long pages (§17.4). */
export const TILE_MAX_PX = 8_000;
export const SNAPSHOT_WEBP_QUALITY = 80;
/** One tile's capture may not take longer than this (a background tab can stall). */
export const TILE_TIMEOUT_MS = 30_000;

/** A `Page.captureScreenshot` clip, in CSS pixels. */
export interface TileClip {
	x: number;
	y: number;
	width: number;
	height: number;
	scale: 1;
}

export interface TilePlanInput {
	/** `cssContentSize` from `Page.getLayoutMetrics`. */
	contentWidth: number;
	contentHeight: number;
	/** `cssLayoutViewport` client size — the floor when the content reports less. */
	viewportWidth: number;
	viewportHeight: number;
	/** The page's `devicePixelRatio`: a CSS pixel becomes this many image pixels. */
	devicePixelRatio: number;
	maxTiles: number;
	maxTilePx?: number;
}

function positive(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Clips covering the page top to bottom, each at most `maxTilePx` IMAGE pixels
 * tall and wide. A clip is in CSS pixels and Chrome renders it at the device
 * pixel ratio, so the CSS tile height is `maxTilePx / dpr` (4000 CSS px on a
 * 2x display). The width is capped the same way, which only crops pages wider
 * than 8000 image pixels.
 *
 * A page whose content reports less than the viewport (an app that scrolls an
 * inner element) is captured at the viewport's size. Past `maxTiles` the
 * bottom of the page is left out.
 */
export function planTiles(input: TilePlanInput): TileClip[] {
	const dpr = positive(input.devicePixelRatio) || 1;
	const maxCss = Math.max(
		1,
		Math.floor((input.maxTilePx ?? TILE_MAX_PX) / dpr),
	);
	const width = Math.min(
		Math.ceil(
			Math.max(positive(input.contentWidth), positive(input.viewportWidth)),
		),
		maxCss,
	);
	const height = Math.ceil(
		Math.max(positive(input.contentHeight), positive(input.viewportHeight)),
	);
	const clips: TileClip[] = [];
	if (width === 0 || height === 0) return clips;
	for (let y = 0; y < height && clips.length < input.maxTiles; y += maxCss) {
		clips.push({
			x: 0,
			y,
			width,
			height: Math.min(maxCss, height - y),
			scale: 1,
		});
	}
	return clips;
}

/**
 * Pixel size from a WebP header (lossy `VP8 `, lossless `VP8L`, extended
 * `VP8X`); undefined when the bytes are not a recognizable WebP.
 */
export function webpSize(
	bytes: Uint8Array,
): { width: number; height: number } | undefined {
	const ascii = (start: number, length: number) =>
		String.fromCharCode(...bytes.subarray(start, start + length));
	if (bytes.length < 30) return undefined;
	if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return undefined;
	const at = (i: number) => bytes[i] ?? 0;
	const chunk = ascii(12, 4);
	if (chunk === "VP8X") {
		return {
			width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)),
			height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)),
		};
	}
	if (chunk === "VP8L") {
		if (at(20) !== 0x2f) return undefined;
		const b1 = at(21);
		const b2 = at(22);
		const b3 = at(23);
		const b4 = at(24);
		return {
			width: 1 + (((b2 & 0x3f) << 8) | b1),
			height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
		};
	}
	if (chunk === "VP8 ") {
		// Frame tag (3 bytes) + start code 9d 01 2a, then 14-bit width/height.
		if (at(23) !== 0x9d || at(24) !== 0x01 || at(25) !== 0x2a) return undefined;
		return {
			width: (at(26) | (at(27) << 8)) & 0x3fff,
			height: (at(28) | (at(29) << 8)) & 0x3fff,
		};
	}
	return undefined;
}

/** The three `chrome.debugger` calls the capture needs, bound to one tab. */
export interface DebuggerDeps {
	attach(): Promise<void>;
	detach(): Promise<void>;
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface Size {
	width: number;
	height: number;
}

function readSize(raw: unknown): Size | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { width, height } = raw as Record<string, unknown>;
	if (typeof width !== "number" || typeof height !== "number") return undefined;
	return { width, height };
}

function readViewport(raw: unknown): Size | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { clientWidth, clientHeight } = raw as Record<string, unknown>;
	if (typeof clientWidth !== "number" || typeof clientHeight !== "number")
		return undefined;
	return { width: clientWidth, height: clientHeight };
}

/**
 * Attach, measure, capture every tile as WebP q80, and ALWAYS detach — the
 * "started debugging this browser" bar stays up for as long as the session
 * does. Throws on any failure; the caller turns that into `screenshotFailed`
 * and zero tiles (§17.7).
 */
export async function captureFullPage(
	deps: DebuggerDeps,
	options: {
		devicePixelRatio: number;
		maxTiles: number;
		tileTimeoutMs?: number;
	},
): Promise<ScreenshotTile[]> {
	await deps.attach();
	try {
		const metrics = (await deps.send("Page.getLayoutMetrics")) as
			| Record<string, unknown>
			| undefined;
		const content =
			readSize(metrics?.cssContentSize) ?? readSize(metrics?.contentSize);
		const viewport =
			readViewport(metrics?.cssLayoutViewport) ??
			readViewport(metrics?.layoutViewport);
		if (content === undefined && viewport === undefined)
			throw new Error("no layout metrics");
		const clips = planTiles({
			contentWidth: content?.width ?? 0,
			contentHeight: content?.height ?? 0,
			viewportWidth: viewport?.width ?? 0,
			viewportHeight: viewport?.height ?? 0,
			devicePixelRatio: options.devicePixelRatio,
			maxTiles: options.maxTiles,
		});
		if (clips.length === 0) throw new Error("the page has no size");
		const dpr = positive(options.devicePixelRatio) || 1;
		const tiles: ScreenshotTile[] = [];
		for (const clip of clips) {
			const shot = (await withTimeout(
				deps.send("Page.captureScreenshot", {
					format: "webp",
					quality: SNAPSHOT_WEBP_QUALITY,
					captureBeyondViewport: true,
					clip,
				}),
				options.tileTimeoutMs ?? TILE_TIMEOUT_MS,
				"screenshot",
			)) as { data?: unknown } | undefined;
			if (typeof shot?.data !== "string" || shot.data === "")
				throw new Error("empty screenshot");
			const bytes = base64ToBytes(shot.data);
			const size = webpSize(bytes) ?? {
				width: Math.round(clip.width * dpr),
				height: Math.round(clip.height * dpr),
			};
			tiles.push({ bytes, width: size.width, height: size.height });
		}
		return tiles;
	} finally {
		await deps.detach().catch(() => {});
	}
}
