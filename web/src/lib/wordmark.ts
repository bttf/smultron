// Header wordmark flip (RED-204). The decision logic lives here — free of
// React and of the DOM — so the reduced-motion rule and the flip timer are
// unit-testable in the node-environment Vitest setup; `components/wordmark.tsx`
// is the thin rendering layer over it.

/** The accessible name of the app — the only string screen readers get. */
export const WORDMARK_FRONT = "Smultronstället";

/** The translation shown on the back face. Decorative, `aria-hidden`. */
export const WORDMARK_BACK = "Wild Strawberry Patch";

export const WORDMARK_GLYPH = "🍓";

/** Time each face is held before the next half turn. */
export const FLIP_INTERVAL_MS = 7000;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Under-damped on purpose: friction well below the critical value for this
 * tension makes the half turn overshoot and settle with a visible wobble,
 * which is the point of using a spring rather than a CSS keyframe.
 */
export const FLIP_SPRING_CONFIG = {
	mass: 1,
	tension: 170,
	friction: 13,
} as const;

/**
 * True only when the browser reports an explicit reduce preference. Absent
 * `matchMedia` — the server, or a very old browser — is "no preference", so
 * this is safe to call during SSR and the first client render agrees with it.
 */
export function prefersReducedMotion(): boolean {
	return (
		typeof globalThis.matchMedia === "function" &&
		globalThis.matchMedia(REDUCED_MOTION_QUERY).matches
	);
}

/**
 * The spring's target. Flips accumulate in one direction — each one is another
 * half turn — so the animation never reverses and the back face is always
 * reached the same way.
 */
export function flipRotation(flips: number): number {
	return flips * 180;
}

/** Which face ends up toward the viewer after `flips` half turns. */
export function faceShowing(flips: number): "front" | "back" {
	return flips % 2 === 0 ? "front" : "back";
}

/**
 * Drives the flip on a fixed interval. Returns the stopper; the caller (an
 * effect) must run it on unmount, otherwise the timer outlives the component.
 */
export function startFlipping(
	onFlip: () => void,
	intervalMs: number = FLIP_INTERVAL_MS,
): () => void {
	const id = setInterval(onFlip, intervalMs);
	return () => clearInterval(id);
}
