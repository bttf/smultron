/**
 * Pure helpers over Chrome's bookmark tree shape. No Chrome APIs are touched
 * here so everything is unit-testable with plain objects.
 */

import type { SyncBookmark } from "./types";

/** Structural subset of chrome.bookmarks.BookmarkTreeNode. */
export interface TreeNode {
	id: string;
	title: string;
	url?: string;
	dateAdded?: number;
	parentId?: string;
	children?: TreeNode[];
}

/**
 * Depth-first flatten of a `chrome.bookmarks.getTree()` result into sync
 * bookmarks. Folders (nodes without `url`) contribute their title to the
 * `/`-joined folder path of their descendants, e.g. `Bookmarks Bar/Dev/Postgres`.
 * Nodes with an empty title (Chrome's invisible root) are excluded from paths.
 */
export function flattenTree(roots: TreeNode[]): SyncBookmark[] {
	const out: SyncBookmark[] = [];
	const walk = (node: TreeNode, ancestors: readonly string[]): void => {
		if (node.url !== undefined) {
			const bookmark: SyncBookmark = {
				url: node.url,
				title: node.title,
				chromeId: node.id,
			};
			if (node.dateAdded !== undefined) bookmark.dateAddedMs = node.dateAdded;
			if (ancestors.length > 0) bookmark.folderPath = ancestors.join("/");
			out.push(bookmark);
			return;
		}
		const next = node.title === "" ? ancestors : [...ancestors, node.title];
		for (const child of node.children ?? []) walk(child, next);
	};
	for (const root of roots) walk(root, []);
	return out;
}

/** Split `items` into consecutive batches of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		batches.push(items.slice(i, i + size));
	}
	return batches;
}

/**
 * Resolve a bookmark's folder path by walking the parent chain upward from
 * `parentId`. `getNode` is injected (in production it wraps
 * `chrome.bookmarks.get`) so this stays testable. Empty titles (the root
 * node) are skipped; returns undefined when there are no titled ancestors.
 */
export async function resolveFolderPath(
	getNode: (id: string) => Promise<TreeNode | undefined>,
	parentId: string | undefined,
): Promise<string | undefined> {
	const titles: string[] = [];
	let currentId = parentId;
	while (currentId !== undefined) {
		const node = await getNode(currentId);
		if (node === undefined) break;
		if (node.title !== "") titles.unshift(node.title);
		currentId = node.parentId;
	}
	return titles.length > 0 ? titles.join("/") : undefined;
}
