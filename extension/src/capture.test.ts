import { describe, expect, it, vi } from "vitest";
import { captureHighlight, type HighlightCaptureDeps } from "./capture";
import type { TreeNode } from "./tree";
import { HIGHLIGHT_TEXT_LIMIT } from "./types";

const PAGE_URL = "https://example.com/article";

interface FakeDeps extends HighlightCaptureDeps {
	/** Flat call log so enqueue ORDER across dep boundaries is assertable. */
	calls: Array<
		| { op: "search"; url: string }
		| { op: "create"; title: string; url: string }
		| { op: "enqueueBookmark"; node: TreeNode }
		| { op: "enqueueHighlight"; url: string; text: string }
		| { op: "flush" }
	>;
}

function fakeDeps(searchResults: TreeNode[] = []): FakeDeps {
	const calls: FakeDeps["calls"] = [];
	return {
		calls,
		searchBookmarks: vi.fn(async (url: string) => {
			calls.push({ op: "search", url });
			return searchResults;
		}),
		createBookmark: vi.fn(async (details: { title: string; url: string }) => {
			calls.push({ op: "create", ...details });
			return { id: "created-1", title: details.title, url: details.url };
		}),
		enqueueLiveBookmark: vi.fn(async (node: TreeNode) => {
			calls.push({ op: "enqueueBookmark", node });
		}),
		enqueueHighlight: vi.fn(async (url: string, text: string) => {
			calls.push({ op: "enqueueHighlight", url, text });
		}),
		flush: vi.fn(async () => {
			calls.push({ op: "flush" });
		}),
	};
}

describe("captureHighlight", () => {
	it("already bookmarked: enqueues only the highlight, then flushes", async () => {
		const deps = fakeDeps([
			{ id: "b1", title: "Existing", url: PAGE_URL, parentId: "2" },
		]);
		await captureHighlight(deps, {
			selectionText: "a fine snippet",
			pageUrl: PAGE_URL,
			tabTitle: "Article",
		});
		expect(deps.calls).toEqual([
			{ op: "search", url: PAGE_URL },
			{ op: "enqueueHighlight", url: PAGE_URL, text: "a fine snippet" },
			{ op: "flush" },
		]);
	});

	it("not bookmarked: creates the bookmark (tab title, default folder) and enqueues bookmark entry BEFORE the highlight", async () => {
		const deps = fakeDeps([]);
		await captureHighlight(deps, {
			selectionText: "snippet",
			pageUrl: PAGE_URL,
			tabTitle: "Article",
		});
		expect(deps.calls).toEqual([
			{ op: "search", url: PAGE_URL },
			{ op: "create", title: "Article", url: PAGE_URL },
			{
				op: "enqueueBookmark",
				node: { id: "created-1", title: "Article", url: PAGE_URL },
			},
			{ op: "enqueueHighlight", url: PAGE_URL, text: "snippet" },
			{ op: "flush" },
		]);
	});

	it("search results without a url (folders) do not count as bookmarked", async () => {
		const deps = fakeDeps([{ id: "folder-1", title: "Dev" }]); // no url
		await captureHighlight(deps, {
			selectionText: "snippet",
			pageUrl: PAGE_URL,
			tabTitle: "Article",
		});
		expect(deps.createBookmark).toHaveBeenCalledOnce();
		expect(deps.enqueueLiveBookmark).toHaveBeenCalledOnce();
	});

	it("falls back to the page URL as title when the tab has none", async () => {
		const deps = fakeDeps([]);
		await captureHighlight(deps, {
			selectionText: "snippet",
			pageUrl: PAGE_URL,
		});
		expect(deps.createBookmark).toHaveBeenCalledWith({
			title: PAGE_URL,
			url: PAGE_URL,
		});
	});

	it("empty selection: does nothing at all", async () => {
		const deps = fakeDeps();
		await captureHighlight(deps, { selectionText: "", pageUrl: PAGE_URL });
		await captureHighlight(deps, { pageUrl: PAGE_URL }); // undefined selection
		expect(deps.calls).toEqual([]);
	});

	it("whitespace-only selection: does nothing at all", async () => {
		const deps = fakeDeps();
		await captureHighlight(deps, {
			selectionText: "  \n\t ",
			pageUrl: PAGE_URL,
		});
		expect(deps.calls).toEqual([]);
	});

	it("missing page URL: does nothing at all", async () => {
		const deps = fakeDeps();
		await captureHighlight(deps, { selectionText: "snippet" });
		expect(deps.calls).toEqual([]);
	});

	it("truncates selections longer than HIGHLIGHT_TEXT_LIMIT chars", async () => {
		const deps = fakeDeps([{ id: "b1", title: "t", url: PAGE_URL }]);
		const selection = "x".repeat(HIGHLIGHT_TEXT_LIMIT + 500);
		await captureHighlight(deps, {
			selectionText: selection,
			pageUrl: PAGE_URL,
		});
		expect(deps.enqueueHighlight).toHaveBeenCalledWith(
			PAGE_URL,
			"x".repeat(HIGHLIGHT_TEXT_LIMIT),
		);
	});
});
