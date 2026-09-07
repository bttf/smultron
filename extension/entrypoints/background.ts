import {
	createBrowseBuffer,
	createCaptureSession,
	createEventFactory,
	formatTransition,
	isCaptureEnabled,
	isMainFrameNavigation,
} from "@/src/attention";
import {
	type BaselineTarget,
	createAttentionCapture,
	type TabInfo,
} from "@/src/attentionCapture";
import { captureHighlight, type HighlightCaptureDeps } from "@/src/capture";
import { lookupTabFavicon, type QueryAllTabs } from "@/src/favicon";
import {
	type BlobKeyValueStorage,
	createEntry,
	createHighlightEntry,
	createOutbox,
	type KeyValueStorage,
} from "@/src/outbox";
import {
	base64ByteLength,
	base64ToBytes,
	captureForUrl,
	dataUrlToBase64,
	type EncodedJpeg,
	fitWidth,
	SCREENSHOT_JPEG_QUALITY,
	SCREENSHOT_MAX_WIDTH,
	type ScreenshotCaptureDeps,
} from "@/src/screenshot";
import { createScreenshotBackfill } from "@/src/screenshotBackfill";
import {
	createTrackedCache,
	type IconState,
	isTrackableUrl,
	parseTrackedChangedMessage,
	resolveIconState,
	type TrackedBookmark,
	type TrackedEntry,
	trackedEntryFor,
} from "@/src/trackedCache";
import {
	chunk,
	flattenTree,
	resolveFolderPath,
	type TreeNode,
} from "@/src/tree";
import {
	ATTENTION_KEY,
	BROWSE_DRAIN_ALARM,
	CONFIG_KEY,
	DEFAULT_BASE_URL,
	type ExtensionConfig,
	FLUSH_ALARM,
	type IdleState,
	SYNC_BATCH_LIMIT,
	type SyncBookmark,
} from "@/src/types";

const storage: BlobKeyValueStorage = {
	get: async (key) => (await browser.storage.local.get(key))[key],
	set: async (key, value) => {
		await browser.storage.local.set({ [key]: value });
	},
	// m23: the screenshot blob side-store deletes one key per retired entry
	// (SPEC §15.3) — the outbox is the only caller.
	remove: async (key) => {
		await browser.storage.local.remove(key);
	},
};

/**
 * `chrome.storage.session`: in-memory, survives service-worker death, cleared
 * on browser restart — exactly the `bootId` lifetime SPEC §13 wants. Failures
 * degrade to "no stored session" (a fresh bootId per worker, i.e. extra
 * capture-session boundaries) rather than throwing into a listener.
 */
const sessionStorage: KeyValueStorage = {
	get: async (key) => {
		try {
			return (await browser.storage.session.get(key))[key];
		} catch {
			return undefined;
		}
	},
	set: async (key, value) => {
		try {
			await browser.storage.session.set({ [key]: value });
		} catch {
			// Session storage unavailable — see above.
		}
	},
};

const outbox = createOutbox({
	storage,
	fetchFn: (url, init) => fetch(url, init),
});

/** Fixed context-menu id, re-created idempotently on onInstalled (SPEC §6). */
const HIGHLIGHT_MENU_ID = "smultron-add-highlight";

/** Wraps chrome.bookmarks.get for the parent-chain walk in resolveFolderPath. */
async function getNode(id: string): Promise<TreeNode | undefined> {
	try {
		const [node] = await browser.bookmarks.get(id);
		return node;
	} catch {
		return undefined;
	}
}

/**
 * Every tab, for the live-capture favicon lookup (src/favicon.ts). NOT
 * `query({ url })`: that argument is a match pattern, which drops fragments
 * and treats `*` as a wildcard — the helper matches `tab.url` as a string.
 */
const queryAllTabs: QueryAllTabs = () => browser.tabs.query({});

/**
 * Enqueue a single-bookmark `mode:'live'` entry for a node (no flush —
 * callers flush). Shared by the onCreated listener and the highlight
 * capture flow, which enqueues its created bookmark directly instead of
 * relying on onCreated's timing.
 *
 * Live entries carry the open tab's `favIconUrl` when there is one (SPEC §5):
 * the page's OWN icon, which the server stores in place of the hostname-keyed
 * fallback. A missing tab or a failed query just omits the field.
 */
async function enqueueLiveBookmark(node: TreeNode): Promise<void> {
	if (node.url === undefined) return; // Folder — nothing to sync.
	const bookmark: SyncBookmark = {
		// Raw URL and dateAdded as-is: normalization is server-side only.
		url: node.url,
		title: node.title,
		chromeId: node.id,
	};
	if (node.dateAdded !== undefined) bookmark.dateAddedMs = node.dateAdded;
	const folderPath = await resolveFolderPath(getNode, node.parentId);
	if (folderPath !== undefined) bookmark.folderPath = folderPath;
	const faviconUrl = await lookupTabFavicon(queryAllTabs, node.url);
	if (faviconUrl !== undefined) bookmark.faviconUrl = faviconUrl;
	await outbox.enqueue(createEntry("live", [bookmark]));
}

// ---------------------------------------------------------------------------
// Page screenshots (m23, SPEC §15.3).
//
// Chrome glue only: the tab match, the capture gate and the byte-cap policy
// live in `src/screenshot.ts`, where they are unit-tested.

/**
 * Decode Chrome's capture, downscale it, and hand back base64 + byte length.
 * The ONE piece needing DOM APIs — `createImageBitmap` / `OffscreenCanvas` —
 * so it lives here and is injected into the pure helper, exactly like the m15
 * grey-icon render.
 *
 * A capture already within SCREENSHOT_MAX_WIDTH keeps Chrome's own JPEG bytes
 * (re-encoding would only lose quality) — but not on the reduced-quality
 * retry, whose entire purpose is to produce smaller bytes.
 *
 * The data URL is decoded with the pure helpers rather than `fetch(dataUrl)`:
 * a `data:` fetch inside an MV3 service worker is untested ground here, and a
 * rejection would be swallowed as "no screenshot" on every single capture.
 */
async function downscaleJpeg(
	dataUrl: string,
	quality: number,
): Promise<EncodedJpeg> {
	const source = new Blob([base64ToBytes(dataUrlToBase64(dataUrl))], {
		type: "image/jpeg",
	});
	const bitmap = await createImageBitmap(source);
	try {
		const target = fitWidth(bitmap.width, bitmap.height, SCREENSHOT_MAX_WIDTH);
		if (target.width === bitmap.width && quality >= SCREENSHOT_JPEG_QUALITY) {
			const base64 = dataUrlToBase64(dataUrl);
			return { base64, byteLength: base64ByteLength(base64) };
		}
		const canvas = new OffscreenCanvas(target.width, target.height);
		const ctx = canvas.getContext("2d");
		if (ctx === null) throw new Error("no 2d context");
		ctx.drawImage(bitmap, 0, 0, target.width, target.height);
		const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		return { base64: bytesToBase64(bytes), byteLength: bytes.length };
	} finally {
		bitmap.close();
	}
}

/**
 * Bytes → base64, chunked: `String.fromCharCode(...bytes)` on a megabyte
 * blows the argument limit. `FileReader` is not available in a service
 * worker, so `btoa` over a binary string is the route.
 */
function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

const screenshotDeps: ScreenshotCaptureDeps = {
	// Every tab, matched by exact `tab.url` string — never `query({ url })`,
	// which is a match pattern (src/favicon.ts records why).
	queryAllTabs: () => browser.tabs.query({}),
	captureVisibleTab: (windowId, options) =>
		browser.tabs.captureVisibleTab(windowId, options),
	encodeJpeg: downscaleJpeg,
};

/**
 * Capture the page being bookmarked and queue it BEHIND its sync entry.
 * Total: a failed capture or a full storage quota must never cost the
 * bookmark its sync.
 */
async function captureScreenshot(url: string): Promise<void> {
	try {
		const base64 = await captureForUrl(screenshotDeps, url);
		if (base64 === undefined) return;
		await outbox.enqueueScreenshot(url, base64);
	} catch {
		// Storage rejected the blob (quota) — the bookmark still syncs.
	}
}

/**
 * Live capture: enqueue the 1-bookmark live entry, add the screenshot entry
 * behind it, then flush.
 *
 * Order is the contract (§15.3): FIFO delivery of the sync entry first means
 * the server has the row by the time the upload addresses it by URL — the
 * same argument `/api/highlights` rests on (§5). Only this listener captures;
 * `enqueueLiveBookmark` does not, so the highlight flow's direct enqueue
 * yields one capture, not two. The m19 attention toggle does NOT gate it:
 * saving is an explicit act (§13).
 */
async function handleCreated(
	node: Browser.bookmarks.BookmarkTreeNode,
): Promise<void> {
	if (node.url === undefined) return; // Folder creation — nothing to sync.
	await enqueueLiveBookmark(node);
	await captureScreenshot(node.url);
	await outbox.flush();
}

/**
 * Reconciliation sweep (onInstalled + onStartup): flatten the whole tree,
 * enqueue one `mode:'backfill'` entry per batch of ≤500 bookmarks, flush.
 */
async function reconcile(): Promise<void> {
	const tree = await browser.bookmarks.getTree();
	const bookmarks = flattenTree(tree);
	for (const batch of chunk(bookmarks, SYNC_BATCH_LIMIT)) {
		await outbox.enqueue(createEntry("backfill", batch));
	}
	await outbox.flush();
}

function scheduleRetryAlarm(): void {
	browser.alarms.create(FLUSH_ALARM, { periodInMinutes: 5 });
}

/** m19: the periodic browse-buffer drain (SPEC §13). */
function scheduleDrainAlarm(): void {
	browser.alarms.create(BROWSE_DRAIN_ALARM, { periodInMinutes: 1 });
}

/** Idempotent (removeAll + create) registration of the highlight menu item. */
async function registerHighlightMenu(): Promise<void> {
	await browser.contextMenus.removeAll();
	browser.contextMenus.create({
		id: HIGHLIGHT_MENU_ID,
		title: "🍓 Add highlight in Smultronstället",
		contexts: ["selection"],
	});
}

/** Chrome wiring for the DI-testable highlight capture flow (src/capture.ts). */
const highlightCaptureDeps: HighlightCaptureDeps = {
	searchBookmarks: (url) => browser.bookmarks.search({ url }),
	createBookmark: (details) => browser.bookmarks.create(details),
	enqueueLiveBookmark,
	enqueueHighlight: async (url, text) => {
		await outbox.enqueue(createHighlightEntry(url, text));
	},
	flush: () => outbox.flush(),
};

// ---------------------------------------------------------------------------
// Action-icon tracked state (SPEC §6, m15).
//
// Chrome glue only: every decision (cache freshness, the
// never-glow-on-uncertainty rule, message validation) lives in
// `src/trackedCache.ts`, where it is unit-tested.

/** Per-URL tracked cache; short TTL so a stale glow can't linger. */
const TRACKED_TTL_MS = 30_000;
const trackedCache = createTrackedCache({
	ttlMs: TRACKED_TTL_MS,
	now: Date.now,
});

/** Sizes Chrome asks for on the toolbar; 48 only exists on the color path. */
const GREY_SIZES = [16, 32] as const;

/**
 * The packaged full-color icon — the TRACKED state, and the fallback for
 * every failure path (rare, and equivalent to the pre-m15 toolbar).
 */
const COLOR_ICON_PATH = {
	16: "icon/16.png",
	32: "icon/32.png",
	48: "icon/48.png",
};

/**
 * Grey (untracked) icons, cached for the worker's life (re-derived lazily
 * after worker death). `null` = rendering failed in this worker; don't retry
 * it on every tab switch, just use the packaged color icon.
 */
let greyIcons: Record<number, ImageData> | null | undefined;

/**
 * Render the grey state from the base PNGs at FULL size — the strawberry is
 * always full size; tracked-ness only changes color. Per-pixel luma
 * desaturation (alpha untouched), no filter API dependency, no separate
 * icon-state asset files (SPEC §6).
 */
async function renderGreyIcons(): Promise<Record<number, ImageData> | null> {
	if (greyIcons !== undefined) return greyIcons;
	try {
		const rendered: Record<number, ImageData> = {};
		for (const size of GREY_SIZES) {
			const response = await fetch(browser.runtime.getURL(`/icon/${size}.png`));
			if (!response.ok)
				throw new Error(`icon ${size} fetch ${response.status}`);
			const bitmap = await createImageBitmap(await response.blob());
			try {
				const ctx = new OffscreenCanvas(size, size).getContext("2d");
				if (ctx === null) throw new Error("no 2d context");
				ctx.drawImage(bitmap, 0, 0, size, size);
				const image = ctx.getImageData(0, 0, size, size);
				const px = image.data;
				for (let i = 0; i < px.length; i += 4) {
					// Rec. 601 luma. (?? 0 only satisfies noUncheckedIndexedAccess —
					// i+2 < length by construction.)
					const luma =
						0.299 * (px[i] ?? 0) +
						0.587 * (px[i + 1] ?? 0) +
						0.114 * (px[i + 2] ?? 0);
					px[i] = luma;
					px[i + 1] = luma;
					px[i + 2] = luma;
				}
				rendered[size] = image;
			} finally {
				bitmap.close();
			}
		}
		greyIcons = rendered;
	} catch {
		// OffscreenCanvas unavailable, fetch failed, decode failed — the icon
		// silently stays the packaged color one for this worker's life.
		greyIcons = null;
	}
	return greyIcons;
}

/**
 * `stillCurrent` is re-checked immediately before EACH setIcon: the first
 * grey render of a worker's life awaits fetch + decode, and without the
 * re-check an older refresh could out-paint a newer one that already
 * finished (e.g. grey landing on a page bookmarked mid-render).
 *
 * State mapping: "glow" (definitely tracked — the pure resolver's positive
 * verdict, src/trackedCache.ts) paints the packaged FULL-COLOR icon;
 * everything else paints the grey render.
 */
async function applyIcon(
	tabId: number,
	state: IconState,
	stillCurrent: () => boolean,
): Promise<void> {
	if (state !== "glow") {
		const imageData = await renderGreyIcons();
		if (imageData !== null) {
			if (!stillCurrent()) return;
			try {
				await browser.action.setIcon({ tabId, imageData });
				return;
			} catch {
				// Tab gone, or setIcon rejected the data — fall through.
			}
		}
	}
	if (!stillCurrent()) return;
	try {
		await browser.action.setIcon({ tabId, path: COLOR_ICON_PATH });
	} catch {
		// The tab closed mid-update; nothing to paint and nothing to report.
	}
}

/** The active tab of the last focused window, or undefined. */
async function getActiveTab(): Promise<Browser.tabs.Tab | undefined> {
	try {
		const [tab] = await browser.tabs.query({
			active: true,
			lastFocusedWindow: true,
		});
		return tab;
	} catch {
		return undefined;
	}
}

/** Config is re-read per event — the options page can re-pair at any time. */
async function loadWatcherConfig(): Promise<
	{ token: string; baseUrl: string } | undefined
> {
	try {
		const raw = (await browser.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as
			| ExtensionConfig
			| undefined;
		const token = raw?.token;
		if (token === undefined || token === "") return undefined;
		return {
			token,
			baseUrl: (raw?.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
		};
	} catch {
		return undefined;
	}
}

/**
 * `GET /api/bookmarks/by-url` with the raw URL (hard rule #3 — the server
 * normalizes). Returns undefined on ANY failure so the caller can paint the
 * default icon WITHOUT caching the failure (the next event retries).
 *
 * m23 (§15.4): the row's `id` and screenshot state ride along, so the
 * opportunistic backfill reuses this one request instead of issuing its own.
 */
async function lookupTracked(
	config: { token: string; baseUrl: string },
	rawUrl: string,
): Promise<TrackedEntry | undefined> {
	try {
		const response = await fetch(
			`${config.baseUrl}/api/bookmarks/by-url?url=${encodeURIComponent(rawUrl)}`,
			{ method: "GET", headers: { Authorization: `Bearer ${config.token}` } },
		);
		if (!response.ok) return undefined;
		const body = (await response.json()) as {
			bookmark?: TrackedBookmark | null;
		};
		return trackedEntryFor(body?.bookmark ?? null);
	} catch {
		return undefined;
	}
}

/**
 * Look a raw URL up and cache the result — the shared path for the m15 icon
 * and the m23 backfill, so a page load costs at most ONE by-url request.
 * Undefined when unpaired or the lookup failed; failures are never cached.
 */
async function resolveTracked(
	rawUrl: string,
): Promise<TrackedEntry | undefined> {
	const config = await loadWatcherConfig();
	if (config === undefined) return undefined;
	const entry = await lookupTracked(config, rawUrl);
	if (entry !== undefined) trackedCache.set(rawUrl, entry);
	return entry;
}

/**
 * Monotonic request id: rapid tab switches fire overlapping async lookups, and
 * only the newest one may paint (a slow lookup for the previous tab must never
 * land on the current one).
 */
let paintSeq = 0;

/**
 * Repaint the active tab's icon.
 *
 * `expect` narrows which events are allowed to paint: `tabId` for
 * tab-scoped events (an update in a background tab or unfocused window is
 * dropped), `url` for URL-scoped optimistic updates (onCreated, popup pings).
 */
function refreshActiveTabIcon(
	expect: { tabId?: number; url?: string } = {},
): void {
	const seq = ++paintSeq;
	void (async () => {
		try {
			const tab = await getActiveTab();
			const tabId = tab?.id;
			if (tabId === undefined) return;
			if (expect.tabId !== undefined && expect.tabId !== tabId) return;
			const url = tab?.url;
			if (expect.url !== undefined && expect.url !== url) return;

			const paint = async (state: IconState): Promise<void> => {
				// Superseded while we were awaiting — the newer request owns
				// the icon now. applyIcon re-checks before each setIcon, since
				// the glow render awaits again.
				const stillCurrent = () => seq === paintSeq;
				if (!stillCurrent()) return;
				await applyIcon(tabId, state, stillCurrent);
			};

			if (!isTrackableUrl(url)) {
				await paint(resolveIconState({ status: "unsupported" }));
				return;
			}
			const config = await loadWatcherConfig();
			if (config === undefined) {
				await paint(resolveIconState({ status: "unpaired" }));
				return;
			}
			const cached = trackedCache.statusFor(url);
			if (cached.status === "tracked") {
				await paint(resolveIconState(cached));
				return;
			}
			const entry = await lookupTracked(config, url);
			if (entry === undefined) {
				// Failures are NOT cached: the next event retries.
				await paint(resolveIconState({ status: "error" }));
				return;
			}
			trackedCache.set(url, entry);
			await paint(
				resolveIconState({ status: "tracked", tracked: entry.tracked }),
			);
		} catch {
			// A listener must never throw; an unpainted icon is just the
			// default one.
		}
	})();
}

// ---------------------------------------------------------------------------
// Attention tracking: browse-event capture (SPEC §13, m19).
//
// Chrome glue only: the gate, capture-session boundaries, buffer discipline
// and drain triggers all live in `src/attention.ts` + `src/attentionCapture.ts`,
// where they are unit-tested. Nothing here touches bookmarks (hard rule #1).

const browseBuffer = createBrowseBuffer({
	storage,
	enqueueBrowse: (entries) => outbox.enqueueBrowse(entries),
	uuid: () => crypto.randomUUID(),
});

/** The `attention` toggle; ANY failure reads as disabled — off means off. */
async function attentionEnabled(): Promise<boolean> {
	try {
		return isCaptureEnabled(
			(await browser.storage.local.get(ATTENTION_KEY))[ATTENTION_KEY],
		);
	} catch {
		return false;
	}
}

/** `tabs.get` enrichment; undefined when the tab is gone. */
async function getTabInfo(tabId: number): Promise<TabInfo | undefined> {
	try {
		const tab = await browser.tabs.get(tabId);
		return { tabId: tab.id, url: tab.url, title: tab.title };
	} catch {
		return undefined;
	}
}

/** The active tab of a specific window (window_focus enrichment). */
async function getActiveTabInWindow(
	windowId: number,
): Promise<TabInfo | undefined> {
	try {
		const [tab] = await browser.tabs.query({ active: true, windowId });
		if (tab === undefined) return undefined;
		return { tabId: tab.id, url: tab.url, title: tab.title };
	} catch {
		return undefined;
	}
}

/**
 * Baseline target: the active tab of the LAST-FOCUSED window — undefined
 * (baseline skipped, §13) when no Chrome window currently has focus.
 */
async function getBaselineTarget(): Promise<BaselineTarget | undefined> {
	try {
		const lastFocused = await browser.windows.getLastFocused();
		const windowId = lastFocused.id;
		if (lastFocused.focused !== true || windowId === undefined)
			return undefined;
		const tab = await getActiveTabInWindow(windowId);
		if (tab?.tabId === undefined) return undefined;
		const target: BaselineTarget = { tabId: tab.tabId, windowId };
		if (tab.url !== undefined) target.url = tab.url;
		if (tab.title !== undefined) target.title = tab.title;
		return target;
	} catch {
		return undefined;
	}
}

const attention = createAttentionCapture({
	buffer: browseBuffer,
	session: createCaptureSession({
		sessionStorage,
		uuid: () => crypto.randomUUID(),
	}),
	events: createEventFactory({
		uuid: () => crypto.randomUUID(),
		now: Date.now,
	}),
	isEnabled: attentionEnabled,
	getBaselineTarget,
	getTab: getTabInfo,
	getActiveTabInWindow,
	flush: () => outbox.flush(),
});

/** A capture listener must never throw or block Chrome's dispatch. */
function capture(work: Promise<void>): void {
	void work.catch(() => {});
}

/** The shape both webNavigation events provide (main-frame commits, §13). */
interface NavDetails {
	frameId: number;
	frameType?: string;
	tabId: number;
	url: string;
	timeStamp: number;
	transitionType?: string;
	transitionQualifiers?: string[];
	documentLifecycle?: string;
}

function handleNavigation(details: NavDetails): void {
	// Main frame only (subframe commits aren't the user's attention target) —
	// by frameType, since prerendered main frames have a nonzero frameId (§13).
	if (!isMainFrameNavigation(details)) return;
	capture(
		attention.recordNav({
			tabId: details.tabId,
			// Raw URL (hard rule #3) and the event's OWN timestamp (§13).
			url: details.url,
			occurredAtMs: details.timeStamp,
			transition: formatTransition(
				details.transitionType,
				details.transitionQualifiers,
			),
			// Verbatim when present: prerendered commits are captured WITH the
			// flag, never dropped (§13).
			documentLifecycle: details.documentLifecycle,
		}),
	);
}

// ---------------------------------------------------------------------------
// Opportunistic screenshot backfill (m23, SPEC §15.4).
//
// Chrome glue only: the gate order, the one-attempt rule and the settle
// re-check live in `src/screenshotBackfill.ts`, where they are unit-tested.

const screenshotBackfill = createScreenshotBackfill({
	// The m19 toggle — the same read the browse-event listeners gate on, so a
	// storage failure reads as OFF here too (SPEC §13).
	isCaptureEnabled: attentionEnabled,
	getCached: (url) => trackedCache.get(url),
	lookupTracked: resolveTracked,
	sleep: (ms) =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		}),
	getTab: async (tabId) => {
		try {
			const tab = await browser.tabs.get(tabId);
			return { url: tab.url, active: tab.active };
		} catch {
			return undefined; // Tab closed during the settle.
		}
	},
	capture: (url) => captureForUrl(screenshotDeps, url),
	enqueue: (url, base64) => outbox.enqueueScreenshot(url, base64),
	flush: () => outbox.flush(),
});

export default defineBackground(() => {
	// MV3: all listeners must be registered synchronously at the top level of
	// the service worker so Chrome can re-deliver events after worker death.

	browser.bookmarks.onCreated.addListener((_id, node) => {
		void handleCreated(node);
		// m15: a fresh bookmark is tracked by definition — record it optimistically
		// (ahead of any lookup) and repaint if it is the active tab's page.
		// `{ tracked }` alone — the optimistic override deliberately says nothing
		// about the screenshot, so the m23 backfill can't fire for a page whose
		// save-time capture is still in the outbox (SPEC §15.4).
		if (node.url !== undefined && isTrackableUrl(node.url)) {
			trackedCache.set(node.url, { tracked: true });
			refreshActiveTabIcon({ url: node.url });
		}
	});

	// onChanged / onMoved / onRemoved are intentionally NOT listened to
	// (SPEC §5): Chrome is the source of truth via inserts only; edits and
	// deletes after insert are owned by the site.

	browser.contextMenus.onClicked.addListener((info, tab) => {
		if (info.menuItemId !== HIGHLIGHT_MENU_ID) return;
		void captureHighlight(highlightCaptureDeps, {
			selectionText: info.selectionText,
			pageUrl: info.pageUrl,
			tabTitle: tab?.title,
		});
	});

	browser.runtime.onInstalled.addListener(() => {
		void registerHighlightMenu();
		scheduleRetryAlarm();
		scheduleDrainAlarm();
		void reconcile();
		// Toggle on: treat like a startup (mint a bootId only if absent, §13).
		capture(attention.start());
	});

	browser.runtime.onStartup.addListener(() => {
		scheduleRetryAlarm();
		scheduleDrainAlarm();
		void reconcile();
		// storage.session is empty at browser startup, so this mints a fresh
		// capture session (capture_start + baseline) when the toggle is on.
		capture(attention.start());
	});

	browser.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === FLUSH_ALARM) void outbox.flush();
		if (alarm.name === BROWSE_DRAIN_ALARM) capture(attention.drainAndFlush());
	});

	// --- m15 action-icon watcher (SPEC §6) --------------------------------

	browser.tabs.onActivated.addListener((info) => {
		refreshActiveTabIcon({ tabId: info.tabId });
	});

	browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
		// Only changes that can flip tracked state: a new URL, or the load
		// completing (the URL is often only final by then).
		if (changeInfo.url === undefined && changeInfo.status !== "complete")
			return;
		// Background tabs never repaint; `expect.tabId` additionally drops
		// updates from the active tab of a window that isn't focused.
		if (tab.active !== true) return;
		refreshActiveTabIcon({ tabId });
		// m23 (§15.4): a FINISHED load in the active tab is the only backfill
		// trigger — nothing else photographs a page the user didn't just load.
		if (changeInfo.status !== "complete") return;
		void screenshotBackfill.onTabComplete({
			tabId,
			url: tab.url,
			active: tab.active,
			windowId: tab.windowId,
		});
	});

	browser.windows.onFocusChanged.addListener((windowId) => {
		// Focus left every browser window — whatever is painted stays.
		if (windowId === browser.windows.WINDOW_ID_NONE) return;
		refreshActiveTabIcon();
	});

	// Popup ping after archive / restore / pin-unarchive / CTA create: an
	// optimistic override that beats the TTL. Anything that isn't the ping is
	// ignored, and the channel is never held open (no `return true`).
	browser.runtime.onMessage.addListener((message) => {
		const ping = parseTrackedChangedMessage(message);
		if (ping === undefined) return;
		// An override: `{ tracked }` only (see onCreated above).
		trackedCache.set(ping.url, { tracked: ping.tracked });
		refreshActiveTabIcon({ url: ping.url });
	});

	browser.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;

		// m19: the opt-in toggle flipped — capture_start + baseline on enable,
		// capture_stop on disable, then a drain so the edge ships promptly.
		const attentionChange = changes[ATTENTION_KEY];
		if (attentionChange !== undefined) {
			capture(
				attention.handleToggleChange(
					attentionChange.oldValue,
					attentionChange.newValue,
				),
			);
		}

		// Re-pairing (the options page rewrote the config) makes every cached
		// tracked verdict meaningless — different account or server. Drop the
		// cache and repaint from scratch.
		if (changes[CONFIG_KEY] === undefined) return;
		trackedCache.clear();
		refreshActiveTabIcon();
	});

	// --- m19 browse-event capture (SPEC §13) ------------------------------
	//
	// Registered unconditionally (MV3 needs synchronous top-level listeners);
	// each handler gates on the toggle INSIDE, so off = zero capture.

	browser.webNavigation.onCommitted.addListener(handleNavigation);
	// SPA navigations (YouTube, Twitter) only surface here.
	browser.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);

	browser.tabs.onActivated.addListener((info) => {
		capture(
			attention.recordTabActivated({
				tabId: info.tabId,
				windowId: info.windowId,
			}),
		);
	});

	browser.windows.onFocusChanged.addListener((windowId) => {
		if (windowId === browser.windows.WINDOW_ID_NONE) {
			// Focus left Chrome entirely — dwell stops here.
			capture(attention.recordWindowBlur());
			return;
		}
		capture(attention.recordWindowFocus(windowId));
	});

	browser.idle.onStateChanged.addListener((state) => {
		capture(attention.recordIdle(state as IdleState));
	});

	// 60s is the floor for retroactive idle thresholds (§13).
	try {
		browser.idle.setDetectionInterval(60);
	} catch {
		// Nothing to do: the default 60s interval already applies.
	}
});
