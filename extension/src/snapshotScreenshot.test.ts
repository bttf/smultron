import { describe, expect, it } from "vitest";
import {
	captureFullPage,
	type DebuggerDeps,
	planTiles,
	webpSize,
} from "./snapshotScreenshot";

const base = {
	contentWidth: 1280,
	contentHeight: 0,
	viewportWidth: 1280,
	viewportHeight: 800,
	devicePixelRatio: 1,
	maxTiles: 62,
};

describe("planTiles", () => {
	it("splits a tall page into tiles of at most 8000 image px, top to bottom", () => {
		const clips = planTiles({ ...base, contentHeight: 20_000 });
		expect(clips.map((c) => [c.y, c.height])).toEqual([
			[0, 8000],
			[8000, 8000],
			[16_000, 4000],
		]);
		expect(
			clips.every((c) => c.x === 0 && c.width === 1280 && c.scale === 1),
		).toBe(true);
	});

	it("divides the tile height by the device pixel ratio", () => {
		const clips = planTiles({
			...base,
			contentHeight: 9000,
			devicePixelRatio: 2,
		});
		expect(clips.map((c) => c.height)).toEqual([4000, 4000, 1000]);
	});

	it("uses the viewport when the content reports less (inner-scrolling apps)", () => {
		expect(planTiles({ ...base, contentHeight: 10 })).toEqual([
			{ x: 0, y: 0, width: 1280, height: 800, scale: 1 },
		]);
	});

	it("stops at maxTiles and caps the width", () => {
		const clips = planTiles({
			...base,
			contentWidth: 20_000,
			contentHeight: 100_000,
			maxTiles: 2,
		});
		expect(clips).toHaveLength(2);
		expect(clips[0]?.width).toBe(8000);
	});

	it("plans nothing for a page with no size", () => {
		expect(
			planTiles({
				...base,
				contentWidth: 0,
				contentHeight: 0,
				viewportWidth: 0,
				viewportHeight: 0,
			}),
		).toEqual([]);
	});
});

function riff(chunk: string, payload: number[]): Uint8Array {
	const bytes = new Uint8Array(32);
	bytes.set(
		[..."RIFF"].map((c) => c.charCodeAt(0)),
		0,
	);
	bytes.set(
		[..."WEBP"].map((c) => c.charCodeAt(0)),
		8,
	);
	bytes.set(
		[...chunk].map((c) => c.charCodeAt(0)),
		12,
	);
	bytes.set(payload, 20);
	return bytes;
}

describe("webpSize", () => {
	it("reads a lossy VP8 header", () => {
		const bytes = riff(
			"VP8 ",
			[0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0xd0, 0x0b, 0x40, 0x1f],
		);
		expect(webpSize(bytes)).toEqual({ width: 3024, height: 8000 });
	});

	it("reads an extended VP8X header", () => {
		const bytes = riff(
			"VP8X",
			[0, 0, 0, 0, 0xcf, 0x0b, 0x00, 0x3f, 0x1f, 0x00],
		);
		expect(webpSize(bytes)).toEqual({ width: 3024, height: 8000 });
	});

	it("reads a lossless VP8L header", () => {
		const bytes = riff("VP8L", [0x2f, 0x63, 0x40, 0x0c, 0x00]);
		expect(webpSize(bytes)).toEqual({ width: 100, height: 50 });
	});

	it("is undefined for anything else", () => {
		expect(webpSize(new Uint8Array(40))).toBeUndefined();
		expect(webpSize(new Uint8Array(4))).toBeUndefined();
	});
});

function fakeDebugger(
	send: DebuggerDeps["send"],
): DebuggerDeps & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		attach: async () => {
			calls.push("attach");
		},
		detach: async () => {
			calls.push("detach");
		},
		send: async (method, params) => {
			calls.push(method);
			return send(method, params);
		},
	};
}

const METRICS = {
	cssContentSize: { x: 0, y: 0, width: 1000, height: 5000 },
	cssLayoutViewport: { clientWidth: 1000, clientHeight: 700 },
};

describe("captureFullPage", () => {
	it("captures each planned tile as WebP q80 beyond the viewport, then detaches", async () => {
		const params: unknown[] = [];
		const deps = fakeDebugger(async (method, p) => {
			if (method === "Page.getLayoutMetrics") return METRICS;
			params.push(p);
			return { data: btoa("not a real webp") };
		});
		const tiles = await captureFullPage(deps, {
			devicePixelRatio: 2,
			maxTiles: 62,
		});
		expect(deps.calls).toEqual([
			"attach",
			"Page.getLayoutMetrics",
			"Page.captureScreenshot",
			"Page.captureScreenshot",
			"detach",
		]);
		expect(params[0]).toEqual({
			format: "webp",
			quality: 80,
			captureBeyondViewport: true,
			clip: { x: 0, y: 0, width: 1000, height: 4000, scale: 1 },
		});
		// No parseable header: the size falls back to clip × dpr.
		expect(tiles.map((t) => [t.width, t.height])).toEqual([
			[2000, 8000],
			[2000, 2000],
		]);
	});

	it("detaches when a capture fails, and rethrows", async () => {
		const deps = fakeDebugger(async (method) => {
			if (method === "Page.getLayoutMetrics") return METRICS;
			throw new Error("boom");
		});
		await expect(
			captureFullPage(deps, { devicePixelRatio: 1, maxTiles: 62 }),
		).rejects.toThrow("boom");
		expect(deps.calls.at(-1)).toBe("detach");
	});

	it("times out a stalled tile and still detaches", async () => {
		const deps = fakeDebugger(async (method) => {
			if (method === "Page.getLayoutMetrics") return METRICS;
			return new Promise(() => {});
		});
		await expect(
			captureFullPage(deps, {
				devicePixelRatio: 1,
				maxTiles: 62,
				tileTimeoutMs: 5,
			}),
		).rejects.toThrow("timed out");
		expect(deps.calls.at(-1)).toBe("detach");
	});
});
