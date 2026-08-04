import { describe, expect, it } from "vitest";
import { extractSharedUrl } from "./shareTarget";

describe("extractSharedUrl", () => {
	it("prefers a valid url param", () => {
		expect(
			extractSharedUrl({
				url: "https://example.com/a",
				text: "https://other.com/b",
				title: "https://third.com/c",
			}),
		).toBe("https://example.com/a");
	});

	it("trims whitespace around the url param", () => {
		expect(extractSharedUrl({ url: "  https://example.com/a  " })).toBe(
			"https://example.com/a",
		);
	});

	it("falls back to text when the url param is invalid", () => {
		expect(
			extractSharedUrl({ url: "not a url", text: "see https://example.com/x" }),
		).toBe("https://example.com/x");
	});

	it("extracts a url embedded in prose", () => {
		expect(
			extractSharedUrl({
				text: "Check this out https://example.com/post?a=1 — via SomeApp",
			}),
		).toBe("https://example.com/post?a=1");
	});

	it("takes the first url when text has several", () => {
		expect(
			extractSharedUrl({ text: "https://one.com/a and https://two.com/b" }),
		).toBe("https://one.com/a");
	});

	it("falls back to the title when url and text yield nothing", () => {
		expect(
			extractSharedUrl({ title: "https://example.com/from-title", text: "" }),
		).toBe("https://example.com/from-title");
	});

	it("extracts a url embedded in the title", () => {
		expect(extractSharedUrl({ title: "A post: https://example.com/t" })).toBe(
			"https://example.com/t",
		);
	});

	it("trims trailing punctuation share sheets append", () => {
		expect(extractSharedUrl({ text: "read https://example.com/a." })).toBe(
			"https://example.com/a",
		);
		expect(extractSharedUrl({ text: "(https://example.com/a)" })).toBe(
			"https://example.com/a",
		);
		expect(extractSharedUrl({ url: "https://example.com/a," })).toBe(
			"https://example.com/a",
		);
	});

	it("keeps punctuation that is part of the url", () => {
		// A bare host path segment ending in ")" is still a distinct resource;
		// trimming only happens when the shorter string also parses, so we
		// check a wikipedia-style parenthesised slug survives its inner ")".
		expect(
			extractSharedUrl({ url: "https://en.wikipedia.org/wiki/Ruby_(gem)" }),
		).toBe("https://en.wikipedia.org/wiki/Ruby_(gem)");
		expect(extractSharedUrl({ url: "https://example.com/a?b=1&c=2" })).toBe(
			"https://example.com/a?b=1&c=2",
		);
	});

	it("returns null when nothing shareable is present", () => {
		expect(extractSharedUrl({})).toBeNull();
		expect(
			extractSharedUrl({ title: "Just a headline", text: "no link" }),
		).toBe(null);
		expect(extractSharedUrl({ url: "", text: "", title: "" })).toBeNull();
	});

	it("rejects non-http(s) schemes", () => {
		expect(extractSharedUrl({ url: "ftp://example.com/a" })).toBeNull();
		expect(extractSharedUrl({ url: "javascript:alert(1)" })).toBeNull();
		expect(extractSharedUrl({ url: "mailto:hi@example.com" })).toBeNull();
		expect(extractSharedUrl({ text: "file:///etc/passwd" })).toBeNull();
	});

	it("rejects hostnames without a dot", () => {
		expect(extractSharedUrl({ url: "https://localhost:3000/a" })).toBeNull();
		expect(extractSharedUrl({ text: "http://intranet/page" })).toBeNull();
	});

	it("accepts http as well as https", () => {
		expect(extractSharedUrl({ url: "http://example.com/a" })).toBe(
			"http://example.com/a",
		);
	});
});
