import { describe, expect, it } from "vitest";
import {
	chunkText,
	countWords,
	MARKDOWN_SEPARATORS,
	PROSE_SEPARATORS,
} from "./chunk";

/** Every invariant chunkText promises, asserted in one place. */
function expectValidChunks(chunks: string[], limit: number) {
	for (const chunk of chunks) {
		expect(chunk.length).toBeLessThanOrEqual(limit);
		expect(chunk.trim()).not.toBe("");
	}
}

describe("chunkText", () => {
	it("returns [] for empty or whitespace-only input", () => {
		expect(chunkText("", { limit: 100 })).toEqual([]);
		expect(chunkText("   \n\n\t ", { limit: 100 })).toEqual([]);
	});

	it("returns a single trimmed chunk when the text already fits", () => {
		expect(chunkText("  hello world  ", { limit: 100 })).toEqual([
			"hello world",
		]);
	});

	it("rejects a non-positive or non-integer limit", () => {
		expect(() => chunkText("abc", { limit: 0 })).toThrow(RangeError);
		expect(() => chunkText("abc", { limit: -5 })).toThrow(RangeError);
		expect(() => chunkText("abc", { limit: 1.5 })).toThrow(RangeError);
	});

	describe("prose separators", () => {
		it("prefers paragraph gaps over sentence ends", () => {
			const text = "One. Two.\n\nThree. Four.";
			expect(chunkText(text, { limit: 14 })).toEqual([
				"One. Two.",
				"Three. Four.",
			]);
		});

		it("falls back to sentence ends when a paragraph is too long", () => {
			const text = "Alpha beta. Gamma delta. Epsilon zeta.";
			const chunks = chunkText(text, { limit: 25 });
			expectValidChunks(chunks, 25);
			// Never splits mid-sentence: each chunk ends a sentence.
			for (const chunk of chunks) {
				expect(chunk.endsWith(".")).toBe(true);
			}
			expect(chunks.join(" ")).toBe(text);
		});

		it("splits after a sentence end closed by a quote or bracket", () => {
			const text = 'He said "go." She left. Then it rained.';
			const chunks = chunkText(text, { limit: 22 });
			expectValidChunks(chunks, 22);
			expect(chunks[0]).toBe('He said "go."');
		});

		it("falls back to whitespace when one sentence exceeds the limit", () => {
			const text = "aa bb cc dd ee ff gg hh";
			const chunks = chunkText(text, { limit: 9 });
			expectValidChunks(chunks, 9);
			expect(chunks.join(" ")).toBe(text);
		});

		it("hard-slices text with no usable boundary at all", () => {
			const text = "x".repeat(25);
			const chunks = chunkText(text, { limit: 10 });
			expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
		});

		it("packs chunks as full as the boundaries allow", () => {
			// Five 8-char sentences ("Sentence." + space) under a 30 limit:
			// greedy packing fits three per chunk, not one.
			const text = Array.from({ length: 6 }, (_, i) => `Sent ${i}.`).join(" ");
			const chunks = chunkText(text, { limit: 30 });
			expectValidChunks(chunks, 30);
			expect(chunks.length).toBeLessThanOrEqual(3);
			expect(chunks.join(" ")).toBe(text);
		});

		it("is lossless modulo whitespace at the joins", () => {
			const text = Array.from(
				{ length: 200 },
				(_, i) => `This is sentence number ${i} in a long article.`,
			).join(" ");
			const chunks = chunkText(text, { limit: 500 });
			expectValidChunks(chunks, 500);
			expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(
				text.replace(/\s+/g, " "),
			);
		});

		it("uses PROSE_SEPARATORS by default", () => {
			const text = "One. Two.\n\nThree.";
			expect(chunkText(text, { limit: 12 })).toEqual(
				chunkText(text, { limit: 12, separators: PROSE_SEPARATORS }),
			);
		});
	});

	describe("markdown separators", () => {
		const opts = { limit: 40, separators: MARKDOWN_SEPARATORS };

		it("breaks before headings, keeping each heading with its body", () => {
			const md =
				"# One\n\nBody one.\n\n## Two\n\nBody two.\n\n## Three\n\nBody 3.";
			const chunks = chunkText(md, opts);
			expectValidChunks(chunks, 40);
			// Every chunk after the first starts at a heading.
			for (const chunk of chunks) {
				expect(chunk.startsWith("#")).toBe(true);
			}
		});

		it("falls back to blank lines within an over-long section", () => {
			const md = `# Long\n\n${"Paragraph text here.\n\n".repeat(6)}`;
			const chunks = chunkText(md, opts);
			expectValidChunks(chunks, 40);
			expect(chunks.length).toBeGreaterThan(1);
		});

		it("does not treat a '#' mid-line as a heading", () => {
			const md = "Issue #42 was fixed. Also issue #43 was fixed.";
			const chunks = chunkText(md, {
				limit: 200,
				separators: MARKDOWN_SEPARATORS,
			});
			expect(chunks).toEqual([md]);
		});

		it("keeps a fenced code block's lines together when they fit", () => {
			const md = "# T\n\n```js\nconst a = 1;\n```\n\nAfter.";
			expect(
				chunkText(md, { limit: 500, separators: MARKDOWN_SEPARATORS }),
			).toEqual([md]);
		});
	});

	describe("the TTS limit specifically", () => {
		// OpenAI /v1/audio/speech rejects input over 4096 characters.
		const TTS_LIMIT = 4096;

		it("keeps every segment within the API's hard cap", () => {
			const transcript = Array.from(
				{ length: 400 },
				(_, i) =>
					`This is sentence ${i} of a long spoken transcript that must be segmented before synthesis.`,
			).join(" ");
			const chunks = chunkText(transcript, { limit: TTS_LIMIT });
			expect(chunks.length).toBeGreaterThan(1);
			expectValidChunks(chunks, TTS_LIMIT);
		});
	});
});

describe("countWords", () => {
	it("counts whitespace-separated words", () => {
		expect(countWords("one two three")).toBe(3);
	});

	it("collapses runs of whitespace and ignores padding", () => {
		expect(countWords("  one \n\n two\tthree  ")).toBe(3);
	});

	it("is 0 for empty and whitespace-only input", () => {
		expect(countWords("")).toBe(0);
		expect(countWords("   \n ")).toBe(0);
	});
});
