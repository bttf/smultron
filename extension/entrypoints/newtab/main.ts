// New tab page (m20, SPEC §6): Chrome's new tab, replaced by the pinned shelf
// + recent log + instant search over the user's own bookmarks.
//
// Read-only by construction — one `GET /api/bookmarks` with the pairing token
// (SPEC §8), direct fetch, never the outbox (the user is present; the page
// must be truthful about what it could and couldn't load). Nothing here
// mutates a bookmark, a Chrome bookmark, or sync state.
//
// Paint order matters more here than anywhere else in the extension: a new tab
// that shows a spinner is a broken new tab. The last response is replayed from
// `chrome.storage.local` before any network work, and the fetch replaces it
// when it lands.

import {
	createLatestOnly,
	displayHost,
	displayUrl,
	faviconUrlFor,
	fetchBookmarksPage,
	type NewTabBookmark,
	type NewTabConfig,
	type NewTabPage,
	readSnapshot,
	writeSnapshot,
} from "@/src/newtab";
import { relativeTime } from "@/src/relativeTime";
import {
	CONFIG_KEY,
	DEFAULT_BASE_URL,
	type ExtensionConfig,
	type KeyValueStorage,
} from "@/src/types";

/** `chrome.storage.local` as the injectable shape `src/` speaks. */
const storage: KeyValueStorage = {
	get: async (key) => (await browser.storage.local.get(key))[key],
	set: async (key, value) => {
		await browser.storage.local.set({ [key]: value });
	},
};

/** Rows the log shows; the snapshot may hold more (SPEC §6). */
const LOG_LIMIT = 18;
/** Tag chips per row before the rest are elided. */
const ROW_TAG_LIMIT = 3;
const SEARCH_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// DOM. Bookmark-derived strings ONLY ever go through textContent — titles and
// tags are user data and this page renders them on every new tab.

function mustGet<T extends Element>(selector: string): T {
	const found = document.querySelector<T>(selector);
	if (found === null) throw new Error(`missing element: ${selector}`);
	return found;
}

const brandEl = mustGet<HTMLButtonElement>("#brand");
const metaEl = mustGet<HTMLDivElement>("#meta");
const searchEl = mustGet<HTMLInputElement>("#search");
const shelfEl = mustGet<HTMLElement>("#shelf");
const cardsEl = mustGet<HTMLDivElement>("#cards");
const logLabelEl = mustGet<HTMLDivElement>("#log-label");
const logEl = mustGet<HTMLDivElement>("#log");

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className !== undefined) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** A favicon <img>, or a blank spacer keeping the row's grid aligned. */
function favicon(bookmark: NewTabBookmark, className = "favicon"): HTMLElement {
	const src = faviconUrlFor(bookmark);
	if (src === undefined) return el("span", className);
	const img = el("img", className);
	img.src = src;
	img.alt = "";
	// A dead stored icon shouldn't leave a broken-image glyph in the row.
	img.addEventListener("error", () => {
		img.replaceWith(el("span", className));
	});
	return img;
}

function titleOf(bookmark: NewTabBookmark): string {
	return bookmark.title.trim() === ""
		? displayHost(bookmark.url)
		: bookmark.title;
}

function renderCard(bookmark: NewTabBookmark): HTMLAnchorElement {
	const card = el("a", "card");
	card.href = bookmark.url;
	const host = el("div", "card-host");
	host.append(
		favicon(bookmark),
		el("span", undefined, displayHost(bookmark.url)),
	);
	card.append(host, el("div", "card-title", titleOf(bookmark)));
	return card;
}

function renderRow(bookmark: NewTabBookmark, now: Date): HTMLAnchorElement {
	const row = el("a", "row");
	row.href = bookmark.url;
	const tags = el("div", "row-tags");
	for (const tag of bookmark.tags.slice(0, ROW_TAG_LIMIT)) {
		tags.append(el("span", "tag", tag));
	}
	if (bookmark.tags.length > ROW_TAG_LIMIT) {
		tags.append(el("span", "tag", `+${bookmark.tags.length - ROW_TAG_LIMIT}`));
	}
	row.append(
		favicon(bookmark),
		el("span", "row-title", titleOf(bookmark)),
		el("span", "row-host", displayUrl(bookmark.url)),
		tags,
		el("span", "row-time", relativeTime(bookmark.updatedAt, now)),
	);
	return row;
}

function renderShelf(pinned: NewTabBookmark[]): void {
	shelfEl.classList.toggle("hidden", pinned.length === 0);
	mustGet<HTMLSpanElement>("#pin-count").textContent =
		pinned.length === 0 ? "" : String(pinned.length);
	cardsEl.replaceChildren(...pinned.map(renderCard));
}

/**
 * `label` names what the rows are; `empty` is shown when there are none.
 * The feed trims to `LOG_LIMIT`; search passes `limit: rows.length` because
 * the ranked page replaces the log whole (SPEC §6) — the RESULTS count must
 * never claim rows the page doesn't show.
 */
function renderLog(
	rows: NewTabBookmark[],
	options: { label: string; empty: HTMLElement; limit?: number },
): void {
	logLabelEl.textContent = options.label;
	if (rows.length === 0) {
		logEl.replaceChildren(options.empty);
		return;
	}
	const now = new Date();
	logEl.replaceChildren(
		...rows.slice(0, options.limit ?? LOG_LIMIT).map((b) => renderRow(b, now)),
	);
}

function message(text: string): HTMLElement {
	return el("div", "message", text);
}

function errorLine(text: string): HTMLElement {
	return el("div", "error-line", text);
}

/** The empty state names both capture paths, like the site's (SPEC §9). */
function emptyAccountMessage(): HTMLElement {
	return message(
		"No bookmarks yet — save a page in Chrome, or add one from the site.",
	);
}

function setMeta(text: string, stale = false): void {
	metaEl.textContent = text;
	metaEl.classList.toggle("stale", stale);
}

function renderUnpaired(): void {
	setMeta("");
	shelfEl.classList.add("hidden");
	logLabelEl.textContent = "";
	const line = message("Not paired — open settings to pair this extension.");
	const button = el("button", "btn-accent", "Open settings");
	button.type = "button";
	button.addEventListener("click", () => {
		void browser.runtime.openOptionsPage();
	});
	line.append(button);
	logEl.replaceChildren(line);
}

// ---------------------------------------------------------------------------
// Config.

async function loadConfig(): Promise<NewTabConfig | undefined> {
	let raw: ExtensionConfig | undefined;
	try {
		raw = (await browser.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as
			| ExtensionConfig
			| undefined;
	} catch {
		return undefined;
	}
	if (raw?.token === undefined || raw.token === "") return undefined;
	return {
		token: raw.token,
		baseUrl: (raw.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
	};
}

// ---------------------------------------------------------------------------
// State.

/** The feed page currently on screen — what an emptied search box restores. */
let feedPage: NewTabPage = { pinned: [], recent: [] };
/** False until a fetch succeeds: the rows on screen are the cached ones. */
let live = false;
/** True only after a refresh FAILED with cached rows to keep (SPEC §6). */
let offline = false;
/** Set once the config is known; search is inert until then. */
let activeConfig: NewTabConfig | undefined;

function paintFeed(): void {
	renderShelf(feedPage.pinned);
	renderLog(feedPage.recent, {
		label: "RECENT",
		empty: live ? emptyAccountMessage() : message("…"),
	});
	setMeta(offline ? "offline — showing the last snapshot" : "", offline);
}

// ---------------------------------------------------------------------------
// Search. Latest-wins so a slow earlier response can never overwrite the
// answer to what is being typed now (SPEC §6).

// Tasks RESOLVE TO their paint rather than painting as a side effect — the
// sequencer discards a superseded task's value, so a paint that only happens
// on the resolved value is what makes latest-wins actually bind.
const runSearch = createLatestOnly<(() => void) | undefined>();
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchController: AbortController | undefined;

function scheduleSearch(config: NewTabConfig): void {
	if (searchTimer !== undefined) clearTimeout(searchTimer);
	searchTimer = setTimeout(() => {
		void submitSearch(config);
	}, SEARCH_DEBOUNCE_MS);
}

async function submitSearch(config: NewTabConfig): Promise<void> {
	const q = searchEl.value.trim();
	searchController?.abort();
	if (q === "") {
		searchController = undefined;
		// An emptied box is not a query — restore the feed without a round trip.
		const paint = await runSearch(() => Promise.resolve(() => paintFeed()));
		paint?.();
		return;
	}
	const controller = new AbortController();
	searchController = controller;

	const paint = await runSearch(async () => {
		const result = await fetchBookmarksPage(config, fetch, {
			q,
			signal: controller.signal,
		});
		if (!result.ok) {
			if (result.status === 401) return () => renderUnpaired();
			// An aborted request is a superseded one — nothing to report.
			if (controller.signal.aborted) return undefined;
			return () =>
				renderLog([], {
					label: "RESULTS",
					empty: errorLine(
						result.status === null
							? `search failed: network error: ${result.message}`
							: `search failed: HTTP ${result.status}`,
					),
				});
		}
		return () => {
			// The shelf is query-independent server-side (SPEC §8) — a search
			// refreshes it rather than hiding it.
			renderShelf(result.value.pinned);
			renderLog(result.value.recent, {
				label: `RESULTS ${result.value.recent.length}`,
				empty: message("No matches."),
				limit: result.value.recent.length,
			});
			setMeta("");
		};
	});
	paint?.();
}

// ---------------------------------------------------------------------------
// Entry.

brandEl.addEventListener("click", () => {
	void (async () => {
		const config = await loadConfig();
		window.location.href = config?.baseUrl ?? DEFAULT_BASE_URL;
	})();
});

// `/` focuses the box; the page NEVER autofocuses it. Chrome focuses the
// omnibox on a new tab, and stealing that focus would swallow a URL the user
// is already typing (SPEC §6).
document.addEventListener("keydown", (event) => {
	if (
		event.key === "/" &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.altKey &&
		document.activeElement !== searchEl
	) {
		event.preventDefault();
		searchEl.focus();
	}
});

searchEl.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	event.preventDefault();
	if (searchEl.value === "") {
		searchEl.blur();
		return;
	}
	// Escape clears the box and restores the feed (SPEC §6).
	searchEl.value = "";
	if (searchTimer !== undefined) clearTimeout(searchTimer);
	if (activeConfig !== undefined) void submitSearch(activeConfig);
});

async function init(): Promise<void> {
	renderLog([], { label: "RECENT", empty: message("…") });

	const config = await loadConfig();
	if (config === undefined) {
		renderUnpaired();
		return;
	}
	activeConfig = config;
	searchEl.addEventListener("input", () => {
		scheduleSearch(config);
	});

	// Paint the cache first — this is what makes the tab feel instant.
	const snapshot = await readSnapshot(storage);
	if (snapshot !== undefined) {
		feedPage = { pinned: snapshot.pinned, recent: snapshot.recent };
		paintFeed();
	}

	const result = await fetchBookmarksPage(config, fetch);
	if (!result.ok) {
		if (result.status === 401) {
			renderUnpaired();
			return;
		}
		// A failed refresh keeps the cached rows behind the `offline` mark
		// (SPEC §6); the mark appears only now, never during revalidation.
		offline = snapshot !== undefined;
		// A search typed while the feed was still loading owns the log — the
		// feed's failure must not paint over its results.
		if (searchEl.value.trim() !== "") return;
		if (snapshot === undefined) {
			setMeta("");
			renderLog([], {
				label: "RECENT",
				empty: errorLine(
					result.status === null
						? `couldn't load bookmarks: network error: ${result.message}`
						: `couldn't load bookmarks: HTTP ${result.status}`,
				),
			});
		} else {
			paintFeed();
		}
		return;
	}

	feedPage = result.value;
	live = true;
	// A search typed while the feed was still loading owns the log — don't
	// paint over it (the shelf is query-independent, so it refreshes either way).
	if (searchEl.value.trim() === "") {
		paintFeed();
	} else {
		renderShelf(feedPage.pinned);
	}
	await writeSnapshot(storage, feedPage, Date.now());
}

void init();
