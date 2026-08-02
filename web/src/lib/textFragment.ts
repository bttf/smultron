// Text Fragment (`#:~:text=`) URL builder — SPEC §9. Builds the link-out URL
// for a stored highlight so clicking it re-scrolls to (and browser-highlights)
// the original selection on the source page, per the URL Fragment Text
// Directive spec (https://wicg.github.io/scroll-to-text-fragment/).
//
// Two forms, chosen by normalized length:
//   - short (<= SHORT_LIMIT chars): exact match, `text=<encoded>`.
//   - long: `text=<start>,<end>` — first/last EXCERPT_BUDGET chars, each cut
//     OUTWARD to the nearest word boundary so a word is never split (a single
//     word longer than the budget is taken whole).
//
// Encoding: `encodeURIComponent` PLUS explicit percent-encoding of the
// fragment-directive delimiter characters (`-`, `,`, `&`) so highlight text
// containing them can never be misread as directive syntax. `encodeURIComponent`
// already escapes `,`/`&` (they're outside its unreserved set) but leaves `-`
// bare; all three are escaped explicitly here anyway, defensively, since
// correctness must not depend on that unreserved-set detail.

const SHORT_LIMIT = 150;
const EXCERPT_BUDGET = 60;

/** Collapse all whitespace runs (spaces, tabs, newlines, ...) to one space, trimmed. */
function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * True when `idx` sits at a word boundary in `text`: the string's edges, or a
 * position where at least one adjacent character is a space. False means
 * `idx` is strictly inside a run of non-space characters (mid-word).
 */
function isWordBoundary(text: string, idx: number): boolean {
	if (idx <= 0 || idx >= text.length) {
		return true;
	}
	return text[idx - 1] === " " || text[idx] === " ";
}

/**
 * First ~`budget` chars of `text`, extended forward (never truncated) to the
 * next word boundary so no word is split.
 */
function prefixToWordBoundary(text: string, budget: number): string {
	if (text.length <= budget) {
		return text;
	}
	let idx = budget;
	while (!isWordBoundary(text, idx)) {
		idx++;
	}
	return text.slice(0, idx).trimEnd();
}

/**
 * Last ~`budget` chars of `text`, extended backward (never truncated) to the
 * previous word boundary so no word is split.
 */
function suffixFromWordBoundary(text: string, budget: number): string {
	if (text.length <= budget) {
		return text;
	}
	let idx = text.length - budget;
	while (!isWordBoundary(text, idx)) {
		idx--;
	}
	return text.slice(idx).trimStart();
}

/** Percent-encode text for use inside a `#:~:text=` directive segment. */
function encodeFragmentText(text: string): string {
	return encodeURIComponent(text)
		.replace(/-/g, "%2D")
		.replace(/,/g, "%2C")
		.replace(/&/g, "%26");
}

function buildTextDirective(normalized: string): string {
	if (normalized.length <= SHORT_LIMIT) {
		return `text=${encodeFragmentText(normalized)}`;
	}
	const start = prefixToWordBoundary(normalized, EXCERPT_BUDGET);
	const end = suffixFromWordBoundary(normalized, EXCERPT_BUDGET);
	return `text=${encodeFragmentText(start)},${encodeFragmentText(end)}`;
}

/**
 * Builds `{pageUrl}#:~:text=...` for `text` per SPEC §9. Any existing fragment
 * on `pageUrl` is stripped before appending. Empty/whitespace-only `text`
 * returns `pageUrl` unchanged (nothing to link to).
 */
export function textFragmentUrl(pageUrl: string, text: string): string {
	const normalized = normalizeWhitespace(text);
	if (normalized.length === 0) {
		return pageUrl;
	}

	const hashIndex = pageUrl.indexOf("#");
	const base = hashIndex === -1 ? pageUrl : pageUrl.slice(0, hashIndex);

	return `${base}#:~:${buildTextDirective(normalized)}`;
}
