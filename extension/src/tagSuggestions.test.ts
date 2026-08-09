import { describe, expect, it } from "vitest";
import { filterTagSuggestions } from "./tagSuggestions";

describe("filterTagSuggestions", () => {
	it("returns nothing for an empty or whitespace-only draft", () => {
		const available = ["rust", "reading"];
		expect(filterTagSuggestions(available, [], "")).toEqual([]);
		expect(filterTagSuggestions(available, [], "   ")).toEqual([]);
		expect(filterTagSuggestions(available, [], "\t\n")).toEqual([]);
	});

	it("trims the draft before matching", () => {
		expect(filterTagSuggestions(["rust", "reading"], [], "  re  ")).toEqual([
			"reading",
		]);
	});

	it("matches case-insensitively in both directions", () => {
		expect(filterTagSuggestions(["Rust", "READING"], [], "r")).toEqual([
			"Rust",
			"READING",
		]);
		expect(filterTagSuggestions(["rust"], [], "RU")).toEqual(["rust"]);
	});

	it("ranks prefix matches before substring matches, source order within each", () => {
		const available = ["ai-safety", "safety", "sailing", "rust-safety", "sad"];
		expect(filterTagSuggestions(available, [], "sa")).toEqual([
			// prefix group, in source order
			"safety",
			"sailing",
			"sad",
			// substring group, in source order
			"ai-safety",
			"rust-safety",
		]);
	});

	it("excludes tags already applied, by exact string comparison", () => {
		const available = ["rust", "Rust", "reading"];
		expect(filterTagSuggestions(available, ["rust"], "r")).toEqual([
			// case differs → not the same tag, still suggested
			"Rust",
			"reading",
		]);
	});

	it("drops applied tags immediately as the local array grows", () => {
		const available = ["reading", "recipes", "rust"];
		expect(filterTagSuggestions(available, ["reading", "rust"], "r")).toEqual([
			"recipes",
		]);
	});

	it("caps the result at 8 by default and honors an explicit cap", () => {
		const available = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
		expect(filterTagSuggestions(available, [], "tag")).toEqual([
			"tag-0",
			"tag-1",
			"tag-2",
			"tag-3",
			"tag-4",
			"tag-5",
			"tag-6",
			"tag-7",
		]);
		expect(filterTagSuggestions(available, [], "tag", 3)).toEqual([
			"tag-0",
			"tag-1",
			"tag-2",
		]);
	});

	it("caps after exclusion, not before", () => {
		const available = Array.from({ length: 12 }, (_, i) => `tag-${i}`);
		const applied = ["tag-0", "tag-1", "tag-2"];
		expect(filterTagSuggestions(available, applied, "tag")).toEqual([
			"tag-3",
			"tag-4",
			"tag-5",
			"tag-6",
			"tag-7",
			"tag-8",
			"tag-9",
			"tag-10",
		]);
	});

	it("still suggests a tag the draft exactly equals", () => {
		expect(filterTagSuggestions(["rust", "rustacean"], [], "rust")).toEqual([
			"rust",
			"rustacean",
		]);
	});

	it("returns nothing when no tag matches", () => {
		expect(filterTagSuggestions(["rust", "reading"], [], "zzz")).toEqual([]);
		expect(filterTagSuggestions([], [], "rust")).toEqual([]);
	});
});
