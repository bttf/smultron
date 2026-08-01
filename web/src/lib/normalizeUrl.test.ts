import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./normalizeUrl";

describe("normalizeUrl", () => {
	describe("parsing failures", () => {
		it("returns the trimmed original for unparseable input", () => {
			expect(normalizeUrl("not a url")).toBe("not a url");
			expect(normalizeUrl("   not a url  ")).toBe("not a url");
			expect(normalizeUrl("http://")).toBe("http://");
			expect(normalizeUrl("")).toBe("");
			expect(normalizeUrl("   ")).toBe("");
			expect(normalizeUrl("://missing-scheme.com")).toBe(
				"://missing-scheme.com",
			);
			expect(normalizeUrl("example.com/no-scheme")).toBe(
				"example.com/no-scheme",
			);
		});
	});

	describe("scheme and host lowercasing", () => {
		it("lowercases the scheme", () => {
			expect(normalizeUrl("HTTPS://example.com/a")).toBe(
				"https://example.com/a",
			);
			expect(normalizeUrl("HtTp://example.com/a")).toBe("http://example.com/a");
		});

		it("lowercases the host, leaving path case intact", () => {
			expect(normalizeUrl("https://EXAMPLE.COM/CaseSensitive")).toBe(
				"https://example.com/CaseSensitive",
			);
			expect(normalizeUrl("https://Sub.Example.Com/A?B=C")).toBe(
				"https://sub.example.com/A?B=C",
			);
		});
	});

	describe("fragment stripping", () => {
		it("strips fragments", () => {
			expect(normalizeUrl("https://example.com/a#section")).toBe(
				"https://example.com/a",
			);
			expect(normalizeUrl("https://example.com/a?b=1#section")).toBe(
				"https://example.com/a?b=1",
			);
		});

		it("strips empty fragments", () => {
			expect(normalizeUrl("https://example.com/a#")).toBe(
				"https://example.com/a",
			);
		});
	});

	describe("tracking param removal", () => {
		it("removes utm_* params", () => {
			expect(
				normalizeUrl(
					"https://example.com/a?utm_source=x&utm_medium=y&utm_campaign=z&utm_term=t&utm_content=c",
				),
			).toBe("https://example.com/a");
		});

		it("removes fbclid and gclid", () => {
			expect(normalizeUrl("https://example.com/a?fbclid=abc123")).toBe(
				"https://example.com/a",
			);
			expect(normalizeUrl("https://example.com/a?gclid=xyz")).toBe(
				"https://example.com/a",
			);
		});

		it("matches tracking param names case-insensitively", () => {
			expect(normalizeUrl("https://example.com/a?UTM_SOURCE=x")).toBe(
				"https://example.com/a",
			);
			expect(normalizeUrl("https://example.com/a?Utm_Medium=y")).toBe(
				"https://example.com/a",
			);
			expect(normalizeUrl("https://example.com/a?FBCLID=z&GcLiD=w")).toBe(
				"https://example.com/a",
			);
		});

		it("matches percent-encoded tracking param names", () => {
			expect(normalizeUrl("https://example.com/a?%75tm_source=x")).toBe(
				"https://example.com/a",
			);
		});

		it("keeps all non-tracking params in their original order", () => {
			expect(
				normalizeUrl("https://example.com/a?z=1&utm_source=x&a=2&gclid=g&m=3"),
			).toBe("https://example.com/a?z=1&a=2&m=3");
		});

		it("does not remove params that merely contain utm", () => {
			expect(normalizeUrl("https://example.com/a?autumn=1&utmx=2")).toBe(
				"https://example.com/a?autumn=1&utmx=2",
			);
			// "utm" without the underscore is not a utm_* param.
			expect(normalizeUrl("https://example.com/a?utm=1")).toBe(
				"https://example.com/a?utm=1",
			);
			// fbclid/gclid as values, not names, survive.
			expect(normalizeUrl("https://example.com/a?ref=fbclid")).toBe(
				"https://example.com/a?ref=fbclid",
			);
		});

		it("removes valueless tracking params", () => {
			expect(normalizeUrl("https://example.com/a?utm_source&b=1")).toBe(
				"https://example.com/a?b=1",
			);
			expect(normalizeUrl("https://example.com/a?fbclid")).toBe(
				"https://example.com/a",
			);
		});

		it("leaves no dangling ? when every param was a tracker", () => {
			expect(
				normalizeUrl("https://example.com/a?utm_source=x&fbclid=y&gclid=z"),
			).toBe("https://example.com/a");
			expect(normalizeUrl("https://example.com/?utm_source=x")).toBe(
				"https://example.com",
			);
		});

		it("drops a bare ? with no query", () => {
			expect(normalizeUrl("https://example.com/a?")).toBe(
				"https://example.com/a",
			);
			expect(normalizeUrl("https://example.com/?")).toBe("https://example.com");
		});

		it("preserves param values exactly, including duplicates and = in values", () => {
			expect(normalizeUrl("https://example.com/a?q=a=b&q=c&utm_source=x")).toBe(
				"https://example.com/a?q=a=b&q=c",
			);
		});

		it("preserves original percent- and plus-encoding of kept params", () => {
			expect(normalizeUrl("https://example.com/a?q=a%20b&r=c+d&utm_id=1")).toBe(
				"https://example.com/a?q=a%20b&r=c+d",
			);
		});

		it("keeps empty pair segments as-is (&&)", () => {
			expect(normalizeUrl("https://example.com/a?b=1&&c=2")).toBe(
				"https://example.com/a?b=1&&c=2",
			);
		});
	});

	describe("trailing slash", () => {
		it("drops the root slash entirely (SPEC example)", () => {
			expect(normalizeUrl("https://x.com/")).toBe("https://x.com");
			expect(normalizeUrl("https://x.com")).toBe("https://x.com");
		});

		it("strips a single trailing slash from a non-root path", () => {
			expect(normalizeUrl("https://x.com/a/")).toBe("https://x.com/a");
			expect(normalizeUrl("https://x.com/a/b/")).toBe("https://x.com/a/b");
		});

		it("leaves paths ending in multiple slashes untouched (idempotency)", () => {
			// Stripping one of several slashes would not be idempotent
			// (/a// -> /a/ -> /a), and /a// is a different resource than /a.
			expect(normalizeUrl("https://x.com/a//")).toBe("https://x.com/a//");
			expect(normalizeUrl("https://x.com//")).toBe("https://x.com//");
		});

		it("keeps query params after slash stripping", () => {
			expect(normalizeUrl("https://x.com/a/?b=1")).toBe("https://x.com/a?b=1");
			expect(normalizeUrl("https://x.com/?b=1")).toBe("https://x.com?b=1");
		});
	});

	describe("ports", () => {
		it("drops default ports (the WHATWG parser's canonical form)", () => {
			expect(normalizeUrl("https://example.com:443/a")).toBe(
				"https://example.com/a",
			);
			expect(normalizeUrl("http://example.com:80/a")).toBe(
				"http://example.com/a",
			);
		});

		it("keeps non-default ports", () => {
			expect(normalizeUrl("http://localhost:3000/a/")).toBe(
				"http://localhost:3000/a",
			);
			expect(normalizeUrl("https://example.com:8443/")).toBe(
				"https://example.com:8443",
			);
		});
	});

	describe("userinfo", () => {
		it("preserves username and password", () => {
			expect(normalizeUrl("https://user:pass@example.com/a/")).toBe(
				"https://user:pass@example.com/a",
			);
			expect(normalizeUrl("https://user@example.com/")).toBe(
				"https://user@example.com",
			);
		});
	});

	describe("hosts and encoding", () => {
		it("punycode-encodes IDN hosts (parser canonical form)", () => {
			expect(normalizeUrl("https://münchen.de/straße")).toBe(
				"https://xn--mnchen-3ya.de/stra%C3%9Fe",
			);
		});

		it("keeps existing percent-encoding in paths stable", () => {
			expect(normalizeUrl("https://example.com/a%20b/c")).toBe(
				"https://example.com/a%20b/c",
			);
		});

		it("handles IPv6 hosts", () => {
			expect(normalizeUrl("https://[2001:DB8::1]:8080/a/")).toBe(
				"https://[2001:db8::1]:8080/a",
			);
		});
	});

	describe("non-http(s) schemes (Chrome bookmarks can contain these)", () => {
		it("chrome:// URLs survive with fragment stripped, otherwise untouched", () => {
			expect(normalizeUrl("chrome://flags/")).toBe("chrome://flags/");
			expect(normalizeUrl("chrome://settings/passwords#top")).toBe(
				"chrome://settings/passwords",
			);
		});

		it("about:blank passes through", () => {
			expect(normalizeUrl("about:blank")).toBe("about:blank");
		});

		it("javascript: URLs do not crash and keep their body", () => {
			expect(normalizeUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
			expect(normalizeUrl("javascript:void(0)#x")).toBe("javascript:void(0)");
		});

		it("data: URLs keep their payload (no query/slash munging)", () => {
			expect(normalizeUrl("data:text/plain,hello?utm_source=x")).toBe(
				"data:text/plain,hello?utm_source=x",
			);
			expect(normalizeUrl("data:text/html,<p>hi</p>#frag")).toBe(
				"data:text/html,<p>hi</p>",
			);
		});

		it("file: URLs keep their trailing slash and query", () => {
			expect(normalizeUrl("file:///Users/me/Notes/")).toBe(
				"file:///Users/me/Notes/",
			);
		});

		it("uppercase non-http schemes are lowercased by the parser", () => {
			expect(normalizeUrl("CHROME://flags/")).toBe("chrome://flags/");
		});
	});

	describe("whitespace", () => {
		it("trims surrounding whitespace before parsing", () => {
			expect(normalizeUrl("  https://example.com/a/  ")).toBe(
				"https://example.com/a",
			);
			expect(normalizeUrl("\thttps://example.com/\n")).toBe(
				"https://example.com",
			);
		});
	});

	describe("idempotency", () => {
		const samples = [
			"https://example.com/",
			"https://x.com/",
			"https://x.com/a/",
			"https://x.com/a//",
			"https://EXAMPLE.com:443/A/b/?utm_source=x&q=1&fbclid=2#frag",
			"HTTP://Sub.Example.COM:80/path/?UTM_CAMPAIGN=spring&keep=yes",
			"https://example.com/a?q=a%20b&r=c+d",
			"https://example.com/a?q=a=b&q=c",
			"https://user:pass@example.com:8443/x/",
			"https://münchen.de/straße?utm_source=x",
			"https://[2001:DB8::1]/a/",
			"chrome://flags/",
			"chrome://settings/passwords#top",
			"about:blank",
			"javascript:alert(1)#x",
			"data:text/plain,hello?utm_source=x#f",
			"file:///Users/me/Notes/",
			"mailto:someone@example.com?subject=hi",
			"not a url",
			"http://",
			"",
			"  https://example.com/a/?utm_source=t&b=1  ",
			"https://example.com/a?",
			"https://example.com/a?utm_source&b=1&&c=2",
		];

		it.each(samples)("normalizeUrl is idempotent for %j", (input) => {
			const once = normalizeUrl(input);
			expect(normalizeUrl(once)).toBe(once);
		});
	});
});
