// The HTML-parsing half of the m17 metadata fetch (SPEC §5). Firecrawl's
// metadata carries the title but not the favicon, so `scrapePageMetadata`
// asks for rawHtml and reads the icon link out of the markup — these are the
// pure functions that do it. The network half is exercised through the
// injected fetcher in bookmarkMetadata.test.ts.
import { describe, expect, it } from "vitest";
import {
	faviconHrefFromHtml,
	resolveFaviconUrl,
	titleFromHtml,
} from "./firecrawl";

describe("titleFromHtml", () => {
	it("reads the <title>, collapsing whitespace and decoding entities", () => {
		expect(
			titleFromHtml(
				"<html><head><title>\n  Tom &amp; Jerry &#8212;\n  the &quot;good&quot; one\n</title></head>",
			),
		).toBe('Tom & Jerry — the "good" one');
	});

	it("handles attributes on the tag and is case-insensitive", () => {
		expect(titleFromHtml('<TITLE data-x="1">Hello</TITLE>')).toBe("Hello");
	});

	it("returns null with no title, or an empty one", () => {
		expect(titleFromHtml("<html><head></head></html>")).toBeNull();
		expect(titleFromHtml("<title>   </title>")).toBeNull();
	});
});

describe("faviconHrefFromHtml", () => {
	it("prefers rel=icon over apple-touch-icon regardless of document order", () => {
		const html = `
			<link rel="apple-touch-icon" href="/touch.png">
			<link rel="icon" type="image/png" href="/favicon-32.png">
		`;
		expect(faviconHrefFromHtml(html)).toBe("/favicon-32.png");
	});

	it("matches the legacy `shortcut icon` rel", () => {
		expect(
			faviconHrefFromHtml(`<link rel="shortcut icon" href="/fav.ico">`),
		).toBe("/fav.ico");
	});

	it("falls back to apple-touch-icon when that is all there is", () => {
		expect(
			faviconHrefFromHtml(`<link rel="apple-touch-icon" href="/touch.png">`),
		).toBe("/touch.png");
	});

	it("takes the first declaration within a tier", () => {
		const html = `
			<link rel="icon" href="/first.ico">
			<link rel="icon" sizes="32x32" href="/second.png">
		`;
		expect(faviconHrefFromHtml(html)).toBe("/first.ico");
	});

	it("reads single-quoted and unquoted attributes", () => {
		expect(faviconHrefFromHtml("<link rel='icon' href='/a.ico'>")).toBe(
			"/a.ico",
		);
		expect(faviconHrefFromHtml("<link rel=icon href=/b.ico>")).toBe("/b.ico");
	});

	it("ignores unrelated links, and links with no href", () => {
		const html = `
			<link rel="stylesheet" href="/site.css">
			<link rel="canonical" href="https://example.com/post">
			<link rel="icon">
		`;
		expect(faviconHrefFromHtml(html)).toBeNull();
	});

	it("returns null rather than guessing /favicon.ico", () => {
		// A stored URL that 404s is worse than none: the UI's hostname fallback
		// always renders something.
		expect(faviconHrefFromHtml("<html><head></head></html>")).toBeNull();
	});
});

describe("resolveFaviconUrl", () => {
	it("resolves root-relative, path-relative and protocol-relative hrefs", () => {
		const base = "https://example.com/blog/post";
		expect(resolveFaviconUrl("/favicon.ico", base)).toBe(
			"https://example.com/favicon.ico",
		);
		expect(resolveFaviconUrl("icon.png", base)).toBe(
			"https://example.com/blog/icon.png",
		);
		expect(resolveFaviconUrl("//cdn.example.net/i.png", base)).toBe(
			"https://cdn.example.net/i.png",
		);
	});

	it("keeps an absolute href as-is", () => {
		expect(
			resolveFaviconUrl("https://cdn.example.net/i.png", "https://example.com"),
		).toBe("https://cdn.example.net/i.png");
	});

	it("drops null, unparseable, non-http(s) and oversized hrefs", () => {
		const base = "https://example.com";
		expect(resolveFaviconUrl(null, base)).toBeNull();
		expect(resolveFaviconUrl("http://", base)).toBeNull();
		// data: icons would inline kilobytes into every feed response.
		expect(
			resolveFaviconUrl("data:image/png;base64,iVBORw0KGgo=", base),
		).toBeNull();
		expect(resolveFaviconUrl(`/${"x".repeat(3000)}.ico`, base)).toBeNull();
	});
});
