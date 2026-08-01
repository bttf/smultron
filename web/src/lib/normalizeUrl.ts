// URL normalization — SPEC §4. Server-side only (Hard rule #3): this is the
// single implementation used to compute `url_normalized`, the dedupe key.
// The original URL is stored untouched in `url`.
//
// Rules:
//   1. Parse with WHATWG `new URL()`; on failure return the trimmed original.
//   2. Lowercase scheme + host (the parser does this canonically; it also
//      punycode-encodes IDN hosts, e.g. münchen.de → xn--mnchen-3ya.de, and
//      drops default ports — :443 for https, :80 for http — so two spellings
//      of the same origin collapse to one key).
//   3. Strip the fragment (`#...`).
//   4. Remove tracking params: any name with the `utm_` prefix, plus `fbclid`
//      and `gclid`. Matching is case-insensitive (Chrome-reality reading:
//      `UTM_SOURCE` and `utm_source` are the same tracker; treating them
//      differently would split identical pages into two rows) and the name is
//      percent-decoded before matching (`%75tm_source` is `utm_source`). All
//      other params are KEPT, preserving their original order and their
//      original raw encoding — we filter the raw query string rather than
//      round-tripping through URLSearchParams, which would re-encode values
//      (e.g. `%20` → `+`) and break percent-encoding stability.
//   5. Strip a single trailing slash from the path. The root path collapses
//      entirely: `https://x.com/` → `https://x.com` (SPEC example), and
//      `https://x.com/a/` → `https://x.com/a`. Query params survive the
//      strip (`https://x.com/a/?b=1` → `https://x.com/a?b=1`), and an empty
//      query after tracking-param removal leaves no dangling `?`. "Single"
//      is read strictly: a path ending in MULTIPLE slashes (`/a//`) is left
//      untouched — stripping one of several slashes would make the function
//      non-idempotent (`/a//` → `/a/` → `/a` on a second pass), and `/a//`
//      (an empty final segment) is genuinely a different resource than `/a`.
//
// Steps 4–5 apply only to http/https URLs. Chrome bookmarks can hold
// `chrome://`, `about:`, `javascript:`, `data:`, `file://`, … — for those we
// only parse (canonical scheme casing) and strip the fragment, because `?`
// and `/` inside such URLs are often payload, not structure (removing a
// "utm_source" from a data: URL would corrupt the data). None of them crash.
//
// Percent-encoding: we emit the parser's canonical path encoding and the raw
// query byte-for-byte — no extra encoding or decoding — so the function is
// idempotent: normalizeUrl(normalizeUrl(x)) === normalizeUrl(x).

const TRACKING_EXACT = new Set(["fbclid", "gclid"]);

function isTrackingParam(rawName: string): boolean {
	let name = rawName;
	try {
		name = decodeURIComponent(rawName);
	} catch {
		// Malformed percent-encoding — match on the raw name.
	}
	name = name.toLowerCase();
	return name.startsWith("utm_") || TRACKING_EXACT.has(name);
}

export function normalizeUrl(raw: string): string {
	const trimmed = raw.trim();

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return trimmed;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		// Non-http(s) scheme: fragment strip only (see header comment).
		url.hash = "";
		return url.href;
	}

	// 4. Filter tracking params out of the RAW query string, preserving the
	// order and exact encoding of everything we keep.
	let query = "";
	if (url.search.length > 1) {
		const kept = url.search
			.slice(1)
			.split("&")
			.filter((pair) => {
				const eq = pair.indexOf("=");
				const name = eq === -1 ? pair : pair.slice(0, eq);
				return !isTrackingParam(name);
			});
		if (kept.length > 0) {
			query = `?${kept.join("&")}`;
		}
	}

	// 5. Strip the trailing slash when there is exactly one; root "/" becomes
	// "" (dropped entirely). Paths ending in "//" are left alone (see header).
	let path = url.pathname;
	if (path.endsWith("/") && !path.endsWith("//")) {
		path = path.slice(0, -1);
	}

	// Reassemble by hand: URL#href would re-add the root slash we just
	// dropped. `url.host` already excludes default ports and is lowercase.
	const userinfo =
		url.username || url.password
			? `${url.username}${url.password ? `:${url.password}` : ""}@`
			: "";

	return `${url.protocol}//${userinfo}${url.host}${path}${query}`;
}
