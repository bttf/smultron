"use client";
// The header wordmark (RED-204). Every 7 seconds it takes a half turn about
// the horizontal axis, alternating between "Smultronstället" and its English
// translation. The turn is driven by a spring (`@react-spring/web`) rather
// than a keyframe so it overshoots and wobbles into place.
//
// Accessibility: the front face carries the app's name and is the only text in
// the accessibility tree — the back face and the width sizer are `aria-hidden`,
// and there is no live region, so a flip announces nothing. Under
// `prefers-reduced-motion: reduce` the component renders the static wordmark
// and starts no timer at all.
import { animated, useSpring } from "@react-spring/web";
import { useEffect, useState } from "react";
import {
	FLIP_SPRING_CONFIG,
	flipRotation,
	prefersReducedMotion,
	REDUCED_MOTION_QUERY,
	startFlipping,
	WORDMARK_BACK,
	WORDMARK_FRONT,
	WORDMARK_GLYPH,
} from "../lib/wordmark";

// Both faces sit on top of each other, so each needs the full box. Normal
// inline flow inside (not flex): a flex container would swallow the space
// between the glyph and the name.
const FACE = "absolute inset-0 whitespace-nowrap";

// Everything except the front face: `aria-hidden` keeps it out of the
// accessibility tree, but a drag-select would still copy it out along with
// the name, so it takes no pointer input and no selection either.
const HIDDEN_TEXT = "select-none pointer-events-none";

function FrontFace() {
	return (
		<>
			<span aria-hidden>{WORDMARK_GLYPH}</span> {WORDMARK_FRONT}
		</>
	);
}

/**
 * Starts at "no preference" — which is what the server rendered — and syncs
 * after mount, so hydration never disagrees. Tracks later changes too: the
 * setting can be toggled while the page is open.
 */
function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);

	useEffect(() => {
		setReduced(prefersReducedMotion());
		if (typeof window.matchMedia !== "function") return;
		const query = window.matchMedia(REDUCED_MOTION_QUERY);
		const onChange = () => setReduced(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);

	return reduced;
}

export function Wordmark() {
	const reduced = useReducedMotion();
	const [flips, setFlips] = useState(0);
	const spring = useSpring({
		rotateX: flipRotation(flips),
		config: FLIP_SPRING_CONFIG,
	});

	useEffect(() => {
		if (reduced) return;
		return startFlipping(() => setFlips((current) => current + 1));
	}, [reduced]);

	if (reduced) {
		return (
			<span className="text-sm font-semibold tracking-tight">
				<FrontFace />
			</span>
		);
	}

	return (
		<span className="text-sm font-semibold tracking-tight">
			{/* Grid-stacked copies of both faces, invisible: the container ends up
			    as wide as the LONGER string, so a flip never moves the header. */}
			<span className="relative inline-grid align-bottom [perspective:600px]">
				<span
					aria-hidden
					className={`invisible col-start-1 row-start-1 whitespace-nowrap ${HIDDEN_TEXT}`}
				>
					<FrontFace />
				</span>
				<span
					aria-hidden
					className={`invisible col-start-1 row-start-1 whitespace-nowrap ${HIDDEN_TEXT}`}
				>
					{WORDMARK_BACK}
				</span>
				<animated.span
					className="absolute inset-0 [transform-style:preserve-3d]"
					style={{
						transform: spring.rotateX.to((degrees) => `rotateX(${degrees}deg)`),
					}}
				>
					<span className={`${FACE} [backface-visibility:hidden]`}>
						<FrontFace />
					</span>
					<span
						aria-hidden
						className={`${FACE} ${HIDDEN_TEXT} [backface-visibility:hidden] [transform:rotateX(180deg)]`}
					>
						{WORDMARK_BACK}
					</span>
				</animated.span>
			</span>
		</span>
	);
}
