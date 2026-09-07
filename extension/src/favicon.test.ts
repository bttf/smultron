import { describe, expect, it } from "vitest";
import {
	lookupTabFavicon,
	type QueryAllTabs,
	type TabFavicon,
} from "./favicon";
import { flattenTree } from "./tree";

/** A `queryAllTabs` returning a fixed tab list. */
function tabsOf(...tabs: TabFavicon[]): QueryAllTabs {
	return async () => tabs;
}

const CAL_URL = "https://calendar.google.com/calendar/u/0/r";
const CAL_ICON = "https://calendar.google.com/googlecalendar/images/f.ico";

describe("lookupTabFavicon", () => {
	it("returns the favicon of the tab whose url matches exactly", async () => {
		const query = tabsOf(
			{ url: "https://other.example/", favIconUrl: "https://other.example/i" },
			{ url: CAL_URL, favIconUrl: CAL_ICON },
		);
		expect(await lookupTabFavicon(query, CAL_URL)).toBe(CAL_ICON);
	});

	// The bug this whole helper design exists for: `chrome.tabs.query({url})`
	// takes a MATCH PATTERN, and a pattern containing `#` matches no tab (and
	// returns [] rather than throwing), so every SPA-route bookmark silently
	// lost its favicon. String comparison has no such semantics.
	it("finds a tab whose URL contains a fragment", async () => {
		const url = "https://mail.google.com/mail/u/0/#inbox";
		const icon = "https://mail.google.com/favicon.ico";
		expect(await lookupTabFavicon(tabsOf({ url, favIconUrl: icon }), url)).toBe(
			icon,
		);
	});

	it("does not treat `*` in the URL as a wildcard", async () => {
		const query = tabsOf({
			url: "https://a.com/other",
			favIconUrl: "https://a.com/wrong.ico",
		});
		expect(await lookupTabFavicon(query, "https://a.com/*")).toBe(undefined);
	});

	it("matches a URL with userinfo like any other string", async () => {
		const url = "https://u@a.com/x";
		const icon = "https://a.com/right.ico";
		expect(await lookupTabFavicon(tabsOf({ url, favIconUrl: icon }), url)).toBe(
			icon,
		);
	});

	it("prefers the active tab when several tabs share the URL", async () => {
		const query = tabsOf(
			{ url: CAL_URL, favIconUrl: "https://a.com/background.ico" },
			{ url: CAL_URL, favIconUrl: CAL_ICON, active: true },
		);
		expect(await lookupTabFavicon(query, CAL_URL)).toBe(CAL_ICON);
	});

	it("falls back to another matching tab's icon when the active one has none", async () => {
		const query = tabsOf(
			{ url: CAL_URL, favIconUrl: "", active: true },
			{ url: CAL_URL, favIconUrl: CAL_ICON },
		);
		expect(await lookupTabFavicon(query, CAL_URL)).toBe(CAL_ICON);
	});

	it("returns undefined when no tab matches", async () => {
		const query = tabsOf({ url: "https://b.com/y", favIconUrl: CAL_ICON });
		expect(await lookupTabFavicon(query, "https://a.com/x")).toBe(undefined);
	});

	it("returns undefined when no tab is open at all", async () => {
		expect(await lookupTabFavicon(tabsOf(), "https://a.com/x")).toBe(undefined);
	});

	it("returns undefined when the matching tab has no favicon", async () => {
		const query = tabsOf({ url: "https://a.com/x" });
		expect(await lookupTabFavicon(query, "https://a.com/x")).toBe(undefined);
	});

	it("returns undefined for an empty-string favicon", async () => {
		// Chrome reports "" for a page that declares no icon.
		const query = tabsOf({ url: "https://a.com/x", favIconUrl: "" });
		expect(await lookupTabFavicon(query, "https://a.com/x")).toBe(undefined);
	});

	it("returns undefined when the query throws", async () => {
		const query: QueryAllTabs = async () => {
			throw new Error("missing permission");
		};
		expect(await lookupTabFavicon(query, "https://a.com/x")).toBe(undefined);
	});

	it("returns undefined when the query rejects asynchronously", async () => {
		const query: QueryAllTabs = () =>
			Promise.reject(new Error("context invalidated"));
		expect(await lookupTabFavicon(query, "https://a.com/x")).toBe(undefined);
	});

	it("passes a data: favicon through unvalidated — the server judges it", async () => {
		const query = tabsOf({
			url: "https://a.com/x",
			favIconUrl: "data:image/png;base64,AAA",
		});
		expect(await lookupTabFavicon(query, "https://a.com/x")).toBe(
			"data:image/png;base64,AAA",
		);
	});
});

describe("backfill entries carry no favicon", () => {
	it("flattenTree never sets faviconUrl", () => {
		const bookmarks = flattenTree([
			{
				id: "0",
				title: "",
				children: [
					{
						id: "1",
						title: "Bookmarks Bar",
						children: [
							{ id: "2", title: "A", url: "https://a.com/x", dateAdded: 1 },
							{ id: "3", title: "B", url: "https://b.com/y" },
						],
					},
				],
			},
		]);
		expect(bookmarks).toHaveLength(2);
		for (const bookmark of bookmarks) {
			expect("faviconUrl" in bookmark).toBe(false);
		}
	});
});
