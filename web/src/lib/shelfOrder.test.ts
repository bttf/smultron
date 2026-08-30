import { describe, expect, it } from "vitest";
import { moveItem, orderShelf } from "./shelfOrder";

type Row = { id: number; title: string };

const row = (id: number): Row => ({ id, title: `b${id}` });
const ids = <T extends { id: number }>(rows: T[]) => rows.map((r) => r.id);

// Stands in for the server's `pinned` array — order IS the contract (SPEC §8).
const SERVER: Row[] = [row(1), row(2), row(3), row(4)];

describe("orderShelf", () => {
	it("returns the server order untouched, already confirmed, with no override", () => {
		const result = orderShelf(SERVER, null);
		expect(result.items).toBe(SERVER);
		expect(result.confirmed).toBe(true);
	});

	it("applies a full permutation", () => {
		const result = orderShelf(SERVER, [3, 1, 4, 2]);
		expect(ids(result.items)).toEqual([3, 1, 4, 2]);
		expect(result.confirmed).toBe(false);
	});

	it("keeps the rows themselves, not copies", () => {
		const result = orderShelf(SERVER, [2, 1, 3, 4]);
		expect(result.items[0]).toBe(SERVER[1]);
		expect(result.items[1]).toBe(SERVER[0]);
	});

	it("does not mutate the server array", () => {
		const server = [...SERVER];
		orderShelf(server, [4, 3, 2, 1]);
		expect(ids(server)).toEqual([1, 2, 3, 4]);
	});

	it("appends server rows the override doesn't list, in SERVER order", () => {
		// The override only knows 3 and 1 (say it predates two popup pins).
		const result = orderShelf(SERVER, [3, 1]);
		expect(ids(result.items)).toEqual([3, 1, 2, 4]);
		expect(result.confirmed).toBe(false);
	});

	it("ignores override ids the server no longer lists", () => {
		// 99 was unpinned from the extension popup mid-drag.
		const result = orderShelf(SERVER, [99, 4, 1, 2, 3]);
		expect(ids(result.items)).toEqual([4, 1, 2, 3]);
	});

	it("ignores duplicate ids in the override", () => {
		const result = orderShelf(SERVER, [2, 2, 1, 2]);
		expect(ids(result.items)).toEqual([2, 1, 3, 4]);
	});

	it("falls back to the server order when the override lists nothing it has", () => {
		const result = orderShelf(SERVER, [98, 99]);
		expect(ids(result.items)).toEqual([1, 2, 3, 4]);
		expect(result.confirmed).toBe(true);
	});

	it("always returns a permutation of the server rows", () => {
		for (const override of [[4, 3, 2, 1], [3], [99, 2], [], [1, 2, 3, 4]]) {
			const result = orderShelf(SERVER, override);
			expect([...ids(result.items)].sort()).toEqual([1, 2, 3, 4]);
		}
	});

	describe("confirmed", () => {
		it("is true once the server's own order matches the override", () => {
			const server = [row(3), row(1), row(4), row(2)];
			expect(orderShelf(server, [3, 1, 4, 2]).confirmed).toBe(true);
		});

		it("is true when the override is a prefix the server already agrees with", () => {
			// Override knows 1 and 2; the server lists them first anyway.
			expect(orderShelf(SERVER, [1, 2]).confirmed).toBe(true);
		});

		it("is false while the server still shows the pre-drag order", () => {
			expect(orderShelf(SERVER, [2, 1, 3, 4]).confirmed).toBe(false);
		});

		it("is true for an override that only names ids the server dropped", () => {
			expect(orderShelf(SERVER, [99]).confirmed).toBe(true);
		});

		it("is decided by the composed order, not by list equality", () => {
			// The override wants 4 first; the server puts it last — the shelf
			// renders 4,1,2,3 which is NOT the server order, so: unconfirmed.
			const result = orderShelf(SERVER, [4]);
			expect(ids(result.items)).toEqual([4, 1, 2, 3]);
			expect(result.confirmed).toBe(false);
		});

		it("stays unconfirmed when a new pin lands and the override is still pending", () => {
			// Server caught up on 1..4 but a fifth pin arrived; it trails, so
			// the composed order equals the server's — confirmed.
			const server = [row(3), row(1), row(4), row(2), row(5)];
			expect(orderShelf(server, [3, 1, 4, 2]).confirmed).toBe(true);
			// …but if the new pin landed in the MIDDLE of the server order the
			// override still has work to do.
			const shuffled = [row(3), row(5), row(1), row(4), row(2)];
			const result = orderShelf(shuffled, [3, 1, 4, 2]);
			expect(ids(result.items)).toEqual([3, 1, 4, 2, 5]);
			expect(result.confirmed).toBe(false);
		});
	});

	describe("empty inputs", () => {
		it("handles an empty server list", () => {
			expect(orderShelf([], [1, 2])).toEqual({ items: [], confirmed: true });
			expect(orderShelf<Row>([], null)).toEqual({
				items: [],
				confirmed: true,
			});
		});

		it("handles an empty override", () => {
			const result = orderShelf(SERVER, []);
			expect(ids(result.items)).toEqual([1, 2, 3, 4]);
			expect(result.confirmed).toBe(true);
		});

		it("handles a single-row shelf", () => {
			const server = [row(7)];
			expect(orderShelf(server, [7]).confirmed).toBe(true);
			expect(ids(orderShelf(server, [7]).items)).toEqual([7]);
		});
	});
});

describe("moveItem", () => {
	const LIST = ["a", "b", "c", "d"];

	it("moves an item forward", () => {
		expect(moveItem(LIST, 0, 2)).toEqual(["b", "c", "a", "d"]);
	});

	it("moves an item backward", () => {
		expect(moveItem(LIST, 3, 1)).toEqual(["a", "d", "b", "c"]);
	});

	it("moves an item to the end and to the front", () => {
		expect(moveItem(LIST, 0, 3)).toEqual(["b", "c", "d", "a"]);
		expect(moveItem(LIST, 3, 0)).toEqual(["d", "a", "b", "c"]);
	});

	it("does not mutate the input", () => {
		const list = [...LIST];
		moveItem(list, 0, 3);
		expect(list).toEqual(["a", "b", "c", "d"]);
	});

	it("returns the SAME reference for equal indexes", () => {
		expect(moveItem(LIST, 2, 2)).toBe(LIST);
	});

	it("returns the SAME reference for out-of-range indexes", () => {
		expect(moveItem(LIST, -1, 2)).toBe(LIST);
		expect(moveItem(LIST, 2, -1)).toBe(LIST);
		expect(moveItem(LIST, 4, 0)).toBe(LIST);
		expect(moveItem(LIST, 0, 4)).toBe(LIST);
		expect(moveItem(LIST, 99, 99)).toBe(LIST);
	});

	it("returns the SAME reference for non-integer indexes", () => {
		expect(moveItem(LIST, 1.5, 2)).toBe(LIST);
		expect(moveItem(LIST, 0, Number.NaN)).toBe(LIST);
	});

	it("returns the SAME reference for an empty list", () => {
		const empty: string[] = [];
		expect(moveItem(empty, 0, 0)).toBe(empty);
		expect(moveItem(empty, 0, 1)).toBe(empty);
	});

	it("round-trips a move and its inverse", () => {
		expect(moveItem(moveItem(LIST, 0, 3), 3, 0)).toEqual(LIST);
	});

	it("composes with orderShelf: the moved order becomes the override", () => {
		const next = moveItem(SERVER, 0, 2);
		const override = ids(next);
		expect(override).toEqual([2, 3, 1, 4]);
		const result = orderShelf(SERVER, override);
		expect(ids(result.items)).toEqual([2, 3, 1, 4]);
		expect(result.confirmed).toBe(false);
		// …and once the server returns that order, the override is released.
		expect(orderShelf(next, override).confirmed).toBe(true);
	});
});
