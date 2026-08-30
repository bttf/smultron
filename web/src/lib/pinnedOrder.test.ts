import { describe, expect, it } from "vitest";
import { pinnedOrderBodySchema } from "./pinnedOrder";

describe("pinnedOrderBodySchema (PUT /api/bookmarks/pinned, m21)", () => {
	it("accepts a list of distinct positive integer ids", () => {
		const parsed = pinnedOrderBodySchema.safeParse({ ids: [3, 1, 2] });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.ids).toEqual([3, 1, 2]);
	});

	it("rejects an empty list", () => {
		expect(pinnedOrderBodySchema.safeParse({ ids: [] }).success).toBe(false);
	});

	it("rejects duplicates (a client bug, not a race)", () => {
		expect(pinnedOrderBodySchema.safeParse({ ids: [1, 2, 1] }).success).toBe(
			false,
		);
	});

	it("rejects non-integer, zero, negative and non-numeric ids", () => {
		for (const ids of [[1.5], [0], [-1], ["1"], [null]]) {
			expect(pinnedOrderBodySchema.safeParse({ ids }).success).toBe(false);
		}
	});

	it("rejects unknown fields and a missing ids key", () => {
		expect(
			pinnedOrderBodySchema.safeParse({ ids: [1], extra: true }).success,
		).toBe(false);
		expect(pinnedOrderBodySchema.safeParse({}).success).toBe(false);
	});

	it("caps the list at 1000 ids", () => {
		const ok = Array.from({ length: 1000 }, (_, i) => i + 1);
		expect(pinnedOrderBodySchema.safeParse({ ids: ok }).success).toBe(true);
		expect(
			pinnedOrderBodySchema.safeParse({ ids: [...ok, 1001] }).success,
		).toBe(false);
	});
});
