/**
 * Save-time page screenshot (m23, SPEC §15.3).
 *
 * When a bookmark is created through the extension, the extension photographs
 * the tab the user is looking at and queues the JPEG for upload. Everything
 * that is not a DOM API lives here: pure, dependency-injected, no Chrome
 * imports, and TOTAL — every failure path is "no screenshot", never a throw
 * into a bookmarks listener.
 *
 * Tab matching repeats the favicon lookup's argument (SPEC §5, src/favicon.ts):
 * `chrome.tabs.query({})` and `tab.url === url` as a STRING, never
 * `query({ url })`, whose argument is a MATCH PATTERN — a `#` makes it match
 * nothing, `*` acts as a wildcard, and userinfo isn't a valid pattern at all.
 * The tab must also be `active` in its window, because `captureVisibleTab`
 * photographs whatever that window is showing: capturing for a background tab
 * would file an unrelated page's pixels under this bookmark.
 *
 * Byte discipline: Chrome hands back the full device-pixel viewport, which on
 * a DPR-2 display is ~2560 px wide. The injected encoder downscales to
 * SCREENSHOT_MAX_WIDTH; if the result still exceeds SCREENSHOT_MAX_BYTES it is
 * re-encoded at SCREENSHOT_RETRY_QUALITY, and if that is still too big the
 * capture is abandoned — the server's own limit is 2 MiB and a queued entry is
 * only worth keeping if it can be delivered.
 */

import { isTrackableUrl } from "./trackedCache";

/** Widest image we upload; Chrome's raw capture is downscaled to it. */
export const SCREENSHOT_MAX_WIDTH = 1280;

/** `captureVisibleTab` quality (0-100) — Chrome's own JPEG encode. */
export const SCREENSHOT_CAPTURE_QUALITY = 80;

/** Canvas re-encode quality (0-1), and the reduced retry under the byte cap. */
export const SCREENSHOT_JPEG_QUALITY = 0.8;
export const SCREENSHOT_RETRY_QUALITY = 0.6;

/** Byte cap on the encoded JPEG (1 MiB), well under the server's 2 MiB. */
export const SCREENSHOT_MAX_BYTES = 1_048_576;

/** The fields of `chrome.tabs.Tab` this reads. */
export interface TabSnapshot {
	url?: string;
	active?: boolean;
	windowId?: number;
}

/** `chrome.tabs.query({})` — every tab in every window. */
export type QueryAllTabs = () => Promise<TabSnapshot[]>;

/**
 * `chrome.tabs.captureVisibleTab(windowId, options)` — resolves to a
 * `data:image/jpeg;base64,…` URL of that window's visible viewport, and
 * REJECTS for a minimized window, a page Chrome refuses to capture (the Web
 * Store, other extensions' pages) or the once-per-second rate limit.
 */
export type CaptureVisibleTab = (
	windowId: number,
	options: { format: "jpeg"; quality: number },
) => Promise<string>;

/** A JPEG ready for the outbox: base64 (no `data:` prefix) + its decoded size. */
export interface EncodedJpeg {
	base64: string;
	byteLength: number;
}

/**
 * Decode + downscale + re-encode, injected because it is the one piece needing
 * DOM APIs (`createImageBitmap`, `OffscreenCanvas`) — the m15 grey-icon render
 * is the precedent. Implemented in `entrypoints/background.ts`.
 */
export type EncodeJpeg = (
	dataUrl: string,
	quality: number,
) => Promise<EncodedJpeg>;

export interface ScreenshotCaptureDeps {
	queryAllTabs: QueryAllTabs;
	captureVisibleTab: CaptureVisibleTab;
	encodeJpeg: EncodeJpeg;
}

/**
 * Target dimensions for a bitmap constrained to `max` px wide, aspect ratio
 * preserved and the height rounded. Images already within the bound are
 * returned unchanged (the caller then keeps Chrome's own bytes rather than
 * re-encoding them). The height never rounds below 1: a canvas of height 0 is
 * a construction error, not a thin image.
 */
export function fitWidth(
	width: number,
	height: number,
	max: number,
): { width: number; height: number } {
	if (!(width > 0) || !(height > 0) || width <= max) return { width, height };
	return {
		width: max,
		height: Math.max(1, Math.round((height * max) / width)),
	};
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64ByteLength(base64: string): number {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * base64 → raw bytes. Used at flush time to put the JPEG on the wire as a
 * binary body (SPEC §15.3); throws on a corrupt string, which the outbox
 * treats as an undeliverable entry.
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Strip the `data:image/jpeg;base64,` prefix; "" when there is no payload. */
export function dataUrlToBase64(dataUrl: string): string {
	const comma = dataUrl.indexOf(",");
	return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

/**
 * The base64 JPEG (no `data:` prefix) of the tab showing exactly `url`, or
 * undefined when there is nothing to capture: a non-http(s) URL, no ACTIVE tab
 * on that URL (a bookmark made from the manager, a drag, or another device's
 * sync has no visible page to photograph), a capture Chrome refused, or an
 * image that stays over the byte cap even at reduced quality.
 *
 * Never throws — a screenshot is a nicety and must not disturb the sync entry
 * it rides behind.
 */
export async function captureForUrl(
	deps: ScreenshotCaptureDeps,
	url: string,
): Promise<string | undefined> {
	if (!isTrackableUrl(url)) return undefined;
	try {
		const tabs = await deps.queryAllTabs();
		// String equality, then `active`: see the header comment.
		const tab = tabs.find(
			(candidate) => candidate.url === url && candidate.active === true,
		);
		const windowId = tab?.windowId;
		if (windowId === undefined) return undefined;

		const dataUrl = await deps.captureVisibleTab(windowId, {
			format: "jpeg",
			quality: SCREENSHOT_CAPTURE_QUALITY,
		});
		if (typeof dataUrl !== "string" || dataUrl === "") return undefined;

		const encoded = await deps.encodeJpeg(dataUrl, SCREENSHOT_JPEG_QUALITY);
		if (encoded.byteLength <= SCREENSHOT_MAX_BYTES)
			return encoded.base64 === "" ? undefined : encoded.base64;

		// Over the cap: one retry at reduced quality, then give up.
		const retried = await deps.encodeJpeg(dataUrl, SCREENSHOT_RETRY_QUALITY);
		if (retried.byteLength > SCREENSHOT_MAX_BYTES) return undefined;
		return retried.base64 === "" ? undefined : retried.base64;
	} catch {
		// A rejected query/capture/encode, or a torn-down extension context.
		return undefined;
	}
}
