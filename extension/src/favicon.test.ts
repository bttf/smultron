import { describe, expect, it, vi } from "vitest";
import { lookupTabFavicon, type QueryTabsByUrl } from "./favicon";
import { flattenTree } from "./tree";

describe("lookupTabFavicon", () => {
	it("returns the first matching tab's favIconUrl", async () => {
		const query: QueryTabsByUrl = vi.fn(async () => [
			{ favIconUrl: "https://calendar.google.com/googlecalendar/images/f.ico" },
			{ favIconUrl: "https://other.example/second.ico" },
		]);
		expect(
			await lookupTabFavicon(
				query,
				"https://calendar.google.com/calendar/u/0/r",
			),
		).toBe("https://calendar.google.com/googlecalendar/images/f.ico");
		expect(query).toHaveBeenCalledWith(
			"https://calendar.google.com/calendar/u/0/r",
		);
	});

	it("returns undefined when no tab matches", async () => {
		expect(await lookupTabFavicon(async () => [], "https://a.com/x")).toBe(
			undefined,
		);
	});

	it("returns undefined when the matching tab has no favicon", async () => {
		expect(await lookupTabFavicon(async () => [{}], "https://a.com/x")).toBe(
			undefined,
		);
	});

	it("returns undefined for an empty-string favicon", async () => {
		// Chrome reports "" for a page that declares no icon.
		expect(
			await lookupTabFavicon(
				async () => [{ favIconUrl: "" }],
				"https://a.com/x",
			),
		).toBe(undefined);
	});

	it("returns undefined when the query throws", async () => {
		const query: QueryTabsByUrl = async () => {
			throw new Error("Invalid match pattern");
		};
		expect(await lookupTabFavicon(query, "https://a.com/x#frag")).toBe(
			undefined,
		);
	});

	it("returns undefined when the query rejects asynchronously", async () => {
		const query: QueryTabsByUrl = () =>
			Promise.reject(new Error("missing permission"));
		expect(await lookupTabFavicon(query, "https://a.com/x")).toBe(undefined);
	});

	it("passes a data: favicon through unvalidated — the server judges it", async () => {
		expect(
			await lookupTabFavicon(
				async () => [{ favIconUrl: "data:image/png;base64,AAA" }],
				"https://a.com/x",
			),
		).toBe("data:image/png;base64,AAA");
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
