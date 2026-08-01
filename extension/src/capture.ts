/**
 * Highlight capture flow (SPEC §6) — the logic behind the context-menu
 * click, with every Chrome touchpoint injected so it is unit-testable.
 * The background entrypoint wires in `chrome.bookmarks.*` and the outbox.
 *
 * Flow: bail on empty selections; truncate to HIGHLIGHT_TEXT_LIMIT; ensure
 * the page is bookmarked (creating in the default folder if not, and
 * enqueueing that bookmark's live entry DIRECTLY — never relying on the
 * independent `onCreated` listener's timing; its duplicate enqueue is
 * harmless because a live re-save is idempotent); enqueue the highlight
 * AFTER the bookmark entry so outbox FIFO guarantees the server sees the
 * bookmark first; flush once at the end.
 */

import type { TreeNode } from "./tree";
import { HIGHLIGHT_TEXT_LIMIT } from "./types";

export interface HighlightCaptureDeps {
	/** `chrome.bookmarks.search({ url })` in production. */
	searchBookmarks(url: string): Promise<TreeNode[]>;
	/** `chrome.bookmarks.create(...)` in production — no parentId (default folder). */
	createBookmark(details: { title: string; url: string }): Promise<TreeNode>;
	/** Enqueue a `mode:'live'` sync entry for a bookmark node (no flush). */
	enqueueLiveBookmark(node: TreeNode): Promise<void>;
	/** Enqueue a `kind:'highlight'` entry (no flush). */
	enqueueHighlight(url: string, text: string): Promise<void>;
	flush(): Promise<void>;
}

/** The bits of `chrome.contextMenus.OnClickData` (+ tab) the flow reads. */
export interface HighlightClick {
	/** `info.selectionText`. */
	selectionText?: string;
	/** `info.pageUrl` — NOT frameUrl, NOT tab.url. */
	pageUrl?: string;
	/** `tab?.title`, used only when a bookmark must be created. */
	tabTitle?: string;
}

export async function captureHighlight(
	deps: HighlightCaptureDeps,
	click: HighlightClick,
): Promise<void> {
	const { selectionText, pageUrl } = click;
	// No usable selection or URL: bail silently — nothing to capture.
	if (selectionText === undefined || selectionText.trim() === "") return;
	if (pageUrl === undefined || pageUrl === "") return;
	const text = selectionText.slice(0, HIGHLIGHT_TEXT_LIMIT);

	// Already bookmarked? Folder nodes have no `url`, so only url-bearing
	// results count. A URL-variant miss creating a second Chrome bookmark is
	// acceptable — the server dedupes by normalized URL (SPEC §6).
	const results = await deps.searchBookmarks(pageUrl);
	if (!results.some((node) => node.url !== undefined)) {
		const created = await deps.createBookmark({
			title: click.tabTitle || pageUrl,
			url: pageUrl,
		});
		await deps.enqueueLiveBookmark(created);
	}

	// FIFO does the ordering guarantee: bookmark entry (if any) first,
	// highlight second, one flush for both.
	await deps.enqueueHighlight(pageUrl, text);
	await deps.flush();
}
