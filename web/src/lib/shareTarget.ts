// Web Share Target parameter handling (m14). Android share sheets are sloppy:
// some apps fill `url`, many put the link inside `text` (often wrapped in
// prose — "Check this out https://… via X"), and a few only populate `title`.
// This module turns whatever arrived into one http(s) URL, or null.
//
// Validation deliberately matches POST /api/bookmarks (src/app/api/bookmarks/
// route.ts): parseable URL, http/https scheme, dotted hostname. It does NOT
// normalize — normalization stays the single server-side implementation in
// `normalizeUrl`, applied downstream by `addBookmark`.

/** Punctuation share sheets tend to append after a URL. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", '"', "'"]);

/** Closers only stripped when unbalanced — `…/Ruby_(gem)` must survive. */
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function isUsable(candidate: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return false;
	}
	return (
		(parsed.protocol === "http:" || parsed.protocol === "https:") &&
		parsed.hostname.includes(".")
	);
}

/**
 * Strips punctuation the share sheet (or the surrounding sentence) glued onto
 * the end. Two guards keep real URLs intact: a closing bracket is only dropped
 * when it has no matching opener inside the URL (so
 * `…/wiki/Ruby_(gem)` survives while `(https://…/a)` loses its wrapper), and
 * nothing is dropped unless the shorter string is still a usable URL.
 */
function trimTrailingPunctuation(candidate: string): string {
	let out = candidate;
	while (out.length > 1) {
		const last = out[out.length - 1];
		const opener = CLOSERS[last];
		if (opener) {
			const body = out.slice(0, -1);
			const opens = body.split(opener).length - 1;
			const closes = body.split(last).length - 1;
			if (opens > closes) break; // balanced by an opener in the URL
		} else if (!TRAILING_PUNCTUATION.has(last)) {
			break;
		}
		const shorter = out.slice(0, -1);
		if (!isUsable(shorter)) break;
		out = shorter;
	}
	return out;
}

/** First http(s) URL appearing in free text, or null. */
function firstUrlIn(text: string): string | null {
	const matches = text.match(/https?:\/\/[^\s<>"']+/gi);
	if (!matches) return null;
	for (const match of matches) {
		const trimmed = trimTrailingPunctuation(match);
		if (isUsable(trimmed)) return trimmed;
	}
	return null;
}

/** A whole-field value, trimmed of whitespace then trailing punctuation. */
function fromField(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = trimTrailingPunctuation(value.trim());
	return isUsable(trimmed) ? trimmed : null;
}

/**
 * Precedence: an explicit valid `url` param wins; otherwise the first http(s)
 * URL embedded in `text`; otherwise the first in `title`. Returns null when
 * nothing shareable is present (caller shows an "invalid share" toast).
 */
export function extractSharedUrl(params: {
	title?: string;
	text?: string;
	url?: string;
}): string | null {
	const direct = fromField(params.url);
	if (direct) return direct;

	// The `url` field can itself carry prose on some Android builds.
	if (params.url) {
		const embedded = firstUrlIn(params.url);
		if (embedded) return embedded;
	}

	if (params.text) {
		const embedded = firstUrlIn(params.text);
		if (embedded) return embedded;
	}

	if (params.title) {
		const fromTitle = fromField(params.title) ?? firstUrlIn(params.title);
		if (fromTitle) return fromTitle;
	}

	return null;
}
