import { describe, expect, it } from "vitest";
import { chunk, flattenTree, resolveFolderPath, type TreeNode } from "./tree";

/** Chrome-like tree: invisible root (empty title) with top-level folders. */
function chromeTree(): TreeNode[] {
	return [
		{
			id: "0",
			title: "",
			children: [
				{
					id: "1",
					title: "Bookmarks Bar",
					children: [
						{
							id: "10",
							title: "Top level",
							url: "https://top.example",
							dateAdded: 1_000,
						},
						{
							id: "11",
							title: "Dev",
							children: [
								{
									id: "12",
									title: "Postgres",
									children: [
										{
											id: "13",
											title: "Deep bookmark",
											url: "https://deep.example/docs?x=1",
											dateAdded: 2_000,
										},
									],
								},
								{ id: "14", title: "Empty folder", children: [] },
							],
						},
					],
				},
				{
					id: "2",
					title: "Other Bookmarks",
					children: [
						{ id: "20", title: "Other", url: "https://other.example" },
					],
				},
			],
		},
	];
}

describe("flattenTree", () => {
	it("flattens depth-first, skipping folders and capturing folder paths", () => {
		expect(flattenTree(chromeTree())).toEqual([
			{
				url: "https://top.example",
				title: "Top level",
				chromeId: "10",
				dateAddedMs: 1_000,
				folderPath: "Bookmarks Bar",
			},
			{
				url: "https://deep.example/docs?x=1",
				title: "Deep bookmark",
				chromeId: "13",
				dateAddedMs: 2_000,
				folderPath: "Bookmarks Bar/Dev/Postgres",
			},
			{
				url: "https://other.example",
				title: "Other",
				chromeId: "20",
				folderPath: "Other Bookmarks",
			},
		]);
	});

	it("excludes the empty-title root from paths and omits dateAddedMs when absent", () => {
		const flat = flattenTree(chromeTree());
		for (const bookmark of flat) {
			expect(bookmark.folderPath?.startsWith("/")).toBe(false);
		}
		const other = flat.find((b) => b.chromeId === "20");
		expect(other).toBeDefined();
		expect(other).not.toHaveProperty("dateAddedMs");
	});

	it("omits folderPath for a bookmark directly under the empty-title root", () => {
		const roots: TreeNode[] = [
			{
				id: "0",
				title: "",
				children: [
					{ id: "1", title: "Rootless", url: "https://rootless.example" },
				],
			},
		];
		expect(flattenTree(roots)).toEqual([
			{ url: "https://rootless.example", title: "Rootless", chromeId: "1" },
		]);
	});

	it("returns an empty list for a tree with only folders", () => {
		const roots: TreeNode[] = [
			{
				id: "0",
				title: "",
				children: [{ id: "1", title: "Bookmarks Bar", children: [] }],
			},
		];
		expect(flattenTree(roots)).toEqual([]);
	});
});

describe("chunk", () => {
	it("chunks >500 bookmarks into batches of at most 500, preserving order", () => {
		const many: TreeNode[] = Array.from({ length: 1_234 }, (_, i) => ({
			id: `b${i}`,
			title: `Bookmark ${i}`,
			url: `https://example.com/${i}`,
		}));
		const flat = flattenTree([
			{
				id: "0",
				title: "",
				children: [{ id: "1", title: "Bar", children: many }],
			},
		]);
		expect(flat).toHaveLength(1_234);

		const batches = chunk(flat, 500);
		expect(batches.map((b) => b.length)).toEqual([500, 500, 234]);
		expect(batches[0]?.[0]?.chromeId).toBe("b0");
		expect(batches[1]?.[0]?.chromeId).toBe("b500");
		expect(batches[2]?.at(-1)?.chromeId).toBe("b1233");
	});

	it("returns no batches for an empty list", () => {
		expect(chunk([], 500)).toEqual([]);
	});
});

describe("resolveFolderPath", () => {
	const nodes: Record<string, TreeNode> = {
		"0": { id: "0", title: "" },
		"1": { id: "1", title: "Bookmarks Bar", parentId: "0" },
		"2": { id: "2", title: "Dev", parentId: "1" },
		"3": { id: "3", title: "Postgres", parentId: "2" },
	};
	const getNode = async (id: string): Promise<TreeNode | undefined> =>
		nodes[id];

	it("walks the parent chain and joins titled ancestors with '/'", async () => {
		await expect(resolveFolderPath(getNode, "3")).resolves.toBe(
			"Bookmarks Bar/Dev/Postgres",
		);
	});

	it("excludes the empty-title root", async () => {
		await expect(resolveFolderPath(getNode, "1")).resolves.toBe(
			"Bookmarks Bar",
		);
	});

	it("returns undefined when the parent is the root or missing", async () => {
		await expect(resolveFolderPath(getNode, "0")).resolves.toBeUndefined();
		await expect(
			resolveFolderPath(getNode, undefined),
		).resolves.toBeUndefined();
		await expect(
			resolveFolderPath(getNode, "missing"),
		).resolves.toBeUndefined();
	});
});
