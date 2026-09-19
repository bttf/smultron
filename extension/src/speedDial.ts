/**
 * Speed dial (m24, SPEC §16) — the row of round site icons at the top of the
 * new tab page, edited on the Options page.
 *
 * EXTENSION-LOCAL by design: the list lives in `chrome.storage.local` under
 * `speedDial` and nowhere else. There is no server table, no API route and no
 * sync — a speed dial is browser furniture, not a bookmark, and it has to work
 * on an unpaired extension. Nothing here touches the outbox, the `newtab`
 * snapshot cache or the `bookmarks` table.
 *
 * Chrome-free like the rest of `src/` (extension/AGENTS.md): storage, `fetch`
 * and the id minter are injected, so every rule below is unit-testable.
 */

import { type KeyValueStorage, SPEED_DIAL_KEY } from "./types";

/** One entry of the row, in display order. */
export interface SpeedDial {
	/** `crypto.randomUUID()` minted at add time; the DnD payload (SPEC §16.4). */
	id: string;
	/** Display label — the anchor's `title` and the image's `alt`. */
	name: string;
	/** The parsed `URL.href`. */
	url: string;
	/**
	 * The site's touch icon, when the metadata fill found one (SPEC §16.3).
	 * Absent otherwise — the render then falls through to the icon service.
	 */
	iconUrl?: string;
}

/**
 * Most dials anyone will keep, and the width of the row before it wraps
 * awkwardly. `readSpeedDial` truncates to it; an add past it is refused
 * (SPEC §16.1).
 */
export const SPEED_DIAL_CAP = 24;

/** Everything `addDial` can refuse for, in the words the Options page shows. */
export type DialError =
	| "not a valid URL"
	| "already added"
	| "speed dial is full";

/**
 * A parsed draft. An EMPTY draft is its own outcome, not an error: pressing
 * Enter on a blank box does nothing at all and must not paint a red line
 * (SPEC §16.2).
 */
export type ParseDialUrlResult =
	| { ok: true; url: string }
	| { ok: false; empty: true }
	| { ok: false; empty: false; error: "not a valid URL" };

export type AddDialResult =
	| { ok: true; dial: SpeedDial; dials: SpeedDial[] }
	| { ok: false; empty: true }
	| { ok: false; empty: false; error: DialError };

// ---------------------------------------------------------------------------
// URL handling.

/** An absolute http(s) URL string — what both `url` and `iconUrl` must be. */
function isDialUrl(value: unknown): value is string {
	if (typeof value !== "string" || value === "") return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * What the user typed → the URL to store (SPEC §16.2).
 *
 * Trim; a bare `example.com` gets `https://` (the scheme test is
 * case-insensitive, so `HTTP://x.test` is left alone); the result must parse
 * as an http(s) URL without userinfo whose hostname looks like a hostname — a dot somewhere, or
 * exactly `localhost`, which is the one dotless host a dev actually dials.
 * Anything else is `not a valid URL`.
 */
export function parseDialUrl(draft: string): ParseDialUrlResult {
	const trimmed = draft.trim();
	if (trimmed === "") return { ok: false, empty: true };
	const withScheme = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return { ok: false, empty: false, error: "not a valid URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, empty: false, error: "not a valid URL" };
	}
	// `mailto:a@example.com` survives the prepend as userinfo on example.com.
	// Nobody dials a URL with credentials in it; refuse rather than store them.
	if (url.username !== "" || url.password !== "") {
		return { ok: false, empty: false, error: "not a valid URL" };
	}
	const host = url.hostname;
	if (!host.includes(".") && host !== "localhost") {
		return { ok: false, empty: false, error: "not a valid URL" };
	}
	return { ok: true, url: url.href };
}

/**
 * The default display name: the hostname without a leading `www.`. Also the
 * sentinel `fillDialMetadata` compares against — a name that still equals this
 * is one the user has never seen a real title for.
 */
export function dialHostName(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./i, "");
	} catch {
		return url;
	}
}

/**
 * The icon service, by origin (SPEC §16.3): it resolves a site's
 * touch-icon-grade art, which covers the sites that ship
 * `/apple-touch-icon.png` without a `<link>` tag, the dials whose fill failed,
 * and a stored icon that later 404s.
 *
 * Deliberately NOT the s2 endpoint the log rows use: that serves 16–32 px
 * favicons, which are transparent-margined and blur when blown up to 34 px.
 */
export function dialIconUrl(url: string): string {
	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch {
		origin = url;
	}
	return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(origin)}&size=128`;
}

/**
 * Every image URL to try for one dial, best first (SPEC §16.3): the touch icon
 * the fill stored, then the icon service. Each `error` on the rendered `<img>`
 * advances to the next; once the list is exhausted the frame shows the first
 * character of `name` rather than a broken-image glyph.
 */
export function dialIconSources(dial: SpeedDial): string[] {
	const service = dialIconUrl(dial.url);
	if (dial.iconUrl === undefined || dial.iconUrl === service) return [service];
	return [dial.iconUrl, service];
}

/**
 * Whether two lists are the same row (SPEC §16.4) — same length, and every
 * position the same id, name, url and icon.
 *
 * The new tab page's echo skip: its own commit comes back through
 * `storage.onChanged`, and a list equal to what is already on screen must paint
 * nothing rather than rebuild the row it just arranged.
 */
export function sameDials(
	a: readonly SpeedDial[],
	b: readonly SpeedDial[],
): boolean {
	if (a.length !== b.length) return false;
	return a.every((dial, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			dial.id === other.id &&
			dial.name === other.name &&
			dial.url === other.url &&
			dial.iconUrl === other.iconUrl
		);
	});
}

// ---------------------------------------------------------------------------
// Storage.

function asDial(raw: unknown): SpeedDial | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const entry = raw as Record<string, unknown>;
	if (typeof entry.id !== "string" || entry.id === "") return undefined;
	if (typeof entry.name !== "string") return undefined;
	if (!isDialUrl(entry.url)) return undefined;
	const dial: SpeedDial = { id: entry.id, name: entry.name, url: entry.url };
	// A junk `iconUrl` costs the ICON, not the dial: the render falls through to
	// the icon service, which is where a dial without one lives anyway.
	if (isDialUrl(entry.iconUrl)) dial.iconUrl = entry.iconUrl;
	return dial;
}

/** The stored value → a usable list. Shared by both reads below. */
function parseDials(raw: unknown): SpeedDial[] {
	if (typeof raw !== "object" || raw === null) return [];
	const value = (raw as Record<string, unknown>).dials;
	if (!Array.isArray(value)) return [];
	const dials: SpeedDial[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const dial = asDial(entry);
		if (dial === undefined) continue;
		// A repeated id would give two rows the same DnD payload; keep the first.
		if (seen.has(dial.id)) continue;
		seen.add(dial.id);
		dials.push(dial);
		if (dials.length === SPEED_DIAL_CAP) break;
	}
	return dials;
}

/**
 * The read every WRITER uses (SPEC §16.1): identical to `readSpeedDial` except
 * that a rejected `storage.get` propagates.
 *
 * A total read feeding a read-modify-write would turn one transient storage
 * failure into an erased list — the write would build on "no dials" and store
 * exactly that. Failing the write instead leaves the stored list alone and
 * lets the page show its `couldn't save` state.
 */
async function readDialsStrict(storage: KeyValueStorage): Promise<SpeedDial[]> {
	return parseDials(await storage.get(SPEED_DIAL_KEY));
}

/**
 * The stored list, in display order.
 *
 * TOTAL by contract, like `readSnapshot` (SPEC §16.1): a missing key, a value
 * from an older build, junk, or a storage failure all read as an empty list,
 * and one unusable entry costs that entry rather than the row. The new tab
 * page paints this before anything else on EVERY tab — it must never throw.
 * READERS only: see `readDialsStrict` for what the writers use.
 */
export async function readSpeedDial(
	storage: KeyValueStorage,
): Promise<SpeedDial[]> {
	try {
		return await readDialsStrict(storage);
	} catch {
		return [];
	}
}

/**
 * Persist a list. Every writer below re-reads first (SPEC §16.1): the Options
 * page and any open new tab can both write, so a write must never be built on
 * a list read minutes ago.
 */
async function writeDials(
	storage: KeyValueStorage,
	dials: SpeedDial[],
): Promise<void> {
	await storage.set(SPEED_DIAL_KEY, { dials });
}

/**
 * Add the draft, minting an id (SPEC §16.2). The name starts as the hostname
 * and there is no icon yet; the Options page then tries the page itself
 * (`fetchDialMetadata` → `fillDialMetadata`), which is best-effort and may
 * never land.
 *
 * The duplicate check runs before the cap check: "already added" is the more
 * useful answer when a full row happens to contain the URL being typed.
 */
export async function addDial(
	storage: KeyValueStorage,
	draft: string,
	mintId: () => string,
): Promise<AddDialResult> {
	const parsed = parseDialUrl(draft);
	if (!parsed.ok) return parsed;
	const dials = await readDialsStrict(storage);
	if (dials.some((dial) => dial.url === parsed.url)) {
		return { ok: false, empty: false, error: "already added" };
	}
	if (dials.length >= SPEED_DIAL_CAP) {
		return { ok: false, empty: false, error: "speed dial is full" };
	}
	const dial: SpeedDial = {
		id: mintId(),
		name: dialHostName(parsed.url),
		url: parsed.url,
	};
	const next = [...dials, dial];
	await writeDials(storage, next);
	return { ok: true, dial, dials: next };
}

/**
 * Remove a dial. There is no save button for this section, so this writes at
 * once; an unknown id writes nothing (SPEC §16.2).
 */
export async function removeDial(
	storage: KeyValueStorage,
	id: string,
): Promise<SpeedDial[]> {
	const dials = await readDialsStrict(storage);
	const next = dials.filter((dial) => dial.id !== id);
	if (next.length === dials.length) return dials;
	await writeDials(storage, next);
	return next;
}

/**
 * Commit a dragged order (SPEC §16.4) — the new tab page's one write.
 *
 * Lenient like `reorderPinned` (SPEC §8), and for the same reason: the list it
 * re-reads may have moved under the gesture. The listed ids come first in list
 * order; an id that no longer exists is dropped (a dial removed in Options
 * mid-drag is NOT resurrected); a repeat after the first is ignored; anything
 * stored but unlisted keeps its relative order after them. An order that
 * already matches writes nothing.
 */
export async function reorderSpeedDial(
	storage: KeyValueStorage,
	ids: readonly string[],
): Promise<SpeedDial[]> {
	const dials = await readDialsStrict(storage);
	const byId = new Map(dials.map((dial) => [dial.id, dial]));
	const next: SpeedDial[] = [];
	const placed = new Set<string>();
	for (const id of ids) {
		const dial = byId.get(id);
		if (dial === undefined || placed.has(id)) continue;
		placed.add(id);
		next.push(dial);
	}
	for (const dial of dials) {
		if (!placed.has(dial.id)) next.push(dial);
	}
	if (next.every((dial, index) => dial.id === dials[index]?.id)) return dials;
	await writeDials(storage, next);
	return next;
}

// ---------------------------------------------------------------------------
// Metadata fill (SPEC §16.2) — best effort, always.

/** How much of the response body is scanned for a title or a touch icon. */
export const HTML_SCAN_LIMIT = 512 * 1024;

/** Longest display name kept; a long `<title>` is truncated, not refused. */
export const DIAL_NAME_LIMIT = 80;

/** Abort budget for the one metadata fetch (SPEC §16.2). */
export const DIAL_FETCH_TIMEOUT_MS = 5000;

/** What one page read can contribute to a dial. Either field may be absent. */
export interface DialMetadata {
	title?: string;
	iconUrl?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

/**
 * Just enough entity decoding for a `<title>` or an `href` (SPEC §16.2).
 * Deliberately not a full HTML entity table: an unknown entity is left
 * verbatim rather than guessed at, which is the safe way to be wrong.
 */
function decodeEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
		(whole, body: string) => {
			if (body.startsWith("#")) {
				const hex = body[1] === "x" || body[1] === "X";
				const digits = hex ? body.slice(2) : body.slice(1);
				const code = Number.parseInt(digits, hex ? 16 : 10);
				if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff)
					return whole;
				try {
					return String.fromCodePoint(code);
				} catch {
					return whole;
				}
			}
			return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
		},
	);
}

/**
 * The first `<title>` of a page, as a display name — or undefined when there
 * is none worth showing (SPEC §16.2).
 *
 * Only the first `HTML_SCAN_LIMIT` characters are considered: a `<title>` in
 * `<head>` arrives early, and a document that has not produced one by then is
 * one whose bytes are not worth walking. Whitespace collapses (a `<title>`
 * split over three indented lines is common), entities decode, and the result
 * is capped so one pathological page can't push a 4 000-character label into
 * the row.
 */
export function extractTitle(html: string): string | undefined {
	// INDEX SEARCH, not a lazy regex (SPEC §16.2): `<title\b[^>]*>([\s\S]*?)<\/title`
	// re-scans the whole document from every `<title`-shaped position, so half a
	// megabyte of `<title>` with no closing tag costs seconds on the Options
	// page's main thread. `indexOf` walks each region once.
	const head = html.slice(0, HTML_SCAN_LIMIT);
	const lower = head.toLowerCase();
	let from = 0;
	for (;;) {
		const open = lower.indexOf("<title", from);
		if (open === -1) return undefined;
		// The `\b` of the old pattern: `<titlebar>` is a different element.
		if (isWordCode(lower.charCodeAt(open + 6))) {
			from = open + 6;
			continue;
		}
		const gt = lower.indexOf(">", open + 6);
		if (gt === -1) return undefined;
		const close = lower.indexOf("</title", gt + 1);
		if (close === -1) return undefined;
		const text = decodeEntities(head.slice(gt + 1, close))
			.replace(/\s+/g, " ")
			.trim();
		if (text === "") return undefined;
		return text.slice(0, DIAL_NAME_LIMIT);
	}
}

/**
 * `rel="a b"`, `rel=a`, `REL='a'` — attributes of one tag, lowercased keys.
 *
 * The name must start at the tag body's start or right after whitespace, `/`
 * or a closing quote. Without that anchor the engine starts a fresh attempt at
 * every character of a long unbroken word run, walking it to the end each time
 * before failing on the missing `=` — quadratic, and 128 KiB of `a` took nine
 * seconds. Anchored, only real attribute positions are tried.
 */
function tagAttributes(tag: string): Map<string, string> {
	const attributes = new Map<string, string>();
	const pattern =
		/(?:^|[\s/"'])([a-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
	let match = pattern.exec(tag);
	while (match !== null) {
		const name = (match[1] ?? "").toLowerCase();
		if (!attributes.has(name)) {
			attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
		}
		match = pattern.exec(tag);
	}
	return attributes;
}

/**
 * Longest `<link …>` body walked (SPEC §16.2). A tag past it is SKIPPED, not
 * truncated: two kilobytes is an order of magnitude more than any real link
 * tag, so anything longer is padding, and refusing it caps every per-tag cost
 * below — including `tagAttributes` — at a constant.
 */
const TAG_BODY_LIMIT = 2048;

/** `\b` as the regex engine means it: a word character ends an identifier. */
function isWordCode(code: number): boolean {
	return (
		(code >= 48 && code <= 57) || // 0-9
		(code >= 65 && code <= 90) || // A-Z
		(code >= 97 && code <= 122) || // a-z
		code === 95 // _
	);
}

/**
 * Walk every `<link …>` body in one pass, bounded (SPEC §16.2).
 *
 * `/<link\b([^>]*)>/g` re-walks the rest of the document from every `<link`
 * in it, which is quadratic on a page that opens a few thousand of them and
 * closes none. Here the `>` cursor only ever moves FORWARD, so the whole scan
 * costs one pass whatever the input looks like.
 */
function scanLinkTags(head: string, visit: (body: string) => void): void {
	const opens = /<link\b/gi;
	let gt = head.indexOf(">");
	let open = opens.exec(head);
	while (open !== null) {
		const bodyStart = open.index + open[0].length;
		while (gt !== -1 && gt < bodyStart) gt = head.indexOf(">", gt + 1);
		// No closing bracket left anywhere: nothing after this can be a tag.
		if (gt === -1) return;
		if (gt - bodyStart <= TAG_BODY_LIMIT) {
			visit(head.slice(bodyStart, gt));
			opens.lastIndex = gt + 1;
		} else {
			// An overlong tag is skipped; scanning resumes INSIDE it, so a real
			// `<link>` buried in the padding is still found.
			opens.lastIndex = bodyStart;
		}
		open = opens.exec(head);
	}
}

/** The largest edge a `sizes` attribute declares; 0 when there isn't one. */
function largestSizeEdge(sizes: string | undefined): number {
	if (sizes === undefined) return 0;
	let largest = 0;
	for (const token of sizes.trim().split(/\s+/)) {
		const match = /^(\d+)[x×](\d+)$/i.exec(token);
		if (match === null) continue;
		largest = Math.max(largest, Number(match[1]), Number(match[2]));
	}
	return largest;
}

/**
 * The page's touch icon (SPEC §16.3) — the large, opaque, square art a site
 * ships for home screens, which is what fills a 34 px circle properly.
 *
 * Scans `<link>` tags whose `rel` TOKEN LIST holds `apple-touch-icon` or
 * `apple-touch-icon-precomposed` (`rel="icon apple-touch-icon"` counts), and
 * takes the largest declared `sizes` edge; a missing or unparseable `sizes` is
 * 0 and ties keep the first, so a page that declares nothing still yields its
 * first tag. `baseUrl` is the fetch's FINAL `response.url`, so a redirect to
 * `www.` resolves relative hrefs against the host that actually served them.
 * A tag whose href won't resolve to absolute http(s) is skipped.
 *
 * Regex, not a parser: this runs on a page the user typed, in the Options
 * page, for a decoration — a malformed document costs the icon, nothing else.
 */
export function extractTouchIcon(
	html: string,
	baseUrl: string,
): string | undefined {
	let best: string | undefined;
	let bestEdge = -1;
	scanLinkTags(html.slice(0, HTML_SCAN_LIMIT), (body) => {
		const attributes = tagAttributes(body);
		const rel = (attributes.get("rel") ?? "").toLowerCase().trim().split(/\s+/);
		const isTouchIcon =
			rel.includes("apple-touch-icon") ||
			rel.includes("apple-touch-icon-precomposed");
		const href = attributes.get("href");
		if (!isTouchIcon || href === undefined || href.trim() === "") return;
		const edge = largestSizeEdge(attributes.get("sizes"));
		// Strictly greater, so the FIRST of equally sized tags wins.
		if (edge <= bestEdge) return;
		let resolved: string | undefined;
		try {
			resolved = new URL(decodeEntities(href.trim()), baseUrl).href;
		} catch {
			resolved = undefined;
		}
		if (isDialUrl(resolved)) {
			best = resolved;
			bestEdge = edge;
		}
	});
	return best;
}

/**
 * The first `HTML_SCAN_LIMIT` characters of a response, and no more
 * (SPEC §16.2).
 *
 * `response.text()` buffers whatever the server decides to send — an endless
 * stream is an endless allocation on the Options page. So the body is read
 * chunk by chunk and the reader CANCELLED at the limit, which also closes the
 * connection. A test double (or any response without a readable `body`) falls
 * back to `text()`, sliced.
 */
async function readBoundedHtml(response: Response): Promise<string> {
	const body: ReadableStream<Uint8Array> | null | undefined = response.body;
	if (
		body === null ||
		body === undefined ||
		typeof body.getReader !== "function"
	) {
		return (await response.text()).slice(0, HTML_SCAN_LIMIT);
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let html = "";
	try {
		while (html.length < HTML_SCAN_LIMIT) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (chunk.value !== undefined) {
				html += decoder.decode(chunk.value, { stream: true });
			}
		}
	} finally {
		// Releases the connection. An already-errored or already-closed stream
		// rejects here, and that is not news — the read result stands.
		try {
			await reader.cancel();
		} catch {
			// nothing to do: we are done with this body either way.
		}
	}
	return html.slice(0, HTML_SCAN_LIMIT);
}

/**
 * ONE uncredentialed GET of the URL the user just typed, for its `<title>` and
 * its touch icon (SPEC §16.2). This is the only place the extension reads a
 * page's content, and it runs from the Options page only.
 *
 * Every failure means the same thing — nothing found — so a non-2xx, a content
 * type that isn't HTML, a network error and the abort all return `{}`. It
 * NEVER throws: the add has already been written, and this is decoration on
 * top of it.
 */
export async function fetchDialMetadata(
	url: string,
	fetchImpl: typeof fetch,
	options: { timeoutMs?: number } = {},
): Promise<DialMetadata> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, options.timeoutMs ?? DIAL_FETCH_TIMEOUT_MS);
	try {
		const response = await fetchImpl(url, {
			// No cookies on the way out: this is a page the user typed, not a
			// session of theirs the extension has any business carrying.
			credentials: "omit",
			signal: controller.signal,
		});
		if (!response.ok) return {};
		const type = response.headers.get("content-type") ?? "";
		if (!type.toLowerCase().includes("text/html")) return {};
		// The abort stays armed across this (`clearTimeout` is in `finally`), so
		// a body that stalls half way through is cut off like a stalled header.
		const html = await readBoundedHtml(response);
		// The FINAL URL (SPEC §16.3): a redirect to `www.` must not leave a
		// relative href resolving against the host that redirected away.
		const baseUrl =
			typeof response.url === "string" && response.url !== ""
				? response.url
				: url;
		const metadata: DialMetadata = {};
		const title = extractTitle(html);
		if (title !== undefined) metadata.title = title;
		const iconUrl = extractTouchIcon(html, baseUrl);
		if (iconUrl !== undefined) metadata.iconUrl = iconUrl;
		return metadata;
	} catch {
		return {};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Write fetched metadata back (SPEC §16.2), re-reading first.
 *
 * Every guard here is about the seconds the fetch was out for: a dial that is
 * gone stays gone; a name that is no longer the hostname default is left alone
 * (the user is looking at that label, and a late fetch must not overwrite it,
 * nor a second fill overwrite the first); an icon already stored stands.
 * Returns whether anything changed, so the caller repaints only when it did.
 * Never throws.
 */
export async function fillDialMetadata(
	storage: KeyValueStorage,
	id: string,
	metadata: DialMetadata,
): Promise<boolean> {
	try {
		const dials = await readDialsStrict(storage);
		const index = dials.findIndex((dial) => dial.id === id);
		const dial = dials[index];
		if (dial === undefined) return false;
		const next: SpeedDial = { ...dial };
		let changed = false;
		const title = metadata.title?.trim() ?? "";
		if (
			title !== "" &&
			dial.name === dialHostName(dial.url) &&
			dial.name !== title
		) {
			next.name = title;
			changed = true;
		}
		if (dial.iconUrl === undefined && isDialUrl(metadata.iconUrl)) {
			next.iconUrl = metadata.iconUrl;
			changed = true;
		}
		if (!changed) return false;
		const updated = dials.slice();
		updated[index] = next;
		await writeDials(storage, updated);
		return true;
	} catch {
		return false;
	}
}
