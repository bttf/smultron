import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FLIP_INTERVAL_MS,
	faceShowing,
	flipRotation,
	prefersReducedMotion,
	REDUCED_MOTION_QUERY,
	startFlipping,
} from "./wordmark";

/** Stands in for `window.matchMedia`, recording what it was asked about. */
function stubMatchMedia(matches: boolean): { queries: string[] } {
	const queries: string[] = [];
	vi.stubGlobal("matchMedia", (query: string) => {
		queries.push(query);
		return { matches } as MediaQueryList;
	});
	return { queries };
}

/** Stands in for `document.visibilityState`. */
function stubVisibility(state: "visible" | "hidden"): void {
	vi.stubGlobal("document", { visibilityState: state });
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("prefersReducedMotion", () => {
	it("is false with no matchMedia at all (the server render)", () => {
		vi.stubGlobal("matchMedia", undefined);
		expect(prefersReducedMotion()).toBe(false);
	});

	it("is false when the browser reports no preference", () => {
		const { queries } = stubMatchMedia(false);
		expect(prefersReducedMotion()).toBe(false);
		expect(queries).toEqual([REDUCED_MOTION_QUERY]);
	});

	it("is true when the browser asks to reduce motion", () => {
		stubMatchMedia(true);
		expect(prefersReducedMotion()).toBe(true);
	});
});

describe("flip geometry", () => {
	it("adds a half turn per flip, always in one direction", () => {
		expect([0, 1, 2, 3].map(flipRotation)).toEqual([0, 180, 360, 540]);
	});

	it("alternates the visible face", () => {
		expect([0, 1, 2, 3].map(faceShowing)).toEqual([
			"front",
			"back",
			"front",
			"back",
		]);
	});
});

describe("startFlipping", () => {
	it("flips once per interval", () => {
		vi.useFakeTimers();
		stubVisibility("visible");
		const onFlip = vi.fn();
		startFlipping(onFlip);

		vi.advanceTimersByTime(FLIP_INTERVAL_MS - 1);
		expect(onFlip).toHaveBeenCalledTimes(0);

		vi.advanceTimersByTime(1);
		expect(onFlip).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(FLIP_INTERVAL_MS * 3);
		expect(onFlip).toHaveBeenCalledTimes(4);
	});

	it("toggles the face back and forth over successive intervals", () => {
		vi.useFakeTimers();
		stubVisibility("visible");
		let flips = 0;
		startFlipping(() => {
			flips += 1;
		});

		const faces: string[] = [faceShowing(flips)];
		for (let tick = 0; tick < 3; tick += 1) {
			vi.advanceTimersByTime(FLIP_INTERVAL_MS);
			faces.push(faceShowing(flips));
		}
		expect(faces).toEqual(["front", "back", "front", "back"]);
	});

	it("banks no flips while the tab is hidden", () => {
		vi.useFakeTimers();
		stubVisibility("hidden");
		const onFlip = vi.fn();
		startFlipping(onFlip);

		// Chrome keeps the (throttled) timer running on a hidden tab but
		// freezes rAF, so counting these would spend as one multi-spin later.
		vi.advanceTimersByTime(FLIP_INTERVAL_MS * 5);
		expect(onFlip).toHaveBeenCalledTimes(0);

		stubVisibility("visible");
		vi.advanceTimersByTime(FLIP_INTERVAL_MS * 2);
		expect(onFlip).toHaveBeenCalledTimes(2);
	});

	it("stops when the returned stopper runs (unmount)", () => {
		vi.useFakeTimers();
		stubVisibility("visible");
		const onFlip = vi.fn();
		const stop = startFlipping(onFlip);

		vi.advanceTimersByTime(FLIP_INTERVAL_MS);
		stop();
		vi.advanceTimersByTime(FLIP_INTERVAL_MS * 5);

		expect(onFlip).toHaveBeenCalledTimes(1);
	});
});
