import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
	type Adapter,
	findAdapter,
	genericAdapter,
	runAdapter,
	siteAdapters,
} from "./index";

const ARTICLE = `<!doctype html><html lang="en"><head>
<title>Fallback title</title>
<meta property="og:site_name" content="Example Times">
<meta name="author" content="Ada Lovelace">
</head><body><nav>Home · About</nav><article><h1>On Engines</h1>
${"<p>The analytical engine weaves algebraic patterns just as the Jacquard loom weaves flowers and leaves. It is a long paragraph of real prose.</p>".repeat(8)}
</article><footer>© Example</footer></body></html>`;

function ctx(url: string, html = ARTICLE) {
	const { document } = parseHTML(html);
	return {
		document: document as unknown as Document,
		url: new URL(url),
		fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch,
	};
}

describe("findAdapter", () => {
	it("picks the reddit adapter for a reddit post URL", () => {
		expect(
			findAdapter(
				new URL("https://www.reddit.com/r/rust/comments/abc123/title/"),
			).id,
		).toBe("reddit-post");
	});

	it("falls back to generic for unknown sites and non-post reddit pages", () => {
		expect(findAdapter(new URL("https://example.com/a")).id).toBe("generic");
		expect(findAdapter(new URL("https://www.reddit.com/r/rust/")).id).toBe(
			"generic",
		);
	});

	it("skips disabled site adapters", () => {
		expect(
			findAdapter(new URL("https://old.reddit.com/r/rust/comments/abc123/x/"), [
				"reddit-post",
			]).id,
		).toBe("generic");
	});

	it("never disables the generic adapter", () => {
		expect(findAdapter(new URL("https://example.com/"), ["generic"])).toBe(
			genericAdapter,
		);
	});
});

describe("runAdapter", () => {
	it("stamps the adapter id and version", async () => {
		const result = await runAdapter(ctx("https://example.com/engines"));
		expect(result.adapterId).toBe("generic");
		expect(result.adapterVersion).toBe(genericAdapter.version);
		expect(result.markdown.startsWith("# ")).toBe(true);
		expect(result.markdown).toContain("analytical engine");
		expect(result.markdown).not.toContain("Home · About");
	});

	it("falls back to generic when a site adapter throws", async () => {
		const throwing: Adapter = {
			id: "always-throws",
			name: "Throws",
			description: "",
			version: "9.9.9",
			matches: () => true,
			extract: () => Promise.reject(new Error("boom")),
		};
		siteAdapters.unshift(throwing);
		try {
			const result = await runAdapter(ctx("https://example.com/engines"));
			expect(result.adapterId).toBe("generic");
			expect(result.data).toMatchObject({
				fallbackFrom: "always-throws",
				error: "boom",
			});
			expect(result.markdown).toContain("analytical engine");
		} finally {
			siteAdapters.splice(siteAdapters.indexOf(throwing), 1);
		}
	});
});
