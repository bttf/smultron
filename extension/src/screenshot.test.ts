/**
 * Save-time screenshot capture (m23, SPEC §15.3).
 *
 * The Chrome surface is injected: `queryAllTabs`, `captureVisibleTab` and the
 * DOM-bound encoder are fakes here, so the gating, the tab match and the byte
 * cap are all provable without a browser.
 */

import { describe, expect, it, vi } from "vitest";
import {
	base64ByteLength,
	base64ToBytes,
	captureForUrl,
	dataUrlToBase64,
	type EncodeJpeg,
	fitWidth,
	looksBlank,
	type QueryAllTabs,
	SCREENSHOT_MAX_BYTES,
	SCREENSHOT_MAX_WIDTH,
	SCREENSHOT_MIN_BYTES,
	SCREENSHOT_MIN_BYTES_WIDTH,
	type ScreenshotCaptureDeps,
	type TabSnapshot,
} from "./screenshot";

const URL_UNDER_TEST = "https://example.com/a";
const DATA_URL = "data:image/jpeg;base64,/9j/AAA=";

function tabs(...list: TabSnapshot[]): QueryAllTabs {
	return async () => list;
}

/**
 * An encoder that reports whatever byte length the test asks for, at a width
 * wide enough to keep the blank-page floor out of the byte-cap tests (the
 * floor's own tests set the width deliberately).
 */
function fakeEncoder(
	sizes: Record<number, number>,
	base64 = "AAAA",
	width = SCREENSHOT_MAX_WIDTH,
): ReturnType<typeof vi.fn<EncodeJpeg>> {
	return vi.fn<EncodeJpeg>(async (_dataUrl, quality) => ({
		base64,
		byteLength: sizes[quality] ?? 0,
		width,
	}));
}

function deps(overrides: Partial<ScreenshotCaptureDeps> = {}) {
	return {
		queryAllTabs: tabs({
			url: URL_UNDER_TEST,
			active: true,
			windowId: 1,
		}),
		captureVisibleTab: vi.fn(async () => DATA_URL),
		encodeJpeg: fakeEncoder({ 0.8: 100_000 }),
		...overrides,
	} satisfies ScreenshotCaptureDeps;
}

describe("fitWidth", () => {
	it("leaves an image already within the bound untouched", () => {
		expect(fitWidth(1280, 800, 1280)).toEqual({ width: 1280, height: 800 });
		expect(fitWidth(640, 400, 1280)).toEqual({ width: 640, height: 400 });
	});

	it("scales to the max width with a proportional, rounded height", () => {
		// A DPR-2 laptop viewport: 2560x1600 → 1280x800.
		expect(fitWidth(2560, 1600, 1280)).toEqual({ width: 1280, height: 800 });
		// 1707 * (1280/2560) = 853.5 → rounds to 854.
		expect(fitWidth(2560, 1707, 1280)).toEqual({ width: 1280, height: 854 });
	});

	it("never rounds the height below 1 (a 0-height canvas is a throw)", () => {
		expect(fitWidth(4000, 1, 1280).height).toBe(1);
	});

	it("passes degenerate dimensions through rather than inventing them", () => {
		expect(fitWidth(0, 0, 1280)).toEqual({ width: 0, height: 0 });
	});
});

describe("base64 helpers", () => {
	it("reports the decoded byte length without decoding", () => {
		for (const value of ["", "AA==", "AAA=", "AAAA", "AAAAAA=="]) {
			expect(base64ByteLength(value)).toBe(base64ToBytes(value).length);
		}
	});

	it("decodes to the exact bytes", () => {
		// "/9j/" is the JPEG SOI marker the server checks for.
		expect(Array.from(base64ToBytes("/9j/"))).toEqual([0xff, 0xd8, 0xff]);
	});

	it("strips a data: prefix, and returns '' when there is no payload", () => {
		expect(dataUrlToBase64(DATA_URL)).toBe("/9j/AAA=");
		expect(dataUrlToBase64("not-a-data-url")).toBe("");
	});
});

describe("captureForUrl gating (SPEC §15.3)", () => {
	it("never captures a non-http(s) URL", async () => {
		for (const url of [
			"chrome://extensions",
			"file:///Users/a/notes.txt",
			"javascript:void 0",
			"",
		]) {
			const d = deps({
				queryAllTabs: tabs({ url, active: true, windowId: 1 }),
			});
			expect(await captureForUrl(d, url)).toBeUndefined();
			expect(d.captureVisibleTab).not.toHaveBeenCalled();
		}
	});

	it("matches tab.url as a STRING, so a #fragment URL is found", async () => {
		// `tabs.query({url})` takes a MATCH PATTERN, where a `#` matches nothing
		// (src/favicon.ts records the full reasoning) — string equality does not.
		const url = "https://mail.google.com/mail/u/0/#inbox";
		const d = deps({ queryAllTabs: tabs({ url, active: true, windowId: 3 }) });
		expect(await captureForUrl(d, url)).toBe("AAAA");
		expect(d.captureVisibleTab).toHaveBeenCalledWith(3, {
			format: "jpeg",
			quality: 80,
		});
	});

	it("treats `*` as a literal, never a wildcard", async () => {
		const d = deps({
			queryAllTabs: tabs({
				url: "https://example.com/secret",
				active: true,
				windowId: 1,
			}),
		});
		expect(await captureForUrl(d, "https://example.com/*")).toBeUndefined();
		expect(d.captureVisibleTab).not.toHaveBeenCalled();
	});

	it("does not capture when the matching tab is not active", async () => {
		// captureVisibleTab photographs the window's ACTIVE tab: capturing for a
		// background tab would file an unrelated page's pixels.
		const d = deps({
			queryAllTabs: tabs(
				{ url: URL_UNDER_TEST, active: false, windowId: 1 },
				{ url: "https://other.example/", active: true, windowId: 1 },
			),
		});
		expect(await captureForUrl(d, URL_UNDER_TEST)).toBeUndefined();
		expect(d.captureVisibleTab).not.toHaveBeenCalled();
	});

	it("does not capture when no tab shows the URL (manager, drag, device sync)", async () => {
		const d = deps({ queryAllTabs: tabs() });
		expect(await captureForUrl(d, URL_UNDER_TEST)).toBeUndefined();
		expect(d.captureVisibleTab).not.toHaveBeenCalled();
	});

	it("does not capture a matching tab with no windowId", async () => {
		const d = deps({
			queryAllTabs: tabs({ url: URL_UNDER_TEST, active: true }),
		});
		expect(await captureForUrl(d, URL_UNDER_TEST)).toBeUndefined();
		expect(d.captureVisibleTab).not.toHaveBeenCalled();
	});

	it("picks the ACTIVE tab's window when several tabs share the URL", async () => {
		const d = deps({
			queryAllTabs: tabs(
				{ url: URL_UNDER_TEST, active: false, windowId: 1 },
				{ url: URL_UNDER_TEST, active: true, windowId: 7 },
			),
		});
		await captureForUrl(d, URL_UNDER_TEST);
		expect(d.captureVisibleTab).toHaveBeenCalledWith(7, expect.anything());
	});
});

describe("captureForUrl failure paths (never throws)", () => {
	it("returns undefined when the capture is rejected", async () => {
		// Minimized window, the Web Store, the once-per-second rate limit.
		const d = deps({
			captureVisibleTab: vi.fn(async () => {
				throw new Error("Cannot access contents of the page");
			}),
		});
		await expect(captureForUrl(d, URL_UNDER_TEST)).resolves.toBeUndefined();
	});

	it("returns undefined when the tab query rejects", async () => {
		const d = deps({
			queryAllTabs: async () => {
				throw new Error("context invalidated");
			},
		});
		await expect(captureForUrl(d, URL_UNDER_TEST)).resolves.toBeUndefined();
	});

	it("returns undefined when the encoder rejects", async () => {
		const d = deps({
			encodeJpeg: async () => {
				throw new Error("no 2d context");
			},
		});
		await expect(captureForUrl(d, URL_UNDER_TEST)).resolves.toBeUndefined();
	});

	it("returns undefined on an empty capture or an empty encode", async () => {
		await expect(
			captureForUrl(
				deps({ captureVisibleTab: vi.fn(async () => "") }),
				URL_UNDER_TEST,
			),
		).resolves.toBeUndefined();
		await expect(
			captureForUrl(
				deps({ encodeJpeg: fakeEncoder({ 0.8: 100_000 }, "") }),
				URL_UNDER_TEST,
			),
		).resolves.toBeUndefined();
	});
});

describe("captureForUrl byte cap (SPEC §15.3)", () => {
	it("uses the quality-0.8 encode when it is within the cap", async () => {
		const encodeJpeg = fakeEncoder({ 0.8: SCREENSHOT_MAX_BYTES });
		expect(await captureForUrl(deps({ encodeJpeg }), URL_UNDER_TEST)).toBe(
			"AAAA",
		);
		expect(encodeJpeg).toHaveBeenCalledTimes(1);
		expect(encodeJpeg).toHaveBeenCalledWith(DATA_URL, 0.8);
	});

	it("re-encodes at quality 0.6 when the first encode exceeds the cap", async () => {
		const encodeJpeg = fakeEncoder({
			0.8: SCREENSHOT_MAX_BYTES + 1,
			0.6: SCREENSHOT_MAX_BYTES,
		});
		expect(await captureForUrl(deps({ encodeJpeg }), URL_UNDER_TEST)).toBe(
			"AAAA",
		);
		expect(encodeJpeg.mock.calls.map(([, quality]) => quality)).toEqual([
			0.8, 0.6,
		]);
	});

	it("gives up (no capture) when even quality 0.6 stays over the cap", async () => {
		const encodeJpeg = fakeEncoder({
			0.8: SCREENSHOT_MAX_BYTES * 3,
			0.6: SCREENSHOT_MAX_BYTES + 1,
		});
		expect(
			await captureForUrl(deps({ encodeJpeg }), URL_UNDER_TEST),
		).toBeUndefined();
		expect(encodeJpeg).toHaveBeenCalledTimes(2);
	});

	it("keeps the downscale bound and the cap in the documented shape", () => {
		expect(SCREENSHOT_MAX_WIDTH).toBe(1280);
		expect(SCREENSHOT_MAX_BYTES).toBe(1_048_576);
	});
});

describe("captureForUrl blank-page floor (RED-206)", () => {
	it("gives up on a wide capture that encodes under the floor", async () => {
		// A client-rendered app photographed before it paints: 1280 px of flat
		// colour compresses to a few KB. The server keeps the FIRST screenshot,
		// so filing this one would make the blank permanent.
		const encodeJpeg = fakeEncoder({ 0.8: 7_000 }, "AAAA", 1280);

		expect(
			await captureForUrl(deps({ encodeJpeg }), URL_UNDER_TEST),
		).toBeUndefined();
		// The floor is not a size problem: no reduced-quality retry is spent.
		expect(encodeJpeg).toHaveBeenCalledTimes(1);
	});

	it("keeps a wide capture that carries real content", async () => {
		const encodeJpeg = fakeEncoder({ 0.8: 30_000 }, "AAAA", 1280);

		expect(await captureForUrl(deps({ encodeJpeg }), URL_UNDER_TEST)).toBe(
			"AAAA",
		);
	});

	it("keeps a small capture at the same byte count (narrow viewports encode small)", async () => {
		const encodeJpeg = fakeEncoder({ 0.8: 7_000 }, "AAAA", 640);

		expect(await captureForUrl(deps({ encodeJpeg }), URL_UNDER_TEST)).toBe(
			"AAAA",
		);
	});

	it("applies the floor to the reduced-quality encode too", async () => {
		// Contrived — a capture over 1 MiB does not re-encode to 7 KB — but the
		// guard must judge whatever bytes are actually about to be uploaded.
		const encodeJpeg = fakeEncoder({}, "AAAA", 1280);
		encodeJpeg.mockImplementation(async (_dataUrl, quality) => ({
			base64: "AAAA",
			byteLength: quality === 0.8 ? SCREENSHOT_MAX_BYTES + 1 : 7_000,
			width: 1280,
		}));

		expect(
			await captureForUrl(deps({ encodeJpeg }), URL_UNDER_TEST),
		).toBeUndefined();
		expect(encodeJpeg).toHaveBeenCalledTimes(2);
	});

	it("judges bytes and width together", () => {
		const at = (byteLength: number, width: number) =>
			looksBlank({ base64: "AAAA", byteLength, width });

		// Exactly at the floor is content; one byte under it is not.
		expect(at(SCREENSHOT_MIN_BYTES, SCREENSHOT_MIN_BYTES_WIDTH)).toBe(false);
		expect(at(SCREENSHOT_MIN_BYTES - 1, SCREENSHOT_MIN_BYTES_WIDTH)).toBe(true);
		// Exactly at the width bound is judged; one pixel under it is exempt.
		expect(at(SCREENSHOT_MIN_BYTES - 1, SCREENSHOT_MIN_BYTES_WIDTH - 1)).toBe(
			false,
		);
	});

	it("keeps the floor in the documented shape", () => {
		expect(SCREENSHOT_MIN_BYTES).toBe(12_288);
		expect(SCREENSHOT_MIN_BYTES_WIDTH).toBe(1000);
	});
});
