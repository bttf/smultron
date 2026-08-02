import { describe, expect, it } from "vitest";
import { textFragmentUrl } from "./textFragment";

const PAGE = "https://example.com/article";

/** Parses out the `text=...` directive body from a built URL, split on the
 * (unescaped) `,` delimiter between textStart and textEnd, if present. */
function parseTextDirective(url: string): string[] {
	const marker = "#:~:text=";
	const idx = url.indexOf(marker);
	expect(idx).toBeGreaterThanOrEqual(0);
	const body = url.slice(idx + marker.length);
	return body.split(",");
}

describe("textFragmentUrl", () => {
	describe("short exact-match form", () => {
		it("builds text=<encoded> for a short selection", () => {
			const url = textFragmentUrl(PAGE, "hello world");
			expect(url).toBe(`${PAGE}#:~:text=hello%20world`);
		});

		it("uses the exact form right at the ~150 char boundary", () => {
			// Exactly 150 chars, made of whole words so no boundary logic kicks in.
			const words = "lorem ipsum dolor sit amet ".repeat(6); // 28*6=168, trim below
			const text = words.slice(0, 149).trimEnd();
			expect(text.length).toBeLessThanOrEqual(150);
			const url = textFragmentUrl(PAGE, text);
			const parts = parseTextDirective(url);
			expect(parts).toHaveLength(1);
			expect(decodeURIComponent(parts[0])).toBe(text);
		});
	});

	describe("long start,end form", () => {
		it("splits into textStart,textEnd on word boundaries, never mid-word", () => {
			// Build a long text of whole words well past the 150 char short limit.
			const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
			const text = words.join(" ");
			expect(text.length).toBeGreaterThan(150);

			const url = textFragmentUrl(PAGE, text);
			const [start, end] = parseTextDirective(url).map(decodeURIComponent);

			// Every excerpt must be composed of whole words from the source text
			// (split on the normalized single-space separator) — i.e. it must be
			// found as a substring bounded by word breaks, never a partial word.
			const wordSet = new Set(text.split(" "));
			for (const excerpt of [start, end]) {
				expect(text).toContain(excerpt);
				for (const w of excerpt.split(" ")) {
					expect(wordSet.has(w)).toBe(true);
				}
			}

			// textStart is a prefix of the source, textEnd is a suffix.
			expect(text.startsWith(start)).toBe(true);
			expect(text.endsWith(end)).toBe(true);
		});

		it("extends the prefix outward past the budget to avoid splitting a boundary word", () => {
			// The 60-char cut (index 60) lands inside `longWord` (indices 56-90),
			// so the prefix must extend forward to swallow it whole rather than
			// truncating it.
			const filler = "a".repeat(55);
			const longWord = "supercalifragilisticexpialidocious"; // 35 chars
			const text = `${filler} ${longWord} tail words here to pad length past one hundred fifty characters total for sure yes indeed`;
			expect(text.length).toBeGreaterThan(150);

			const url = textFragmentUrl(PAGE, text);
			const [start] = parseTextDirective(url).map(decodeURIComponent);

			expect(start.split(" ").at(-1)).toBe(longWord);
		});

		it("extends the suffix outward past the budget to avoid splitting a boundary word", () => {
			// Mirror of the prefix case: a long word straddles the cut point
			// counted from the end.
			const longWord = "supercalifragilisticexpialidocious"; // 35 chars
			const filler = "a".repeat(55);
			const text = `padding words at the start to push well past one hundred fifty characters total ${longWord} ${filler}`;
			expect(text.length).toBeGreaterThan(150);

			const url = textFragmentUrl(PAGE, text);
			const [, end] = parseTextDirective(url).map(decodeURIComponent);

			expect(end.split(" ")[0]).toBe(longWord);
		});
	});

	describe("delimiter escaping", () => {
		it("percent-encodes -, ,, and & within the text", () => {
			const url = textFragmentUrl(PAGE, "a-b,c&d");
			expect(url).toBe(`${PAGE}#:~:text=a%2Db%2Cc%26d`);
			expect(url).not.toMatch(/text=[^&]*[-,&]/);
		});

		it("round-trips a long selection containing delimiter characters", () => {
			const words = Array.from(
				{ length: 30 },
				(_, i) => `pre-fix${i},tail&more`,
			);
			const text = words.join(" ");
			const url = textFragmentUrl(PAGE, text);
			const [start, end] = parseTextDirective(url);
			// The raw (still-encoded) segments must contain no bare delimiter
			// characters — only their %XX escapes.
			expect(start).not.toMatch(/[-,&]/);
			expect(end).not.toMatch(/[-,&]/);
			expect(decodeURIComponent(start).length).toBeGreaterThan(0);
		});
	});

	describe("whitespace normalization", () => {
		it("collapses internal whitespace runs (including newlines) to single spaces", () => {
			const url = textFragmentUrl(PAGE, "hello\n\n  world\tfoo");
			expect(url).toBe(`${PAGE}#:~:text=hello%20world%20foo`);
		});

		it("trims leading/trailing whitespace before building", () => {
			const url = textFragmentUrl(PAGE, "   hello world   \n");
			expect(url).toBe(`${PAGE}#:~:text=hello%20world`);
		});
	});

	describe("existing fragment stripping", () => {
		it("strips an existing fragment on pageUrl before appending", () => {
			const url = textFragmentUrl(`${PAGE}#old-section`, "hello");
			expect(url).toBe(`${PAGE}#:~:text=hello`);
		});

		it("strips an empty existing fragment", () => {
			const url = textFragmentUrl(`${PAGE}#`, "hello");
			expect(url).toBe(`${PAGE}#:~:text=hello`);
		});
	});

	describe("single giant word", () => {
		it("takes an overlong single word whole rather than splitting it", () => {
			const giantWord = "x".repeat(200);
			const url = textFragmentUrl(PAGE, giantWord);
			const [start, end] = parseTextDirective(url).map(decodeURIComponent);
			expect(start).toBe(giantWord);
			expect(end).toBe(giantWord);
		});

		it("takes a long word bordering the excerpt budget whole", () => {
			const longWord = "y".repeat(80);
			const text = `${longWord} ${"filler word text to pad well past the short-form limit of one hundred fifty characters total yes indeed surely".repeat(2)}`;
			const url = textFragmentUrl(PAGE, text);
			const [start] = parseTextDirective(url).map(decodeURIComponent);
			// The first "word" of the excerpt must be the whole long word, not a
			// truncated prefix of it.
			expect(start.split(" ")[0]).toBe(longWord);
		});
	});

	describe("unicode", () => {
		it("round-trips unicode text through decodeURIComponent (short form)", () => {
			const text = "héllo wörld 日本語 emoji 🎉";
			const url = textFragmentUrl(PAGE, text);
			const [encoded] = parseTextDirective(url);
			expect(decodeURIComponent(encoded)).toBe(text);
		});

		it("round-trips unicode text through decodeURIComponent (long form)", () => {
			const words = Array.from(
				{ length: 30 },
				(_, i) => `日本語word${i}émoji🎉`,
			);
			const text = words.join(" ");
			const url = textFragmentUrl(PAGE, text);
			const [start, end] = parseTextDirective(url).map(decodeURIComponent);
			expect(text.startsWith(start)).toBe(true);
			expect(text.endsWith(end)).toBe(true);
		});
	});

	describe("empty text", () => {
		it("returns pageUrl unchanged for empty text", () => {
			expect(textFragmentUrl(PAGE, "")).toBe(PAGE);
		});

		it("returns pageUrl unchanged for whitespace-only text", () => {
			expect(textFragmentUrl(PAGE, "   \n\t  ")).toBe(PAGE);
		});
	});
});
