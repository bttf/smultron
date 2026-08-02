// Browser-action popup: look up the active tab's bookmark via
// GET /api/bookmarks/by-url, edit title/tags/note locally, save with one
// PATCH, archive/restore, or create the bookmark (default folder — the
// background's onCreated listener live-syncs it). All popup traffic is
// DIRECT fetch with truthful user-visible outcomes — never the outbox.

import { relativeTime } from "@/src/relativeTime";
import {
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

// ---------------------------------------------------------------------------
// DOM helpers — user/tab-derived strings only ever go through textContent.

function mustGet<T extends Element>(selector: string): T {
	const found = document.querySelector<T>(selector);
	if (found === null) throw new Error(`missing element: ${selector}`);
	return found;
}

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
			try {
				// Default folder (no parentId): the background onCreated listener
				// live-syncs this creation, which correctly bumps updated_at.
				await browser.bookmarks.create({
					title: tabTitle,
					url: tabUrl.href,
				});
			} catch (error) {
				setHeaderStatus("not-bookmarked");
				button.disabled = false;
				errorLine.textContent = `couldn't create bookmark: ${
					error instanceof Error ? error.message : String(error)
				}`;
				errorLine.classList.remove("hidden");
				return;
			}
			// Poll until live sync lands, then swap to the editing card.
			const deadline = Date.now() + SYNC_POLL_TIMEOUT_MS;
			while (Date.now() < deadline) {
				await new Promise((resolve) =>
					setTimeout(resolve, SYNC_POLL_INTERVAL_MS),
				);
				const result = await getBookmarkByUrl(config, tabUrl.href);
				if (result.ok && result.value !== null) {
					renderEditor(config, tabUrl, result.value);
					return;
				}
			}
			setHeaderStatus("not-bookmarked");
			button.disabled = false;
			errorLine.textContent =
				"sync hasn't caught up — reopen the popup in a moment.";
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

	// Edits accumulate locally; Save sends one PATCH.
	const tags = [...bookmark.tags];

	const { row, titleInput } = pageRow(tabUrl, bookmark.title, {
		editable: true,
	});

	// TAGS block.
	const tagsBlock = el("div", "block");
	tagsBlock.append(el("div", "block-label", "TAGS"));
	const chips = el("div", "chips");
	const tagInput = el("input", "tag-input");
	tagInput.type = "text";
	tagInput.placeholder = "add tag ⏎";
	tagInput.spellcheck = false;

	function renderChips(): void {
		const nodes: HTMLElement[] = tags.map((tag, index) => {
			const chip = el("span", "chip");
			chip.append(el("span", undefined, tag));
			const remove = el("button", "chip-remove", "✕");
			remove.type = "button";
			remove.addEventListener("click", () => {
				tags.splice(index, 1);
				renderChips();
			});
			chip.append(remove);
			return chip;
		});
		chips.replaceChildren(...nodes, tagInput);
	}

	tagInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			const tag = tagInput.value.trim();
			tagInput.value = "";
			if (tag === "" || tags.includes(tag)) return;
			tags.push(tag);
			renderChips();
			tagInput.focus();
		} else if (event.key === "Backspace" && tagInput.value === "") {
			if (tags.length > 0) {
				tags.pop();
				renderChips();
				tagInput.focus();
			}
		}
	});

	renderChips();
	tagsBlock.append(chips);

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
	const archiveButton = el(
		"button",
		"btn-secondary",
		archived ? "Restore" : "Archive",
	);
	archiveButton.type = "button";
	const saveButton = el("button", "btn-accent", "Save");
	saveButton.type = "button";
	actions.append(archiveButton, saveButton);
	footer.append(actions);

	const errorLine = el("div", "error-line hidden");

	function showError(text: string): void {
		errorLine.textContent = text;
		errorLine.classList.remove("hidden");
	}

	saveButton.addEventListener("click", () => {
		void (async () => {
			saveButton.disabled = true;
			archiveButton.disabled = true;
			errorLine.classList.add("hidden");
			const result = await patchBookmarkByUrl(config, {
				url: tabUrl.href,
				title: titleInput?.value ?? bookmark.title,
				tags: [...tags],
				note: noteInput.value, // empty string clears the note
			});
			saveButton.disabled = false;
			archiveButton.disabled = false;
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
			saveButton.disabled = true;
			archiveButton.disabled = true;
			errorLine.classList.add("hidden");
			const result = await patchBookmarkByUrl(config, {
				url: tabUrl.href,
				archived: !archived,
			});
			if (!result.ok) {
				saveButton.disabled = false;
				archiveButton.disabled = false;
				showError(
					`${archived ? "restore" : "archive"} failed: ${failureText(result)}`,
				);
				return;
			}
			// Re-render from the server's updated bookmark: header flips
			// Bookmarked/Archived and the button label follows.
			renderEditor(config, tabUrl, result.value);
		})();
	});

	render(row, tagsBlock, noteBlock, footer, errorLine);
}

// ---------------------------------------------------------------------------
// Entry.

async function init(): Promise<void> {
	renderLoading();

	const [tab] = await browser.tabs.query({
		active: true,
		currentWindow: true,
	});
	const rawUrl = tab?.url;
	if (rawUrl === undefined || !/^https?:\/\//i.test(rawUrl)) {
		renderUnsupported();
		return;
	}
	const tabUrl = new URL(rawUrl);

	const config = await loadPopupConfig();
	if (config === undefined) {
		renderUnpaired();
		return;
	}

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
