// New tab page (m20, SPEC §6): Chrome's new tab, replaced by the pinned shelf
// + recent log + instant search over the user's own bookmarks.
//
// One `GET /api/bookmarks` with the pairing token (SPEC §8), direct fetch,
// never the outbox (the user is present; the page must be truthful about what
// it could and couldn't load). The page's ONLY write is the m21 shelf reorder
// — one `PUT /api/bookmarks/pinned` per commit, request in `@/src/pinOrder`.
// Nothing here touches a Chrome bookmark or sync state.
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
import { moveItem, putPinnedOrder } from "@/src/pinOrder";
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
	// A drag started on the icon must lift the CARD, not the image (SPEC §6);
	// harmless on log rows, which aren't draggable at all.
	img.draggable = false;
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
	// Shelf cards are the drag handles (m21, SPEC §6); `data-id` is how the
	// delegated handlers below map a DOM node back to its bookmark.
	card.draggable = true;
	card.dataset.id = String(bookmark.id);
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
	// m22: the listing's log includes pinned rows (SPEC §8), so the row says
	// so — an accent `★` immediately before the title, inside the title cell
	// so an unpinned row keeps the grid's alignment. Color-only state.
	const title = el("span", "row-title");
	if (bookmark.pinnedAt !== null) {
		const pin = el("span", "pin", "★");
		pin.title = "Pinned";
		title.append(pin);
	}
	title.append(el("span", undefined, titleOf(bookmark)));
	row.append(
		favicon(bookmark),
		title,
		el("span", "row-host", displayUrl(bookmark.url)),
		tags,
		el("span", "row-time", relativeTime(bookmark.updatedAt, now)),
	);
	return row;
}

// ---------------------------------------------------------------------------
// Shelf reordering (m21, SPEC §6). Native HTML5 drag and drop — no library:
// this page only ever runs in desktop Chrome, where native DnD is dependable.

/** The id of the card being dragged; `undefined` = no shelf drag in progress. */
let dragSourceId: number | undefined;
/** The order to snap back to when a drag ends without a commit. */
let preDragOrder: NewTabBookmark[] | undefined;
/** The live order the grid is reflowing through as the pointer crosses cards. */
let dragOrder: NewTabBookmark[] = [];
/** Set by the grid's `drop`; `dragend` reverts only when it is still false. */
let dragCommitted = false;
/** True while the last reorder's PUT is known to have failed (SPEC §6). */
let orderError = false;
/**
 * Shelf-paint sequence. A reorder commit bumps it (its order is already on
 * screen and is newer than anything in flight); every listing fetch captures
 * it when it STARTS and may paint the shelf only if it is unchanged when the
 * response lands. That is what stops the init fetch racing a fast first drag
 * from repainting the server's pre-reorder shelf — and stops a stale PUT
 * response from overwriting a newer reorder.
 */
let shelfSeq = 0;

/**
 * The order the cards on screen are in. `feedPage.pinned` is what a fetch last
 * delivered; this is what the user sees — they differ only while a drag is
 * running, and during a search (whose shelf is the same rows, SPEC §8).
 */
let shelfOrder: NewTabBookmark[] = [];

/**
 * A shelf paint that arrived while a drag was in progress and was held back.
 * Rebuilding the grid mid-drag would remove the source node, and Chrome ends
 * the drag when that happens — so the paint waits for `dragend`.
 */
let heldShelfPaint: NewTabBookmark[] | undefined;

function renderShelf(pinned: NewTabBookmark[]): void {
	if (dragSourceId !== undefined) {
		heldShelfPaint = pinned;
		return;
	}
	shelfOrder = pinned;
	shelfEl.classList.toggle("hidden", pinned.length === 0);
	mustGet<HTMLSpanElement>("#pin-count").textContent =
		pinned.length === 0 ? "" : String(pinned.length);
	cardsEl.replaceChildren(...pinned.map(renderCard));
}

/**
 * Reorder the EXISTING card nodes into `order` instead of rebuilding them.
 * Mid-drag this is the only legal way to reflow the grid: `replaceChildren`
 * would destroy the dragged node and cancel the gesture. A no-op when the DOM
 * already matches, so calling it on every `dragover` is free.
 */
function applyOrderToDom(order: readonly NewTabBookmark[]): void {
	const nodes = new Map<number, Element>();
	for (const node of Array.from(cardsEl.children)) {
		const id = Number((node as HTMLElement).dataset.id);
		if (Number.isFinite(id)) nodes.set(id, node);
	}
	let slot = 0;
	for (const bookmark of order) {
		const node = nodes.get(bookmark.id);
		if (node === undefined) continue;
		const occupant = cardsEl.children[slot];
		// Slots before `slot` are already final, so `node` can only be sitting
		// later in the list — inserting before the occupant moves it forward.
		if (occupant !== node) cardsEl.insertBefore(node, occupant ?? null);
		slot += 1;
	}
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

/**
 * The meta line carries either the reorder failure or the `offline` mark. A
 * failed reorder is the louder fact, and it stands until the next successful
 * reorder or refresh clears it (SPEC §6).
 */
function paintMeta(): void {
	if (orderError) {
		setMeta("couldn't save order", true);
		return;
	}
	setMeta(offline ? "offline — showing the last snapshot" : "", offline);
}

function paintFeed(): void {
	renderShelf(feedPage.pinned);
	renderLog(feedPage.recent, {
		label: "RECENT",
		empty: live ? emptyAccountMessage() : message("…"),
	});
	paintMeta();
}

// ---------------------------------------------------------------------------
// Drag and drop on the shelf (m21, SPEC §6).
//
// Every handler is delegated to the grid, so a shelf repaint never has to
// rewire anything. Drag events bubble, so a `dragover` over a card runs the
// grid handler first and the document guard afterwards — the grid handler
// therefore STOPS PROPAGATION, and the document's "refuse everything" rule
// applies only to the page outside the grid.

function cardFrom(target: EventTarget | null): HTMLAnchorElement | undefined {
	if (!(target instanceof Element)) return undefined;
	const card = target.closest<HTMLAnchorElement>(".card");
	return card !== null && cardsEl.contains(card) ? card : undefined;
}

function idOf(card: HTMLAnchorElement): number | undefined {
	const id = Number(card.dataset.id);
	return Number.isFinite(id) ? id : undefined;
}

function sameOrder(
	a: readonly NewTabBookmark[],
	b: readonly NewTabBookmark[],
): boolean {
	return a.length === b.length && a.every((row, i) => row.id === b[i]?.id);
}

function clearDragState(): void {
	dragSourceId = undefined;
	preDragOrder = undefined;
	dragOrder = [];
	dragCommitted = false;
}

cardsEl.addEventListener("dragstart", (event) => {
	const card = cardFrom(event.target);
	const id = card === undefined ? undefined : idOf(card);
	if (card === undefined || id === undefined) return;
	dragSourceId = id;
	preDragOrder = shelfOrder;
	dragOrder = shelfOrder;
	dragCommitted = false;
	const data = event.dataTransfer;
	if (data !== null) {
		data.effectAllowed = "move";
		// The payload is the bookmark ID, deliberately NOT the URL (SPEC §6):
		// an anchor pre-seeds the drag with its own link, and a stray drop
		// elsewhere in Chrome must never receive one.
		data.clearData();
		data.setData("text/plain", String(id));
	}
	card.classList.add("dragging");
});

/** Reflow the grid live as the pointer crosses another card (SPEC §6). */
function onGridDragOver(event: DragEvent): void {
	if (dragSourceId === undefined) return;
	// Accept the drop AND keep the document guard below from downgrading it.
	event.preventDefault();
	event.stopPropagation();
	if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
	const card = cardFrom(event.target);
	const targetId = card === undefined ? undefined : idOf(card);
	if (targetId === undefined || targetId === dragSourceId) return;
	const from = dragOrder.findIndex((row) => row.id === dragSourceId);
	const to = dragOrder.findIndex((row) => row.id === targetId);
	if (from < 0 || to < 0) return;
	// Idempotent once the card is in place: `moveItem` then sees from === to.
	dragOrder = moveItem(dragOrder, from, to);
	applyOrderToDom(dragOrder);
}

cardsEl.addEventListener("dragenter", onGridDragOver);
cardsEl.addEventListener("dragover", onGridDragOver);

cardsEl.addEventListener("drop", (event) => {
	if (dragSourceId === undefined) return;
	event.preventDefault();
	event.stopPropagation();
	dragCommitted = true;
	commitOrder();
});

cardsEl.addEventListener("dragend", () => {
	for (const node of Array.from(cardsEl.querySelectorAll(".dragging"))) {
		node.classList.remove("dragging");
	}
	if (dragSourceId === undefined) return;
	if (!dragCommitted && preDragOrder !== undefined) {
		// A drop outside the grid reverts — it never navigates (SPEC §6).
		dragOrder = preDragOrder;
		applyOrderToDom(dragOrder);
	}
	clearDragState();
	if (heldShelfPaint !== undefined) {
		const pending = heldShelfPaint;
		heldShelfPaint = undefined;
		renderShelf(pending);
	}
});

// The page outside the grid: accept the drag so Chrome runs no default of its
// own (dropping a link navigates the tab), but refuse the drop so `dragend`
// reverts. Registered on the document, so it only ever sees what the grid's
// handlers did not stop.
document.addEventListener("dragover", (event) => {
	if (dragSourceId === undefined) return;
	event.preventDefault();
	if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "none";
});
document.addEventListener("drop", (event) => {
	if (dragSourceId === undefined) return;
	event.preventDefault();
});

/**
 * Commit the dragged order: it is already painted (the grid reflowed as the
 * pointer moved), so this is bookkeeping plus ONE PUT (SPEC §6/§8).
 */
function commitOrder(): void {
	const before = preDragOrder ?? shelfOrder;
	const after = dragOrder;
	if (sameOrder(before, after)) return;
	// A commit supersedes any paint held back during the drag.
	heldShelfPaint = undefined;
	shelfOrder = after;
	feedPage = { ...feedPage, pinned: after };
	orderError = false;
	paintMeta();
	// Bumped HERE, at commit time: this order is already on screen, so it is
	// newer than any listing fetch still in flight (SPEC §6).
	shelfSeq += 1;
	void saveOrder(after, before, shelfSeq);
}

async function saveOrder(
	after: NewTabBookmark[],
	before: NewTabBookmark[],
	seq: number,
): Promise<void> {
	const config = activeConfig;
	if (config === undefined) return;
	const result = await putPinnedOrder(
		config,
		fetch,
		after.map((row) => row.id),
	);
	if (result.ok) {
		// A newer reorder already owns the shelf — this response is stale.
		if (shelfSeq !== seq) return;
		feedPage = { ...feedPage, pinned: result.pinned };
		renderShelf(result.pinned);
		orderError = false;
		paintMeta();
		// The snapshot now holds what the server confirmed, so the NEXT new
		// tab paints the new order (still a render cache, SPEC §6).
		await writeSnapshot(storage, feedPage, Date.now());
		return;
	}
	// A revoked token is the truth regardless of what happened since.
	if (result.status === 401) {
		renderUnpaired();
		return;
	}
	if (shelfSeq !== seq) return;
	feedPage = { ...feedPage, pinned: before };
	renderShelf(before);
	orderError = true;
	paintMeta();
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
		const seq = shelfSeq;
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
			// refreshes it rather than hiding it. Unless a reorder committed
			// after this fetch started: that order is the newer one (SPEC §6).
			if (shelfSeq === seq) renderShelf(result.value.pinned);
			renderLog(result.value.recent, {
				label: `RESULTS ${result.value.recent.length}`,
				empty: message("No matches."),
				limit: result.value.recent.length,
			});
			// A landed refresh clears a stale `couldn't save order` (SPEC §6).
			orderError = false;
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

	// Captured BEFORE the request: a reorder committed while it is in flight
	// bumps the sequence, and this response must then leave the shelf alone.
	const listingSeq = shelfSeq;
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

	feedPage = {
		pinned: shelfSeq === listingSeq ? result.value.pinned : feedPage.pinned,
		recent: result.value.recent,
	};
	live = true;
	// A search typed while the feed was still loading owns the log — don't
	// paint over it (the shelf is query-independent, so it refreshes either way).
	if (searchEl.value.trim() === "") {
		paintFeed();
	} else {
		renderShelf(feedPage.pinned);
	}
	// The snapshot holds what the server CONFIRMED (SPEC §6). If a reorder
	// committed while this fetch was out, `feedPage.pinned` is the client's
	// not-yet-confirmed order — the reorder's own success path writes the
	// snapshot once the PUT lands, so skip it here.
	if (shelfSeq === listingSeq) {
		await writeSnapshot(storage, feedPage, Date.now());
	}
}

void init();
