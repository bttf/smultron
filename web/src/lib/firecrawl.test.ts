// The m17 metadata fetch (SPEC §5). `scrapePageMetadata` asks Firecrawl for
// the `summary` format and reads title/favicon straight off the response's
// `metadata` object — Firecrawl parses the page and resolves the icon href for
// us, so there is no HTML parsing left on our side. What IS still ours is what
// we're willing to store: these tests pin the response-shape handling and the
// favicon-URL validation, with `fetch` stubbed (same pattern as tts.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrapePageMetadata } from "./firecrawl";
import { PipelineError } from "./pipelineError";

const originalEnv = { ...process.env };

beforeEach(() => {
	process.env.FIRECRAWL_API_KEY = "test-key";
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env = { ...originalEnv };
});

type ScrapeData = {
	summary?: unknown;
	metadata?: unknown;
};

/** Bodies of every scrape request made, in call order. */
const requests: Array<Record<string, unknown>> = [];

/** Stubs `fetch` with one `/v2/scrape` response envelope. */
function stubScrape(data: ScrapeData | null, status = 200) {
	requests.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			requests.push(JSON.parse(String(init.body)));
			return new Response(JSON.stringify({ success: true, data }), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
}

const FULL: ScrapeData = {
	summary: "A short digest of the page, as Firecrawl's LLM saw it.",
	metadata: {
		title: "The Real Page Title",
		favicon: "https://example.com/icon.png",
		sourceURL: "https://example.com/post",
		statusCode: 200,
	},
};

describe("scrapePageMetadata", () => {
	it("asks for the summary format and returns title, favicon and summary", async () => {
		stubScrape(FULL);

		expect(await scrapePageMetadata("https://example.com/post")).toEqual({
			title: "The Real Page Title",
			faviconUrl: "https://example.com/icon.png",
			summary: "A short digest of the page, as Firecrawl's LLM saw it.",
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://example.com/post");
		// No rawHtml/markdown: the response metadata carries everything we fill.
		expect(requests[0]?.formats).toEqual(["summary"]);
	});

	it("normalizes a multi-line title and takes the first of repeated ones", async () => {
		stubScrape({
			metadata: { title: "\n  Tom & Jerry —\n  the good one\n" },
		});
		expect((await scrapePageMetadata("https://example.com")).title).toBe(
			"Tom & Jerry — the good one",
		);

		stubScrape({ metadata: { title: ["   ", "Second", "Third"] } });
		expect((await scrapePageMetadata("https://example.com")).title).toBe(
			"Second",
		);
	});

	it("returns a null title when the page had none", async () => {
		stubScrape({ metadata: { favicon: "https://example.com/i.ico" } });
		expect((await scrapePageMetadata("https://example.com")).title).toBeNull();

		stubScrape({ metadata: { title: "   " } });
		expect((await scrapePageMetadata("https://example.com")).title).toBeNull();
	});

	it("accepts an absolute http(s) favicon as Firecrawl resolved it", async () => {
		stubScrape({
			metadata: { favicon: "http://cdn.example.net/deep/path/i.png?v=2" },
		});
		expect((await scrapePageMetadata("https://example.com")).faviconUrl).toBe(
			"http://cdn.example.net/deep/path/i.png?v=2",
		);
	});

	it("drops a data: favicon rather than inlining it into every feed row", async () => {
		stubScrape({
			metadata: { favicon: "data:image/png;base64,iVBORw0KGgo=" },
		});
		expect(
			(await scrapePageMetadata("https://example.com")).faviconUrl,
		).toBeNull();
	});

	it("drops a non-http(s) favicon", async () => {
		stubScrape({ metadata: { favicon: "ftp://example.com/i.ico" } });
		expect(
			(await scrapePageMetadata("https://example.com")).faviconUrl,
		).toBeNull();
	});

	it("drops an oversized favicon URL", async () => {
		stubScrape({
			metadata: { favicon: `https://example.com/${"x".repeat(3000)}.ico` },
		});
		expect(
			(await scrapePageMetadata("https://example.com")).faviconUrl,
		).toBeNull();
	});

	it("drops an unparseable or relative favicon instead of resolving it", async () => {
		// Firecrawl is supposed to hand back an absolute URL; if it doesn't, we
		// have no base here — and a stored URL that 404s is worse than none.
		stubScrape({ metadata: { favicon: "/favicon.ico" } });
		expect(
			(await scrapePageMetadata("https://example.com")).faviconUrl,
		).toBeNull();

		stubScrape({ metadata: { favicon: "http://" } });
		expect(
			(await scrapePageMetadata("https://example.com")).faviconUrl,
		).toBeNull();
	});

	it("never guesses /favicon.ico when the page declared none", async () => {
		stubScrape({ metadata: { title: "No icon here" } });
		expect(
			(await scrapePageMetadata("https://example.com")).faviconUrl,
		).toBeNull();
	});

	it("returns a null summary when it is absent or blank", async () => {
		stubScrape({ metadata: { title: "T" } });
		expect(
			(await scrapePageMetadata("https://example.com")).summary,
		).toBeNull();

		stubScrape({ summary: "  \n  ", metadata: { title: "T" } });
		expect(
			(await scrapePageMetadata("https://example.com")).summary,
		).toBeNull();
	});

	it("trims the summary but keeps its own line breaks", async () => {
		stubScrape({ summary: "\nFirst line.\n\nSecond line.\n" });
		expect((await scrapePageMetadata("https://example.com")).summary).toBe(
			"First line.\n\nSecond line.",
		);
	});

	it("survives a missing or malformed metadata object", async () => {
		const empty = { title: null, faviconUrl: null, summary: null };

		stubScrape({});
		expect(await scrapePageMetadata("https://example.com")).toEqual(empty);

		stubScrape({ metadata: null });
		expect(await scrapePageMetadata("https://example.com")).toEqual(empty);

		stubScrape(null);
		expect(await scrapePageMetadata("https://example.com")).toEqual(empty);
	});

	it("still maps Firecrawl failures onto PipelineError", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 401 })),
		);
		await expect(scrapePageMetadata("https://example.com")).rejects.toThrow(
			PipelineError,
		);

		// A 2xx envelope around a 404 page is a failure too.
		stubScrape({ metadata: { statusCode: 404 } });
		await expect(
			scrapePageMetadata("https://example.com"),
		).rejects.toMatchObject({ code: "page_404" });
	});
});
