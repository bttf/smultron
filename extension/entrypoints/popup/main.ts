// Browser-action popup: look up the active tab's bookmark via
// GET /api/bookmarks/by-url, edit title/tags/note locally, save with one
// PATCH, archive/restore, or create the bookmark from the "Bookmark this
// page" CTA (default folder — the background's onCreated listener live-syncs
// it). Opening the popup mutates NOTHING — no Chrome bookmark, no DB row;
// every write is user-initiated. All popup traffic is DIRECT fetch with
// truthful user-visible outcomes — never the outbox.

import { isCaptureEnabled } from "@/src/browseEvents";
import { createCoalescedSender } from "@/src/coalesce";
import { relativeTime } from "@/src/relativeTime";
import {
	isInFlight,
	readSnapshotState,
	readStoredMarkdown,
	SNAPSHOT_MARKDOWN_KEY,
	SNAPSHOT_STATE_KEY,
	type SnapshotState,
	snapshotStartMessage,
} from "@/src/snapshot";
import {
	describeFailure,
	getSnapshotMarkdown,
	listRecentSnapshots,
	type SnapshotSummary,
	snapshotPageUrl,
} from "@/src/snapshotApi";
import { filterTagSuggestions } from "@/src/tagSuggestions";
import { trackedChangedMessage } from "@/src/trackedCache";
import {
	CAPTURE_TOGGLE_KEY,
	CONFIG_KEY,
	DEFAULT_BASE_URL,
	type ExtensionConfig,
} from "@/src/types";

/** Bookmark shape returned by the by-url endpoints (m10 server contract). */
interface BookmarkDto {
	id: string;
	url: string;
	urlNormalized: string;
	title: string;
	tags: string[];
	note: string | null;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
	/** m13: null = not pinned to the feed's shelf. */
	pinnedAt: string | null;
}

interface PopupConfig {
	token: string;
	baseUrl: string;
}

type ApiResult<T> =
	| { ok: true; value: T }
	| { ok: false; status: number }
	| { ok: false; status: null; message: string };

const SYNC_POLL_INTERVAL_MS = 800;
const SYNC_POLL_TIMEOUT_MS = 12_000;
const SAVED_FLASH_MS = 1_600;
/** Listbox id + option-id prefix for the m14 tag-suggestion combobox. */
const SUGGESTIONS_ID = "tag-suggestions";

// ---------------------------------------------------------------------------
// DOM helpers — user/tab-derived strings only ever go through textContent.

function mustGet<T extends Element>(selector: string): T {
	const found = document.querySelector<T>(selector);
	if (found === null) throw new Error(`missing element: ${selector}`);
	return found;
}

const brandEl = mustGet<HTMLButtonElement>("#brand");
const statusEl = mustGet<HTMLSpanElement>("#status");
const statusLabelEl = mustGet<HTMLSpanElement>("#status-label");
const viewEl = mustGet<HTMLDivElement>("#view");

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

function render(...nodes: HTMLElement[]): void {
	viewEl.replaceChildren(...nodes);
}

type HeaderStatus =
	| "loading"
	| "none"
	| "not-bookmarked"
	| "bookmarked"
	| "archived"
	| "syncing";

function setHeaderStatus(status: HeaderStatus): void {
	statusEl.classList.remove("bookmarked", "archived", "hidden");
	switch (status) {
		case "loading":
			statusLabelEl.textContent = "…";
			break;
		case "none":
			statusEl.classList.add("hidden");
			break;
		case "not-bookmarked":
			statusLabelEl.textContent = "Not bookmarked";
			break;
		case "bookmarked":
			statusEl.classList.add("bookmarked");
			statusLabelEl.textContent = "Bookmarked";
			break;
		case "archived":
			statusEl.classList.add("archived");
			statusLabelEl.textContent = "Archived";
			break;
		case "syncing":
			statusLabelEl.textContent = "syncing…";
			break;
	}
}

/** Favicon + editable-or-static title + ellipsized host+path line. */
function pageRow(
	tabUrl: URL,
	title: string,
	options: { editable: boolean },
): { row: HTMLDivElement; titleInput?: HTMLInputElement } {
	const row = el("div", "page-row");
	const favicon = el("img", "favicon");
	favicon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(tabUrl.hostname)}&sz=32`;
	favicon.alt = "";
	row.append(favicon);

	const col = el("div", "page-col");
	let titleInput: HTMLInputElement | undefined;
	if (options.editable) {
		titleInput = el("input", "title-input");
		titleInput.type = "text";
		titleInput.value = title;
		titleInput.spellcheck = false;
		col.append(titleInput);
	} else {
		col.append(el("div", "page-title", title));
	}
	const path = tabUrl.pathname === "/" ? "" : tabUrl.pathname;
	col.append(el("div", "page-url", `${tabUrl.host}${path}`));
	row.append(col);
	return { row, titleInput };
}

// ---------------------------------------------------------------------------
// Config + API.

async function loadPopupConfig(): Promise<PopupConfig | undefined> {
	const raw = (await browser.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as
		| ExtensionConfig
		| undefined;
	if (raw?.token === undefined || raw.token === "") return undefined;
	return {
		token: raw.token,
		baseUrl: (raw.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
	};
}

async function apiFetch<T>(
	config: PopupConfig,
	path: string,
	init: RequestInit,
	parse: (body: unknown) => T,
): Promise<ApiResult<T>> {
	try {
		const response = await fetch(`${config.baseUrl}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${config.token}`,
				...init.headers,
			},
		});
		if (!response.ok) return { ok: false, status: response.status };
		return { ok: true, value: parse(await response.json()) };
	} catch (error) {
		return {
			ok: false,
			status: null,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

function getBookmarkByUrl(
	config: PopupConfig,
	rawUrl: string,
): Promise<ApiResult<BookmarkDto | null>> {
	return apiFetch(
		config,
		`/api/bookmarks/by-url?url=${encodeURIComponent(rawUrl)}`,
		{ method: "GET" },
		(body) => (body as { bookmark: BookmarkDto | null }).bookmark ?? null,
	);
}

function patchBookmarkByUrl(
	config: PopupConfig,
	body: {
		url: string;
		title?: string;
		tags?: string[];
		note?: string;
		archived?: boolean;
		pinned?: boolean;
	},
): Promise<ApiResult<BookmarkDto>> {
	return apiFetch(
		config,
		"/api/bookmarks/by-url",
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		// Contract says "200 updated bookmark"; tolerate both the bare object
		// and a { bookmark } wrapper matching the GET shape.
		(parsed) =>
			(parsed as { bookmark?: BookmarkDto }).bookmark ??
			(parsed as BookmarkDto),
	);
}

/** m14: the caller's distinct tags, ordered count desc / tag asc (SPEC §8). */
function getTags(config: PopupConfig): Promise<ApiResult<string[]>> {
	return apiFetch(
		config,
		"/api/tags",
		{ method: "GET" },
		(body) => (body as { tags: string[] }).tags ?? [],
	);
}

/**
 * m15: tell the background the page's tracked state changed, so the toolbar
 * icon's glow is truthful ahead of the cache TTL (SPEC §6). Fire-and-forget:
 * with no listener (worker asleep mid-teardown) sendMessage REJECTS, and the
 * popup must neither block nor change behavior because of it.
 */
function pingTrackedChanged(rawUrl: string, tracked: boolean): void {
	void browser.runtime
		.sendMessage(trackedChangedMessage(rawUrl, tracked))
		.catch(() => {});
}

function failureText(result: {
	status: number | null;
	message?: string;
}): string {
	return result.status === null
		? `network error: ${result.message ?? "unreachable"}`
		: `HTTP ${result.status}`;
}

// ---------------------------------------------------------------------------
// Views.

function renderLoading(): void {
	setHeaderStatus("loading");
	render(el("div", "message", "…"));
}

function renderUnsupported(): void {
	setHeaderStatus("none");
	render(el("div", "message", "Nothing to bookmark here."));
}

function renderUnpaired(): void {
	setHeaderStatus("none");
	// The browsing-history section belongs to PAIRED states only — a 401 mid-session
	// (revoked token) lands here with the section already mounted (SPEC §13).
	hideHistoryToggle();
	// So does the snapshot section (m25, §17.7).
	hideSnapshots();
	const message = el("div", "message", "Not paired — open settings to pair.");
	const button = el("button", "btn-accent", "Open settings");
	button.type = "button";
	button.addEventListener("click", () => {
		void browser.runtime.openOptionsPage();
	});
	const actions = el("div", "footer-actions");
	actions.append(button);
	render(message, actions);
}

function renderError(text: string): void {
	setHeaderStatus("none");
	render(el("div", "error-line", text));
}

/**
 * Create the Chrome bookmark and wait for live sync to land server-side.
 * Returns the synced bookmark, or a user-facing failure message. The caller
 * decides what to render around it.
 */
async function createAndWaitForSync(
	config: PopupConfig,
	tabUrl: URL,
	tabTitle: string,
): Promise<
	{ ok: true; bookmark: BookmarkDto } | { ok: false; message: string }
> {
	try {
		// A Chrome bookmark may already exist even though the server row
		// hasn't landed (sync lagging, or a retry after a poll timeout) —
		// skip the create and just poll, so repeat CTA clicks and popup
		// reopens never mint duplicate Chrome rows. A URL-variant miss here
		// is acceptable: the server dedupes by normalized URL (same rule as
		// highlight capture, SPEC §6).
		const existing = await browser.bookmarks.search({ url: tabUrl.href });
		if (existing.length === 0) {
			// Default folder (no parentId): the background onCreated listener
			// live-syncs this creation, which correctly bumps updated_at.
			await browser.bookmarks.create({
				title: tabTitle,
				url: tabUrl.href,
			});
		}
	} catch (error) {
		return {
			ok: false,
			message: `couldn't create bookmark: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	// Poll until live sync lands, then swap to the editing card.
	const deadline = Date.now() + SYNC_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_INTERVAL_MS));
		const result = await getBookmarkByUrl(config, tabUrl.href);
		if (result.ok && result.value !== null) {
			return { ok: true, bookmark: result.value };
		}
	}
	return {
		ok: false,
		message: "sync hasn't caught up — reopen the popup in a moment.",
	};
}

/**
 * Not-bookmarked view: page row + the CTA that creates the bookmark. The
 * create only ever runs on click — opening the popup mutates nothing. On
 * failure the CTA stays put with the message so the click can be retried.
 */
function renderNotBookmarked(
	config: PopupConfig,
	tabUrl: URL,
	tabTitle: string,
): void {
	setHeaderStatus("not-bookmarked");
	const { row } = pageRow(tabUrl, tabTitle, { editable: false });
	const button = el("button", "btn-accent", "Bookmark this page");
	button.type = "button";
	const errorLine = el("div", "error-line hidden");
	const actions = el("div", "footer-actions");
	actions.append(button);

	button.addEventListener("click", () => {
		void (async () => {
			button.disabled = true;
			errorLine.classList.add("hidden");
			setHeaderStatus("syncing");
			const result = await createAndWaitForSync(config, tabUrl, tabTitle);
			if (result.ok) {
				pingTrackedChanged(tabUrl.href, true);
				renderEditor(config, tabUrl, result.bookmark);
				return;
			}
			setHeaderStatus("not-bookmarked");
			button.disabled = false;
			errorLine.textContent = result.message;
			errorLine.classList.remove("hidden");
		})();
	});

	render(row, actions, errorLine);
}

function renderEditor(
	config: PopupConfig,
	tabUrl: URL,
	bookmark: BookmarkDto,
): void {
	const archived = bookmark.archivedAt !== null;
	setHeaderStatus(archived ? "archived" : "bookmarked");

	// Title and note edits accumulate locally; Save sends one PATCH.
	const tags = [...bookmark.tags];

	// m15: tag mutations are a state toggle like pin/archive — each one PATCHes
	// the full array immediately (PATCH by-url never bumps updated_at). Sends
	// coalesce: ≤1 in flight, a mutation mid-flight becomes one trailing send
	// carrying the latest array. On failure the local chips stand and Save —
	// which still sends `tags` — is the retry path (SPEC §6).
	let tagErrorText: string | undefined;
	const saveTags = createCoalescedSender<string[]>(async (next) => {
		const result = await patchBookmarkByUrl(config, {
			url: tabUrl.href,
			tags: next,
		});
		if (!result.ok) {
			tagErrorText = `tag save failed: ${failureText(result)} — use Save to retry`;
			showError(tagErrorText);
			return false;
		}
		if (tagErrorText !== undefined) {
			// Retract our own message only; Save/Archive/Pin own the line
			// whenever theirs is the one on screen.
			if (errorLine.textContent === tagErrorText) {
				errorLine.classList.add("hidden");
			}
			tagErrorText = undefined;
		}
		return true;
	});

	/** Every tag mutation: repaint at once (the feedback), then push the state. */
	function commitTags(): void {
		renderChips();
		saveTags([...tags]);
	}

	const { row, titleInput } = pageRow(tabUrl, bookmark.title, {
		editable: true,
	});

	// TAGS block.
	const tagsBlock = el("div", "block");
	tagsBlock.append(el("div", "block-label", "TAGS"));
	// Relative wrapper so the suggestion dropdown overlays the NOTE block
	// instead of pushing it down.
	const tagField = el("div", "tag-field");
	const chips = el("div", "chips");
	const tagInput = el("input", "tag-input");
	tagInput.type = "text";
	tagInput.placeholder = "add tag ⏎";
	tagInput.spellcheck = false;
	tagInput.setAttribute("role", "combobox");
	tagInput.setAttribute("aria-autocomplete", "list");
	tagInput.setAttribute("aria-expanded", "false");
	tagInput.setAttribute("aria-controls", SUGGESTIONS_ID);
	const suggestionList = el("div", "suggestions hidden");
	suggestionList.id = SUGGESTIONS_ID;
	suggestionList.setAttribute("role", "listbox");

	// m14 autocomplete source: ONE direct GET /api/tags per card render,
	// non-blocking — the card never waits on it, and on failure suggestions
	// are silently absent (SPEC §6).
	let availableTags: string[] = [];
	void getTags(config).then((result) => {
		if (!result.ok) return;
		availableTags = result.value;
		// The user may already be typing when the list lands — only then does
		// a late arrival open the dropdown.
		if (document.activeElement === tagInput) refreshSuggestions();
	});

	// Dropdown state: `suggestions` non-empty ⇔ the dropdown is open.
	let suggestions: string[] = [];
	let highlighted = -1;

	function renderChips(): void {
		const nodes: HTMLElement[] = tags.map((tag, index) => {
			const chip = el("span", "chip");
			chip.append(el("span", undefined, tag));
			const remove = el("button", "chip-remove", "✕");
			remove.type = "button";
			remove.addEventListener("click", () => {
				tags.splice(index, 1);
				commitTags();
			});
			chip.append(remove);
			return chip;
		});
		chips.replaceChildren(...nodes, tagInput);
	}

	function closeSuggestions(): void {
		suggestions = [];
		highlighted = -1;
		suggestionList.replaceChildren();
		suggestionList.classList.add("hidden");
		tagInput.setAttribute("aria-expanded", "false");
		tagInput.removeAttribute("aria-activedescendant");
	}

	function paintHighlight(): void {
		const options = Array.from(suggestionList.children);
		options.forEach((option, index) => {
			const active = index === highlighted;
			option.classList.toggle("active", active);
			option.setAttribute("aria-selected", active ? "true" : "false");
		});
		const active = highlighted === -1 ? undefined : options[highlighted];
		if (active === undefined) tagInput.removeAttribute("aria-activedescendant");
		else tagInput.setAttribute("aria-activedescendant", active.id);
	}

	/**
	 * Recompute from the live draft and the local `tags` array (so a tag just
	 * added disappears from the list); open only with ≥1 match, highlight reset.
	 */
	function refreshSuggestions(): void {
		suggestions = filterTagSuggestions(availableTags, tags, tagInput.value);
		if (suggestions.length === 0) {
			closeSuggestions();
			return;
		}
		highlighted = -1;
		suggestionList.replaceChildren(
			...suggestions.map((tag, index) => {
				const option = el("div", "suggestion", tag);
				option.id = `${SUGGESTIONS_ID}-${index}`;
				option.setAttribute("role", "option");
				option.setAttribute("aria-selected", "false");
				// Commit on pointerdown/mousedown, before the input blurs;
				// preventDefault keeps focus (and suppresses the compat
				// mousedown for pointer-aware browsers). `addTag` is
				// idempotent, so a duplicate compat event is harmless.
				const commit = (event: Event): void => {
					event.preventDefault();
					addTag(tag);
				};
				option.addEventListener("pointerdown", commit);
				option.addEventListener("mousedown", commit);
				return option;
			}),
		);
		suggestionList.classList.remove("hidden");
		tagInput.setAttribute("aria-expanded", "true");
		paintHighlight();
	}

	/** Single add path: draft cleared, dropdown closed, focus back in input. */
	function addTag(raw: string): void {
		const tag = raw.trim();
		tagInput.value = "";
		closeSuggestions();
		if (tag !== "" && !tags.includes(tag)) {
			tags.push(tag);
			commitTags();
		}
		tagInput.focus();
	}

	tagInput.addEventListener("input", () => {
		refreshSuggestions();
	});
	tagInput.addEventListener("blur", () => {
		closeSuggestions();
	});

	tagInput.addEventListener("keydown", (event) => {
		const open = suggestions.length > 0;
		if (open && event.key === "ArrowDown") {
			// From no highlight → first; wraps.
			event.preventDefault();
			highlighted = (highlighted + 1) % suggestions.length;
			paintHighlight();
		} else if (open && event.key === "ArrowUp") {
			// From no highlight → last; wraps.
			event.preventDefault();
			highlighted = highlighted <= 0 ? suggestions.length - 1 : highlighted - 1;
			paintHighlight();
		} else if (open && event.key === "Escape") {
			// Closes the dropdown only, keeping the draft; with no dropdown
			// open Escape keeps its default popup behavior.
			event.preventDefault();
			event.stopPropagation();
			closeSuggestions();
		} else if (event.key === "Enter") {
			event.preventDefault();
			const picked = highlighted === -1 ? undefined : suggestions[highlighted];
			addTag(picked ?? tagInput.value);
		} else if (event.key === "Backspace" && tagInput.value === "") {
			if (tags.length > 0) {
				tags.pop();
				commitTags();
				tagInput.focus();
			}
		}
	});

	renderChips();
	tagField.append(chips, suggestionList);
	tagsBlock.append(tagField);

	// NOTE block.
	const noteBlock = el("div", "block");
	noteBlock.append(el("div", "block-label", "NOTE"));
	const noteInput = el("textarea", "note-input");
	noteInput.rows = 4;
	noteInput.placeholder = "Why did you save this?";
	noteInput.value = bookmark.note ?? "";
	noteBlock.append(noteInput);

	// Footer.
	const footer = el("div", "footer");
	footer.append(
		el("div", "saved-line", `saved ${relativeTime(bookmark.createdAt)}`),
	);
	const actions = el("div", "footer-actions");
	// m13 pin toggle. Like Archive, it PATCHes immediately (a state toggle,
	// not a content edit) — the mock's ★ Pin / ★ Pinned button.
	let pinned = bookmark.pinnedAt !== null;
	const pinButton = el("button", "btn-pin");
	pinButton.type = "button";
	function paintPinButton(): void {
		pinButton.classList.toggle("pinned", pinned);
		pinButton.textContent = pinned ? "★ Pinned" : "★ Pin";
	}
	paintPinButton();
	const archiveButton = el(
		"button",
		"btn-secondary",
		archived ? "Restore" : "Archive",
	);
	archiveButton.type = "button";
	const saveButton = el("button", "btn-accent", "Save");
	saveButton.type = "button";
	actions.append(pinButton, archiveButton, saveButton);
	footer.append(actions);

	const errorLine = el("div", "error-line hidden");

	function showError(text: string): void {
		errorLine.textContent = text;
		errorLine.classList.remove("hidden");
	}

	function setBusy(busy: boolean): void {
		saveButton.disabled = busy;
		archiveButton.disabled = busy;
		pinButton.disabled = busy;
		// m15: tag mutations PATCH on their own coalesced channel, so they
		// must be locked out while Save/Archive/Pin are in flight — otherwise
		// a tag send issued mid-flight can land first and the older full
		// PATCH overwrites it with a stale array under "Saved ✓".
		tagInput.disabled = busy;
		for (const remove of chips.querySelectorAll<HTMLButtonElement>("button")) {
			remove.disabled = busy;
		}
	}

	pinButton.addEventListener("click", () => {
		void (async () => {
			setBusy(true);
			errorLine.classList.add("hidden");
			const result = await patchBookmarkByUrl(config, {
				url: tabUrl.href,
				pinned: !pinned,
			});
			if (!result.ok) {
				setBusy(false);
				showError(`${pinned ? "unpin" : "pin"} failed: ${failureText(result)}`);
				return;
			}
			if (archived && result.value.archivedAt === null) {
				// Pinning unarchives (SPEC §8) — full re-render so the header
				// status and the Restore/Archive label follow. Local tags are
				// carried into the new card: mutations save on their own
				// channel (m15), so the local array is the freshest intent and
				// a failed/pending tag send must survive for Save to retry.
				pingTrackedChanged(tabUrl.href, true);
				renderEditor(config, tabUrl, { ...result.value, tags: [...tags] });
				return;
			}
			// Repaint the toggle in place so unsaved title/tags/note edits
			// survive the pin.
			pinned = result.value.pinnedAt !== null;
			paintPinButton();
			setBusy(false);
		})();
	});

	saveButton.addEventListener("click", () => {
		void (async () => {
			setBusy(true);
			errorLine.classList.add("hidden");
			const result = await patchBookmarkByUrl(config, {
				url: tabUrl.href,
				title: titleInput?.value ?? bookmark.title,
				tags: [...tags],
				note: noteInput.value, // empty string clears the note
			});
			setBusy(false);
			if (!result.ok) {
				showError(`save failed: ${failureText(result)}`);
				return;
			}
			saveButton.textContent = "Saved ✓";
			setTimeout(() => {
				saveButton.textContent = "Save";
			}, SAVED_FLASH_MS);
		})();
	});

	archiveButton.addEventListener("click", () => {
		void (async () => {
			setBusy(true);
			errorLine.classList.add("hidden");
			const result = await patchBookmarkByUrl(config, {
				url: tabUrl.href,
				archived: !archived,
			});
			if (!result.ok) {
				setBusy(false);
				showError(
					`${archived ? "restore" : "archive"} failed: ${failureText(result)}`,
				);
				return;
			}
			pingTrackedChanged(tabUrl.href, result.value.archivedAt === null);
			// Re-render from the server's updated bookmark: header flips
			// Bookmarked/Archived and the button label follows. Local tags are
			// carried into the new card (m15) — see the pin-unarchive path.
			renderEditor(config, tabUrl, { ...result.value, tags: [...tags] });
		})();
	});

	render(row, tagsBlock, noteBlock, footer, errorLine);
}

// ---------------------------------------------------------------------------
// Browsing-history toggle (m19, SPEC §13).
//
// A GLOBAL setting, so it lives outside #view (view re-renders never touch it)
// and shows in every paired state. The popup only reads and writes the
// `attention` storage key — it captures nothing and pings nothing; the
// background reacts to the key via storage.onChanged.

const historyEl = mustGet<HTMLDivElement>("#history");
const historyToggleEl = mustGet<HTMLButtonElement>("#history-toggle");

let historyMounted = false;

/** Unpaired states hide the section (it may already be mounted on a 401). */
function hideHistoryToggle(): void {
	historyEl.classList.add("hidden");
}

async function mountHistoryToggle(): Promise<void> {
	if (historyMounted) return;
	historyMounted = true;

	// Missing key = disabled (SPEC §13); a read failure shows the same.
	let enabled = false;
	try {
		enabled = isCaptureEnabled(
			(await browser.storage.local.get(CAPTURE_TOGGLE_KEY))[CAPTURE_TOGGLE_KEY],
		);
	} catch {
		enabled = false;
	}

	function paint(): void {
		historyToggleEl.setAttribute("aria-checked", enabled ? "true" : "false");
	}

	historyToggleEl.addEventListener("click", () => {
		enabled = !enabled;
		paint();
		void browser.storage.local.set({ [CAPTURE_TOGGLE_KEY]: { enabled } });
	});

	paint();
	historyEl.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Page snapshots (m25, SPEC §17.7).
//
// The popup only starts a snapshot (one message to the service worker) and
// renders `snapshotState` from chrome.storage.session; the worker runs it, so
// closing the popup cancels nothing. Like the history toggle, the section lives
// outside #view and shows in every paired state. The recent list and the Copy
// buttons are direct fetches with the pairing token.

const snapEl = mustGet<HTMLDivElement>("#snap");
const snapButton = mustGet<HTMLButtonElement>("#snap-button");
const snapStatusEl = mustGet<HTMLDivElement>("#snap-status");
const snapRecentEl = mustGet<HTMLDivElement>("#snap-recent");

const RECENT_SNAPSHOT_LIMIT = 5;
/** How long "Starting…" waits for the worker's first state before giving up. */
const SNAPSHOT_START_TIMEOUT_MS = 5_000;
const COPY_FLASH_MS = 1_600;

const STEP_TEXT: Record<"reading" | "capturing", string> = {
	reading: "Reading the page…",
	capturing: "Capturing the screenshot…",
};
const STEP_INDEX = { reading: 0, capturing: 1, uploading: 2 } as const;

let snapMounted = false;

function hideSnapshots(): void {
	snapEl.classList.add("hidden");
}

async function readSession(key: string): Promise<unknown> {
	try {
		return (await browser.storage.session.get(key))[key];
	} catch {
		return undefined;
	}
}

/** "example.com/path" for a raw URL; the raw string when it doesn't parse. */
function hostPath(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
	} catch {
		return rawUrl;
	}
}

function hostOf(rawUrl: string): string {
	try {
		return new URL(rawUrl).host;
	} catch {
		return "";
	}
}

function formatCount(n: number): string {
	return n.toLocaleString("en-US");
}

/** Briefly swap a button's label for an outcome, then restore it. */
function flashButton(button: HTMLButtonElement, text: string): void {
	// The resting label is recorded once, so a second click mid-flash restores
	// "Copy", not "Copied ✓".
	button.dataset.label ??= button.textContent ?? "";
	const original = button.dataset.label;
	button.textContent = text;
	setTimeout(() => {
		button.textContent = original;
	}, COPY_FLASH_MS);
}

async function writeClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

function openSnapshotPage(config: PopupConfig, id: number): void {
	void browser.tabs.create({ url: snapshotPageUrl(config.baseUrl, id) });
}

/**
 * Copy one stored snapshot's markdown (`GET /api/snapshots/:id`). A 401 is the
 * revoked-token case and swaps the whole popup to the unpaired prompt.
 */
async function copyRemoteMarkdown(
	config: PopupConfig,
	id: number,
	button: HTMLButtonElement,
): Promise<void> {
	button.disabled = true;
	const result = await getSnapshotMarkdown(config, fetch, id);
	button.disabled = false;
	if (!result.ok) {
		if (result.status === 401) {
			renderUnpaired();
			return;
		}
		flashButton(button, "Failed");
		return;
	}
	flashButton(
		button,
		(await writeClipboard(result.value)) ? "Copied ✓" : "Failed",
	);
}

async function mountSnapshots(
	config: PopupConfig,
	tab: { id?: number; url?: string },
): Promise<void> {
	if (snapMounted) return;
	snapMounted = true;
	// Shown before any await: a 401 elsewhere that hides it afterwards must win.
	snapEl.classList.remove("hidden");

	const tabId = tab.id;
	const canSnapshot =
		tabId !== undefined &&
		tab.url !== undefined &&
		/^https?:\/\//i.test(tab.url);
	if (!canSnapshot) snapButton.title = "Only web pages can be snapshotted";

	let state: SnapshotState | undefined;
	let starting = false;
	let startError: string | undefined;
	let startTimer: ReturnType<typeof setTimeout> | undefined;
	/** Monotonic: only the newest recent-list request may paint. */
	let recentSeq = 0;

	function line(text: string, className = "snap-line"): HTMLDivElement {
		return el("div", className, text);
	}

	function stepBar(current: number): HTMLDivElement {
		const bar = el("div", "snap-steps");
		for (let i = 0; i < 3; i += 1) {
			bar.append(
				el(
					"span",
					i < current ? "done" : i === current ? "current" : undefined,
				),
			);
		}
		return bar;
	}

	/** The snapshotted page, when it isn't the tab the popup is open on. */
	function otherPage(s: SnapshotState): HTMLElement[] {
		if (s.url === tab.url || s.url === "") return [];
		return [el("div", "snap-title", s.title?.trim() || hostPath(s.url))];
	}

	/** Copy the last run's markdown: the worker's session copy, else the server's. */
	async function copyLastMarkdown(
		s: SnapshotState,
		button: HTMLButtonElement,
	): Promise<void> {
		const stored = readStoredMarkdown(await readSession(SNAPSHOT_MARKDOWN_KEY));
		if (stored !== undefined && stored.runId === s.runId) {
			flashButton(
				button,
				(await writeClipboard(stored.markdown)) ? "Copied ✓" : "Failed",
			);
			return;
		}
		if (s.snapshotId !== undefined) {
			await copyRemoteMarkdown(config, s.snapshotId, button);
			return;
		}
		flashButton(button, "Unavailable");
	}

	function copyButton(s: SnapshotState, className: string): HTMLButtonElement {
		const button = el("button", className, "Copy markdown");
		button.type = "button";
		button.addEventListener("click", () => {
			void copyLastMarkdown(s, button);
		});
		return button;
	}

	function paint(): void {
		const inFlight = isInFlight(state);
		snapButton.disabled = !canSnapshot || starting || inFlight;

		const nodes: HTMLElement[] = [];
		if (starting && !inFlight) {
			nodes.push(stepBar(0), line("Starting…"));
		} else if (startError !== undefined) {
			nodes.push(el("div", "error-line", startError));
		} else if (state !== undefined) {
			const s = state;
			if (s.step === "reading" || s.step === "capturing") {
				nodes.push(
					stepBar(STEP_INDEX[s.step]),
					line(STEP_TEXT[s.step]),
					...otherPage(s),
				);
			} else if (s.step === "uploading") {
				const progress =
					s.uploadTotal !== undefined
						? `Uploading ${s.uploaded ?? 0} of ${s.uploadTotal}…`
						: "Uploading…";
				nodes.push(
					stepBar(STEP_INDEX.uploading),
					line(progress),
					...otherPage(s),
				);
			} else if (s.step === "done") {
				const parts = ["✓ Done"];
				if (s.screenshotFailed) parts.push("no screenshot");
				else if (s.screenshotCount !== undefined)
					parts.push(
						`${s.screenshotCount} screenshot${s.screenshotCount === 1 ? "" : "s"}`,
					);
				if (s.markdownChars !== undefined)
					parts.push(`${formatCount(s.markdownChars)} chars`);
				const actions = el("div", "snap-actions");
				if (s.snapshotId !== undefined) {
					const id = s.snapshotId;
					const open = el("button", "btn-secondary", "Open");
					open.type = "button";
					open.addEventListener("click", () => openSnapshotPage(config, id));
					actions.append(open);
				}
				actions.append(copyButton(s, "btn-accent"));
				nodes.push(
					line(parts.join(" · "), "snap-line ok"),
					...otherPage(s),
					actions,
				);
			} else if (s.unpaired) {
				const settings = el("button", "btn-secondary", "Open settings");
				settings.type = "button";
				settings.addEventListener("click", () => {
					void browser.runtime.openOptionsPage();
				});
				const actions = el("div", "snap-actions");
				actions.append(settings);
				nodes.push(
					el("div", "error-line", "Not paired — open settings to pair."),
					actions,
				);
			} else {
				nodes.push(
					el(
						"div",
						"error-line",
						`Snapshot failed: ${s.error ?? "unknown error"}`,
					),
					...otherPage(s),
				);
				// The page was read before the failure: its markdown is still in
				// the worker's session copy and worth having.
				if (s.markdownChars !== undefined) {
					const actions = el("div", "snap-actions");
					actions.append(copyButton(s, "btn-secondary"));
					nodes.push(actions);
				}
			}
		}
		snapStatusEl.replaceChildren(...nodes);
		snapStatusEl.classList.toggle("hidden", nodes.length === 0);
	}

	snapButton.addEventListener("click", () => {
		if (tabId === undefined) return;
		starting = true;
		startError = undefined;
		paint();
		// If the worker never publishes a state (it was busy), give the button back.
		clearTimeout(startTimer);
		startTimer = setTimeout(() => {
			starting = false;
			paint();
		}, SNAPSHOT_START_TIMEOUT_MS);
		void browser.runtime
			.sendMessage(snapshotStartMessage(tabId))
			.catch((error: unknown) => {
				clearTimeout(startTimer);
				starting = false;
				startError = `couldn't start: ${error instanceof Error ? error.message : String(error)}`;
				paint();
			});
	});

	let changed = false;
	browser.storage.onChanged.addListener((changes, area) => {
		if (area !== "session") return;
		const change = changes[SNAPSHOT_STATE_KEY];
		if (change === undefined) return;
		changed = true;
		const previous = state;
		state = readSnapshotState(change.newValue);
		if (state !== undefined && state.runId !== previous?.runId) {
			// The worker picked the click up.
			clearTimeout(startTimer);
			starting = false;
			startError = undefined;
		}
		paint();
		if (state?.step === "done" && previous?.step !== "done") void loadRecent();
	});

	snapRecentEl.replaceChildren(el("div", "message", "…"));
	void loadRecent();
	const initial = readSnapshotState(await readSession(SNAPSHOT_STATE_KEY));
	// A change that landed during the read is newer than what the read saw.
	if (!changed) state = initial;
	paint();

	async function loadRecent(): Promise<void> {
		const seq = ++recentSeq;
		const result = await listRecentSnapshots(
			config,
			fetch,
			RECENT_SNAPSHOT_LIMIT,
		);
		if (seq !== recentSeq) return;
		if (!result.ok) {
			if (result.status === 401) {
				renderUnpaired();
				return;
			}
			snapRecentEl.replaceChildren(
				el(
					"div",
					"error-line",
					`couldn't load snapshots: ${describeFailure(result)}`,
				),
			);
			return;
		}
		if (result.value.length === 0) {
			snapRecentEl.replaceChildren(el("div", "message", "No snapshots yet."));
			return;
		}
		snapRecentEl.replaceChildren(...result.value.map(recentRow));
	}

	function recentRow(snapshot: SnapshotSummary): HTMLElement {
		const row = el("div", "recent-row");
		const text = el("div", "recent-text");
		const meta = [hostOf(snapshot.url), relativeTime(snapshot.createdAt)];
		if (snapshot.status !== "complete") meta.push("incomplete");
		text.append(
			el("div", "recent-title", snapshot.title || snapshot.url),
			el("div", "recent-meta", meta.filter((part) => part !== "").join(" · ")),
		);
		const copy = el("button", "btn-small", "Copy");
		copy.type = "button";
		copy.addEventListener("click", () => {
			void copyRemoteMarkdown(config, snapshot.id, copy);
		});
		const open = el("button", "btn-small", "Open");
		open.type = "button";
		open.addEventListener("click", () => openSnapshotPage(config, snapshot.id));
		row.append(text, copy, open);
		return row;
	}
}

// ---------------------------------------------------------------------------
// Entry.

// Header brand → the site in a new tab. Wired at module scope, so it works in
// EVERY popup state (unpaired, non-http tab, not-bookmarked, editor); the
// target resolves per click — the configured base URL, else the default.
brandEl.addEventListener("click", () => {
	void (async () => {
		const config = await loadPopupConfig();
		await browser.tabs.create({ url: config?.baseUrl ?? DEFAULT_BASE_URL });
	})();
});

async function init(): Promise<void> {
	renderLoading();

	const [tab] = await browser.tabs.query({
		active: true,
		currentWindow: true,
	});
	const rawUrl = tab?.url;
	if (rawUrl === undefined || !/^https?:\/\//i.test(rawUrl)) {
		renderUnsupported();
		// Still a paired state when a token is configured, and the toggle is a
		// global setting — the tab just isn't bookmarkable. The snapshot section
		// shows too (its recent list and last result are global), with the
		// button disabled.
		void loadPopupConfig().then((paired) => {
			if (paired === undefined) return;
			void mountHistoryToggle();
			void mountSnapshots(paired, { id: tab?.id, url: undefined });
		});
		return;
	}
	const tabUrl = new URL(rawUrl);

	const config = await loadPopupConfig();
	if (config === undefined) {
		renderUnpaired();
		return;
	}
	// Paired: every state below the config check shows the browsing-history
	// and snapshot sections.
	void mountHistoryToggle();
	void mountSnapshots(config, { id: tab?.id, url: rawUrl });

	const result = await getBookmarkByUrl(config, rawUrl);
	if (!result.ok) {
		if (result.status === 401) {
			renderUnpaired();
		} else {
			renderError(`lookup failed: ${failureText(result)}`);
		}
		return;
	}

	if (result.value === null) {
		renderNotBookmarked(config, tabUrl, tab?.title ?? rawUrl);
	} else {
		renderEditor(config, tabUrl, result.value);
	}
}

void init();
