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
//   3. KEEP the fragment, minus any text-fragment directive: everything from
//      the first `:~:` inside the fragment is stripped, and a fragment left
//      empty by that (or a bare trailing `#`) is dropped entirely. Everything
//      before `:~:` survives in the parser's canonical fragment encoding
//      (space → %20, `"` → %22, `<` → %3C, `>` → %3E, backtick → %60,
//      non-ASCII → UTF-8 percent-escapes; existing percent-sequences and a
//      stray `%` are left alone). Applies to EVERY scheme.
//
//      m22 change (2026-08-30): rule 3 used to strip the whole fragment,
//      which collapsed every page of a fragment-routed SPA into a single row
//      — bookmarking the Gmail inbox (`…/mail/u/0/#inbox`) bumped and
//      unarchived a years-old bookmark for one specific message, and
//      archiving that row just meant the next save resurrected it. A kept
//      anchor at worst splits one page into two rows; a stripped route makes
//      a page un-bookmarkable, so the fragment stays. The `:~:` directive is
//      the one provably-safe strip: browsers remove it before page scripts
//      run, so it can never carry routing state — and Chrome's "copy link to
//      highlight" plus our own highlight link-outs mint such URLs constantly,
//      so keeping it would dupe rows the app itself already owns. Migration
//      `0013_keep-fragments` recomputed every stored `url_normalized` to
//      match.
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
// only parse (canonical scheme casing) and apply rule 3, because `?` and `/`
// inside such URLs are often payload, not structure (removing a "utm_source"
// from a data: URL would corrupt the data). None of them crash.
//
// Percent-encoding: we emit the parser's canonical path and fragment encoding
// and the raw query byte-for-byte — no extra encoding or decoding — so the
// function is idempotent: normalizeUrl(normalizeUrl(x)) === normalizeUrl(x).
// The kept fragment is idempotent too: it never contains `:~:` after the cut,
// and the parser's fragment encoding is a fixed point.

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

/**
 * Rule 3: the fragment as it survives normalization. `hash` is the raw
 * `#...` slice in the parser's canonical encoding, or `""` when the URL
 * carries no fragment. Everything from the first `:~:` is cut; what is left
 * is dropped when it is a bare `#` (an empty fragment, or one that was
 * nothing but a directive).
 */
function keepFragment(hash: string): string {
	if (hash === "") {
		return "";
	}
	const directive = hash.indexOf(":~:");
	const kept = directive === -1 ? hash : hash.slice(0, directive);
	return kept === "#" ? "" : kept;
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
		// Non-http(s) scheme: rule 3 only (see header comment). Cut the href at
		// its first `#` rather than reading `url.hash` — `hash` is "" for an
		// EMPTY fragment too, but `href` keeps the bare `#` we have to drop.
		const href = url.href;
		const hashAt = href.indexOf("#");
		return hashAt === -1
			? href
			: href.slice(0, hashAt) + keepFragment(href.slice(hashAt));
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

	// 3. The kept fragment goes last. `url.hash` is "" for both "no fragment"
	// and "empty fragment" — exactly the drop rule 3 asks for.
	const fragment = keepFragment(url.hash);

	return `${url.protocol}//${userinfo}${url.host}${path}${query}${fragment}`;
}
