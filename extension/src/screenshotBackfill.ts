/**
 * Opportunistic screenshot backfill (m23, SPEC §15.4).
 *
 * Bookmarks saved before m23 — and any save whose capture failed — have no
 * screenshot. Rather than a crawl, the extension photographs such a page the
 * next time the user happens to load it: when a tracked, screenshot-less page
 * finishes loading in the active tab, one capture is queued behind whatever
 * the outbox already holds.
 *
 * Pure and dependency-injected, no Chrome imports (extension/AGENTS.md); the
 * `tabs.onUpdated` filter, the tracked lookup and the capture itself are wired
 * in `entrypoints/background.ts`.
 *
 * Three rules carry the whole design:
 *
 * - **The m19 toggle gates it, and is checked FIRST.** Backfill is
 *   opportunistic observation of pages the user visits, so it lives under the
 *   attention opt-in (§13). Off — or a storage read that throws — means zero
 *   lookups, zero captures, zero enqueues attributable to backfill, and the
 *   check precedes everything so that stays literally true.
 * - **Uncertainty does nothing.** Only `hasScreenshot === false` triggers. An
 *   optimistic cache override (`onCreated`, a popup ping) stores `{ tracked }`
 *   alone, so the page just saved never backfills itself while that entry is
 *   fresh — the sibling of m15's never-glow-on-uncertainty rule.
 * - **One attempt per bookmark per worker lifetime.** The id joins the
 *   `attempted` set the moment the decision is made — before the settle,
 *   before the capture — so a minimized window, a refused capture or a page
 *   that navigated away all SPEND the attempt instead of retrying on every
 *   reload. The set is in-memory: a worker restart clears it by design, which
 *   is the retry policy.
 */

import { isTrackableUrl, type TrackedEntry } from "./trackedCache";

/**
 * How long to let the page settle after `status: "complete"` before
 * photographing it. `complete` fires at the load event; late layout, web
 * fonts and above-the-fold images routinely land after it, and a screenshot
 * of a half-painted page is worse than none.
 */
export const SCREENSHOT_SETTLE_MS = 1000;

/** The `tabs.onUpdated` facts the handler needs. */
export interface TabCompleteEvent {
	tabId: number;
	url?: string;
	active?: boolean;
}

/** The `chrome.tabs.Tab` fields the post-settle re-check reads. */
export interface TabState {
	url?: string;
	active?: boolean;
	/** `"loading"` | `"complete"` — a navigation started during the settle. */
	status?: string;
}

export interface ScreenshotBackfillDeps {
	/** The m19 `attention` toggle (§13). May reject — that reads as OFF. */
	isCaptureEnabled: () => Promise<boolean>;
	/** Fresh tracked-cache entry for a raw URL, or undefined on a miss. */
	getCached: (url: string) => TrackedEntry | undefined;
	/**
	 * `GET /api/bookmarks/by-url` for a raw URL — the same lookup the m15 icon
	 * performs, and the caller is expected to cache its result. Undefined on
	 * any failure (unpaired, network, non-2xx), which is uncertainty.
	 */
	lookupTracked: (url: string) => Promise<TrackedEntry | undefined>;
	/** Injected so tests drive the settle without timers. */
	sleep: (ms: number) => Promise<void>;
	/** `chrome.tabs.get`; undefined when the tab is gone. */
	getTab: (tabId: number) => Promise<TabState | undefined>;
	/** `captureForUrl` (§15.3) — base64 JPEG, or undefined for no capture. */
	capture: (url: string) => Promise<string | undefined>;
	/** Append the `screenshot` outbox entry behind whatever is queued. */
	enqueue: (url: string, base64: string) => Promise<void>;
	flush: () => Promise<void>;
}

export interface ScreenshotBackfill {
	/** A tab finished loading. Never throws, never rejects. */
	onTabComplete(event: TabCompleteEvent): Promise<void>;
	/** Bookmark ids whose one attempt is spent (tests/diagnostics). */
	attemptedCount(): number;
}

export function createScreenshotBackfill(
	deps: ScreenshotBackfillDeps,
): ScreenshotBackfill {
	/**
	 * In-memory by design (§15.4): the worker's death is the retry. Ids, not
	 * URLs, so a bookmark whose URL was edited (m22) still gets one attempt.
	 */
	const attempted = new Set<string>();

	async function run(event: TabCompleteEvent): Promise<void> {
		// 1. The gate, before anything observable. A throwing read is OFF.
		let enabled: boolean;
		try {
			enabled = await deps.isCaptureEnabled();
		} catch {
			return;
		}
		if (!enabled) return;

		// 2. Only http(s) pages carry a bookmark row, and only an ACTIVE tab is
		//    what `captureVisibleTab` would photograph.
		const url = event.url;
		if (!isTrackableUrl(url)) return;
		if (event.active !== true) return;

		// 3. Cache before network: the icon watcher has usually just looked this
		//    URL up, so the common case costs no extra request.
		let entry = deps.getCached(url);
		if (entry === undefined) entry = await deps.lookupTracked(url);
		if (entry === undefined) return;

		// 4. Attempt only on a definite yes: tracked, definitely screenshot-less,
		//    identifiable, and not already tried in this worker.
		if (entry.tracked !== true) return;
		if (entry.hasScreenshot !== false) return;
		const bookmarkId = entry.bookmarkId;
		if (bookmarkId === undefined) return;
		if (attempted.has(bookmarkId)) return;

		// 5. Spend the attempt HERE — every outcome below consumes it, and this
		//    write is synchronous, so a second `complete` event for the same tab
		//    can never slip past it into a duplicate capture.
		attempted.add(bookmarkId);

		// 6. Let the page finish painting.
		await deps.sleep(SCREENSHOT_SETTLE_MS);

		// 7. Re-verify: during the settle the user may have switched tabs or
		//    navigated on. Capturing then would file another page's pixels under
		//    this bookmark — permanently, since the server keeps the FIRST
		//    screenshot (§15.2). Raw-URL string equality — the extension never
		//    normalizes (hard rule #3).
		//
		//    `status` matters as much as the URL: a navigation that STARTED
		//    inside the settle is reported as the old URL with
		//    `status: "loading"`, and the page under it is already being torn
		//    down. Only a tab that is still complete is worth photographing.
		const tab = await deps.getTab(event.tabId);
		if (tab === undefined) return;
		if (tab.active !== true || tab.url !== url) return;
		if (tab.status !== "complete") return;

		// 8. The §15.3 capture path, then a flush.
		const base64 = await deps.capture(url);
		if (base64 === undefined || base64 === "") return;
		await deps.enqueue(url, base64);
		await deps.flush();
	}

	return {
		onTabComplete: async (event) => {
			try {
				await run(event);
			} catch {
				// A backfill is a nicety: a failed lookup, a rejected capture or a
				// full storage quota must never surface in a tabs listener.
			}
		},
		attemptedCount: () => attempted.size,
	};
}
