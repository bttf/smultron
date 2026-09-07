/**
 * Action-icon tracked state (SPEC §6, m15) — the pure half.
 *
 * The toolbar icon glows golden when the ACTIVE tab's page is tracked: a
 * live (non-archived) bookmark row exists for its URL. Everything that is
 * not a definite "yes" — unknown, lookup failure, unpaired, non-http(s) —
 * shows the default icon. This module owns every decision in that sentence
 * (cache freshness, the never-glow-on-uncertainty rule, message validation)
 * so the background entrypoint is left with nothing but Chrome glue.
 *
 * m23 (SPEC §15.4) widened the cached VALUE from a bare boolean to
 * `{ tracked, bookmarkId?, hasScreenshot? }` so the screenshot backfill can
 * reuse the lookup the icon already performs. The icon's own logic is
 * untouched: it reads `tracked` and nothing else.
 *
 * No Chrome imports here: the clock is injected, so tests drive TTL expiry
 * by hand (extension/AGENTS.md).
 *
 * Keys are RAW url strings exactly as Chrome reports them — the server
 * normalizes (root AGENTS.md hard rule #3), so the extension must not.
 */

/** What the toolbar icon should show for the active tab. */
export type IconState = "glow" | "default";

/**
 * Everything the watcher can know about the active tab, as a closed set.
 * Only `{ status: "tracked", tracked: true }` may glow.
 */
export type TrackedStatus =
	/** A lookup (or an optimistic override) resolved definitively. */
	| { status: "tracked"; tracked: boolean }
	/** Cache miss / expired / still in flight. */
	| { status: "unknown" }
	/** Lookup failed (network error, non-2xx, unparseable body). */
	| { status: "error" }
	/** No token stored — nothing to look the URL up against. */
	| { status: "unpaired" }
	/** Missing URL, or a scheme the app can't bookmark. */
	| { status: "unsupported" };

/**
 * The never-glow-on-uncertainty rule, in one place: glow ONLY for a definite
 * `tracked === true`. Anything else — including a malformed/absent input —
 * falls back to the default icon.
 */
export function resolveIconState(input: TrackedStatus | undefined): IconState {
	return input !== undefined &&
		input.status === "tracked" &&
		input.tracked === true
		? "glow"
		: "default";
}

/** Only http(s) pages can carry a bookmark row (SPEC §6 popup rules). */
export function isTrackableUrl(url: string | undefined | null): url is string {
	return typeof url === "string" && /^https?:\/\//i.test(url);
}

/** Minimal shape the watcher reads off `GET /api/bookmarks/by-url`. */
export interface TrackedBookmark {
	/** Row id — m23 (§15.4) keys the backfill's one-attempt set on it. */
	id?: string;
	archivedAt: string | null;
	/** m23 (§15.1): the public screenshot URL, null when there is none. */
	screenshotUrl?: string | null;
}

/** Tracked = a bookmark row exists AND it is not archived (SPEC §6). */
export function isTrackedBookmark(
	bookmark: TrackedBookmark | null | undefined,
): boolean {
	return (
		bookmark !== null && bookmark !== undefined && bookmark.archivedAt === null
	);
}

/**
 * What the cache remembers about one URL (SPEC §15.4).
 *
 * `tracked` is the m15 verdict and the ONLY field the icon reads. The other
 * two exist for the m23 backfill and are OPTIONAL by design: an optimistic
 * override (`onCreated`, a popup ping) knows the page is tracked but knows
 * nothing about its row id or its screenshot, and `hasScreenshot === undefined`
 * must never trigger a backfill — the never-glow-on-uncertainty rule's sibling.
 */
export interface TrackedEntry {
	tracked: boolean;
	bookmarkId?: string;
	hasScreenshot?: boolean;
}

/**
 * Build the cache entry for a `GET /api/bookmarks/by-url` response body.
 *
 * A row that is absent yields `{ tracked: false }` and nothing else — there is
 * no id to remember. A row that exists contributes its id and its screenshot
 * state even when archived (the backfill's `tracked === true` test already
 * rules archived rows out, and storing the extra fields keeps "a lookup stores
 * all three" true of every lookup).
 *
 * `screenshotUrl` missing from the body (a server older than §15.1) leaves
 * `hasScreenshot` undefined rather than guessing `true` from `!== null` — an
 * absent field is uncertainty, and uncertainty does nothing.
 */
export function trackedEntryFor(
	bookmark: TrackedBookmark | null | undefined,
): TrackedEntry {
	const entry: TrackedEntry = { tracked: isTrackedBookmark(bookmark) };
	if (bookmark === null || bookmark === undefined) return entry;
	const id = bookmark.id;
	if (typeof id === "string" && id !== "") entry.bookmarkId = id;
	const screenshotUrl = bookmark.screenshotUrl;
	if (screenshotUrl === null) entry.hasScreenshot = false;
	else if (typeof screenshotUrl === "string") entry.hasScreenshot = true;
	return entry;
}

// ---------------------------------------------------------------------------
// Popup → background ping (SPEC §6: archive/restore/pin-unarchive/CTA create).

export const TRACKED_CHANGED = "tracked-changed";

export interface TrackedChangedMessage {
	kind: typeof TRACKED_CHANGED;
	url: string;
	tracked: boolean;
}

export function trackedChangedMessage(
	url: string,
	tracked: boolean,
): TrackedChangedMessage {
	return { kind: TRACKED_CHANGED, url, tracked };
}

/**
 * Defensive parse of anything arriving on `runtime.onMessage` — the channel
 * is shared with every other sender in the extension (and, in principle,
 * externally injected junk). Non-matching messages return undefined and the
 * listener ignores them.
 */
export function parseTrackedChangedMessage(
	message: unknown,
): TrackedChangedMessage | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const { kind, url, tracked } = message as Record<string, unknown>;
	if (kind !== TRACKED_CHANGED) return undefined;
	if (typeof url !== "string" || url === "") return undefined;
	if (typeof tracked !== "boolean") return undefined;
	return { kind: TRACKED_CHANGED, url, tracked };
}

// ---------------------------------------------------------------------------
// TTL cache.

export interface TrackedCache {
	/** Fresh entry, or undefined when unknown/expired. */
	get(url: string): TrackedEntry | undefined;
	/** Just `tracked`, shaped for `resolveIconState` (miss → `unknown`). */
	statusFor(url: string): TrackedStatus;
	/**
	 * Store a resolved lookup OR an optimistic override — identical writes,
	 * because a fresh write always wins until it expires. A lookup passes all
	 * three fields; an override passes `{ tracked }` alone, which is what makes
	 * a post-save entry unable to trigger a backfill (SPEC §15.4).
	 */
	set(url: string, entry: TrackedEntry): void;
	/** Forget one URL (next read is a miss). */
	invalidate(url: string): void;
	/** Forget everything. */
	clear(): void;
	/** Entry count including not-yet-swept expired entries (tests/diagnostics). */
	size(): number;
}

/**
 * Entries are swept lazily on read; a bulk sweep runs on write once the map
 * grows past this, so a long-lived worker browsing many URLs stays bounded.
 */
const SWEEP_THRESHOLD = 128;

export function createTrackedCache(opts: {
	ttlMs: number;
	now: () => number;
}): TrackedCache {
	const { ttlMs, now } = opts;
	/** url → { entry, expiresAt } */
	const entries = new Map<string, { entry: TrackedEntry; expiresAt: number }>();

	function read(url: string): TrackedEntry | undefined {
		const held = entries.get(url);
		if (held === undefined) return undefined;
		if (now() >= held.expiresAt) {
			entries.delete(url);
			return undefined;
		}
		return held.entry;
	}

	return {
		get: read,
		statusFor(url) {
			const entry = read(url);
			return entry === undefined
				? { status: "unknown" }
				: { status: "tracked", tracked: entry.tracked };
		},
		set(url, entry) {
			if (entries.size >= SWEEP_THRESHOLD) {
				const at = now();
				for (const [key, held] of entries) {
					if (at >= held.expiresAt) entries.delete(key);
				}
			}
			// A fresh write always wins and restarts the clock — that is what
			// makes optimistic overrides (onCreated, popup pings) truthful
			// ahead of the previous entry's TTL. It REPLACES rather than merges:
			// an override deliberately drops any remembered screenshot state,
			// since a save may have just changed it.
			entries.set(url, { entry, expiresAt: now() + ttlMs });
		},
		invalidate(url) {
			entries.delete(url);
		},
		clear() {
			entries.clear();
		},
		size() {
			return entries.size;
		},
	};
}
