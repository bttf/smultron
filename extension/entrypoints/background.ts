import { captureHighlight, type HighlightCaptureDeps } from "@/src/capture";
import {
	createEntry,
	createHighlightEntry,
	createOutbox,
	type KeyValueStorage,
} from "@/src/outbox";
import {
	createTrackedCache,
	type IconState,
	isTrackableUrl,
	isTrackedBookmark,
	parseTrackedChangedMessage,
	resolveIconState,
	type TrackedBookmark,
} from "@/src/trackedCache";
import {
	chunk,
	flattenTree,
	resolveFolderPath,
	type TreeNode,
} from "@/src/tree";
import {
	CONFIG_KEY,
	DEFAULT_BASE_URL,
	type ExtensionConfig,
	FLUSH_ALARM,
	SYNC_BATCH_LIMIT,
	type SyncBookmark,
} from "@/src/types";

const storage: KeyValueStorage = {
	get: async (key) => (await browser.storage.local.get(key))[key],
	set: async (key, value) => {
		await browser.storage.local.set({ [key]: value });
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
 * Enqueue a single-bookmark `mode:'live'` entry for a node (no flush —
 * callers flush). Shared by the onCreated listener and the highlight
 * capture flow, which enqueues its created bookmark directly instead of
 * relying on onCreated's timing.
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
	await outbox.enqueue(createEntry("live", [bookmark]));
}

/** Live capture: enqueue the 1-bookmark live entry, then flush. */
async function handleCreated(
	node: Browser.bookmarks.BookmarkTreeNode,
): Promise<void> {
	if (node.url === undefined) return; // Folder creation — nothing to sync.
	await enqueueLiveBookmark(node);
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

/** Sizes Chrome asks for on the toolbar; 48 only exists on the default path. */
const GLOW_SIZES = [16, 32] as const;

/** Default (no-glow) icon — also the fallback for every failure path. */
const DEFAULT_ICON_PATH = {
	16: "icon/16.png",
	32: "icon/32.png",
	48: "icon/48.png",
};

/**
 * Rendered icons for BOTH states, cached for the worker's life (re-derived
 * lazily after worker death). `null` = rendering failed in this worker;
 * don't retry it on every tab switch, just use the packaged default icon.
 */
let stateIcons:
	| {
			base: Record<number, ImageData>;
			glow: Record<number, ImageData>;
	  }
	| null
	| undefined;

/**
 * Render both icon states from the base PNGs. The artwork is drawn inset by
 * exactly the outline thickness in BOTH states — the strawberry is the same
 * size tracked or not, and the tracked state's thick gold outline is purely
 * additive (a hard silhouette dilation, not a blur: a ring of gold stamps
 * under the artwork, so there is no washed-out halo and no edge clipping).
 * No glow asset files (SPEC §6).
 */
async function renderStateIcons(): Promise<typeof stateIcons> {
	if (stateIcons !== undefined) return stateIcons;
	try {
		const base: Record<number, ImageData> = {};
		const glow: Record<number, ImageData> = {};
		for (const size of GLOW_SIZES) {
			const response = await fetch(browser.runtime.getURL(`/icon/${size}.png`));
			if (!response.ok)
				throw new Error(`icon ${size} fetch ${response.status}`);
			const bitmap = await createImageBitmap(await response.blob());
			try {
				const outline = Math.max(2, Math.round(size * 0.11));
				const drawn = size - outline * 2;
				const context = (): OffscreenCanvasRenderingContext2D => {
					const ctx = new OffscreenCanvas(size, size).getContext("2d");
					if (ctx === null) throw new Error("no 2d context");
					return ctx;
				};
				const drawArt = (ctx: OffscreenCanvasRenderingContext2D): void => {
					ctx.drawImage(bitmap, outline, outline, drawn, drawn);
				};

				const baseCtx = context();
				drawArt(baseCtx);
				base[size] = baseCtx.getImageData(0, 0, size, size);

				// Gold silhouette of the inset artwork: art shape, gold fill.
				const silhouetteCtx = context();
				drawArt(silhouetteCtx);
				silhouetteCtx.globalCompositeOperation = "source-in";
				silhouetteCtx.fillStyle = "#f5b301";
				silhouetteCtx.fillRect(0, 0, size, size);

				const glowCtx = context();
				const STAMPS = 16;
				for (let i = 0; i < STAMPS; i += 1) {
					const angle = (2 * Math.PI * i) / STAMPS;
					glowCtx.drawImage(
						silhouetteCtx.canvas,
						Math.cos(angle) * outline,
						Math.sin(angle) * outline,
					);
				}
				drawArt(glowCtx);
				glow[size] = glowCtx.getImageData(0, 0, size, size);
			} finally {
				bitmap.close();
			}
		}
		stateIcons = { base, glow };
	} catch {
		// OffscreenCanvas unavailable, fetch failed, decode failed — the icon
		// silently stays the packaged default for this worker's life.
		stateIcons = null;
	}
	return stateIcons;
}

/**
 * `stillCurrent` is re-checked immediately before EACH setIcon: the first
 * glow render of a worker's life awaits fetch + decode, and without the
 * re-check an older refresh could out-paint a newer one that already
 * finished (e.g. glow landing on a page archived mid-render).
 */
async function applyIcon(
	tabId: number,
	state: IconState,
	stillCurrent: () => boolean,
): Promise<void> {
	// BOTH states paint from the rendered set — the base state uses the same
	// inset artwork as the glow state, so toggling tracked-ness only ever
	// adds/removes the outline, never resizes the strawberry.
	const icons = await renderStateIcons();
	if (icons !== null && icons !== undefined) {
		if (!stillCurrent()) return;
		try {
			await browser.action.setIcon({
				tabId,
				imageData: state === "glow" ? icons.glow : icons.base,
			});
			return;
		} catch {
			// Tab gone, or setIcon rejected the data — fall through.
		}
	}
	if (!stillCurrent()) return;
	try {
		await browser.action.setIcon({ tabId, path: DEFAULT_ICON_PATH });
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
 */
async function lookupTracked(
	config: { token: string; baseUrl: string },
	rawUrl: string,
): Promise<boolean | undefined> {
	try {
		const response = await fetch(
			`${config.baseUrl}/api/bookmarks/by-url?url=${encodeURIComponent(rawUrl)}`,
			{ method: "GET", headers: { Authorization: `Bearer ${config.token}` } },
		);
		if (!response.ok) return undefined;
		const body = (await response.json()) as {
			bookmark?: TrackedBookmark | null;
		};
		return isTrackedBookmark(body?.bookmark ?? null);
	} catch {
		return undefined;
	}
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
			const tracked = await lookupTracked(config, url);
			if (tracked === undefined) {
				// Failures are NOT cached: the next event retries.
				await paint(resolveIconState({ status: "error" }));
				return;
			}
			trackedCache.set(url, tracked);
			await paint(resolveIconState({ status: "tracked", tracked }));
		} catch {
			// A listener must never throw; an unpainted icon is just the
			// default one.
		}
	})();
}

export default defineBackground(() => {
	// MV3: all listeners must be registered synchronously at the top level of
	// the service worker so Chrome can re-deliver events after worker death.

	browser.bookmarks.onCreated.addListener((_id, node) => {
		void handleCreated(node);
		// m15: a fresh bookmark is tracked by definition — record it optimistically
		// (ahead of any lookup) and repaint if it is the active tab's page.
		if (node.url !== undefined && isTrackableUrl(node.url)) {
			trackedCache.set(node.url, true);
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
		void reconcile();
	});

	browser.runtime.onStartup.addListener(() => {
		scheduleRetryAlarm();
		void reconcile();
	});

	browser.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === FLUSH_ALARM) void outbox.flush();
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
		trackedCache.set(ping.url, ping.tracked);
		refreshActiveTabIcon({ url: ping.url });
	});

	browser.storage.onChanged.addListener((changes, area) => {
		// Re-pairing (the options page rewrote the config) makes every cached
		// tracked verdict meaningless — different account or server. Drop the
		// cache and repaint from scratch.
		if (area !== "local" || changes[CONFIG_KEY] === undefined) return;
		trackedCache.clear();
		refreshActiveTabIcon();
	});
});
