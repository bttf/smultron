import { describe, expect, it } from "vitest";
import { filterTagSuggestions } from "./tagSuggestions";

// Source order stands in for usage order (count desc, tag asc) everywhere.
const AVAILABLE = ["react", "reading", "preact", "rust", "Research"];

describe("filterTagSuggestions", () => {
	it("returns [] for an empty or whitespace-only draft", () => {
		expect(filterTagSuggestions(AVAILABLE, [], "")).toEqual([]);
		expect(filterTagSuggestions(AVAILABLE, [], "   ")).toEqual([]);
		expect(filterTagSuggestions(AVAILABLE, [], "\t\n")).toEqual([]);
	});

	it("trims the draft before matching", () => {
		expect(filterTagSuggestions(AVAILABLE, [], "  rust  ")).toEqual(["rust"]);
	});

	it("matches case-insensitively in both directions", () => {
		expect(filterTagSuggestions(AVAILABLE, [], "RE")).toEqual([
			"react",
			"reading",
			"Research",
			"preact",
		]);
		expect(filterTagSuggestions(["Rust"], [], "rus")).toEqual(["Rust"]);
	});

	it("ranks prefix matches before substring matches, source order within each", () => {
		// `preact` leads the source order but only matches as a substring, so
		// both prefix matches outrank it.
		const available = ["preact", "react", "unreadable", "reading"];
		expect(filterTagSuggestions(available, [], "rea")).toEqual([
			"react",
			"reading",
			"preact",
			"unreadable",
		]);
	});

	it("excludes tags already applied, by exact string comparison", () => {
		expect(filterTagSuggestions(AVAILABLE, ["react"], "rea")).toEqual([
			"reading",
			"preact",
		]);
		// Case variants are DIFFERENT tags — "research" applied does not
		// exclude the available "Research".
		expect(filterTagSuggestions(AVAILABLE, ["research"], "rese")).toEqual([
			"Research",
		]);
	});

	it("caps the result (default 8, overridable)", () => {
		const many = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
		expect(filterTagSuggestions(many, [], "tag")).toHaveLength(8);
		expect(filterTagSuggestions(many, [], "tag")).toEqual(many.slice(0, 8));
		expect(filterTagSuggestions(many, [], "tag", 3)).toEqual(many.slice(0, 3));
		expect(filterTagSuggestions(many, [], "tag", 0)).toEqual([]);
	});

	it("keeps the cap's prefix-first ranking (substrings only fill leftovers)", () => {
		const available = ["ax", "bax", "ay", "bay", "az"];
		expect(filterTagSuggestions(available, [], "a", 4)).toEqual([
			"ax",
			"ay",
			"az",
			"bax",
		]);
	});

	it("still suggests a tag the draft exactly equals", () => {
		expect(filterTagSuggestions(AVAILABLE, [], "rust")).toEqual(["rust"]);
		// `preact` tags along — it contains "react" — but the exact tag leads.
		expect(filterTagSuggestions(AVAILABLE, [], "REACT")).toEqual([
			"react",
			"preact",
		]);
	});

	it("returns [] when nothing matches or there is nothing to match against", () => {
		expect(filterTagSuggestions(AVAILABLE, [], "zzz")).toEqual([]);
		expect(filterTagSuggestions([], [], "rea")).toEqual([]);
		// Every match already applied.
		expect(filterTagSuggestions(["rust"], ["rust"], "rus")).toEqual([]);
	});
});
