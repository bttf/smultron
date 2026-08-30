import { describe, expect, it, vi } from "vitest";
import type { NewTabBookmark } from "./newtab";
import { moveItem, putPinnedOrder } from "./pinOrder";

function bookmark(over: Partial<NewTabBookmark> = {}): NewTabBookmark {
	return {
		id: 1,
		url: "https://example.com/a",
		title: "A",
		faviconUrl: null,
		tags: [],
		updatedAt: "2026-08-30T10:00:00.000Z",
		...over,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const config = { token: "tok", baseUrl: "https://smultron.redpine.software" };

/** The request a mocked fetch actually received, typed for assertions. */
function firstCall(fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit] {
	const call = fetchImpl.mock.calls[0];
	if (call === undefined) throw new Error("fetch was never called");
	return call as [string, RequestInit];
}

describe("moveItem", () => {
	it("moves an item forward, closing the gap behind it", () => {
		expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
	});

	it("moves an item backward, pushing the target slot along", () => {
		expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
	});

	it("moves an item to either end", () => {
		expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
		expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
	});

	it("is a no-op when the indexes are equal", () => {
		expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
	});

	it("is a no-op for an out-of-range index in either position", () => {
		// A dragover can name a card that is no longer in the order (a pin
		// removed under the gesture); that must cost the move, not the shelf.
		expect(moveItem(["a", "b", "c"], -1, 1)).toEqual(["a", "b", "c"]);
		expect(moveItem(["a", "b", "c"], 3, 1)).toEqual(["a", "b", "c"]);
		expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["a", "b", "c"]);
		expect(moveItem(["a", "b", "c"], 1, 3)).toEqual(["a", "b", "c"]);
	});

	it("handles an empty list", () => {
		expect(moveItem([], 0, 0)).toEqual([]);
		expect(moveItem([], 0, 1)).toEqual([]);
	});

	it("never mutates the input and never returns it", () => {
		const list = ["a", "b", "c"];
		// Every path returns a fresh array, so callers can assign the result
		// unconditionally (documented contract).
		expect(moveItem(list, 0, 2)).not.toBe(list);
		expect(moveItem(list, 1, 1)).not.toBe(list);
		expect(moveItem(list, 9, 1)).not.toBe(list);
		expect(list).toEqual(["a", "b", "c"]);
	});

	it("is idempotent once the item already sits in the target slot", () => {
		// Every dragover re-runs the move; once the card is in place `from`
		// equals `to` and the order stops changing.
		const once = moveItem(["a", "b", "c", "d"], 0, 2);
		expect(moveItem(once, 2, 2)).toEqual(once);
	});
});

describe("putPinnedOrder", () => {
	it("PUTs the full id order with the pairing token", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pinned: [] }));

		const result = await putPinnedOrder(config, fetchImpl as never, [3, 1, 2]);

		expect(result.ok).toBe(true);
		const [url, init] = firstCall(fetchImpl);
		expect(url).toBe("https://smultron.redpine.software/api/bookmarks/pinned");
		expect(init.method).toBe("PUT");
		expect(init.headers).toEqual({
			Authorization: "Bearer tok",
			"Content-Type": "application/json",
		});
		expect(init.body).toBe('{"ids":[3,1,2]}');
	});

	it("returns the server's shelf in its new order", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				pinned: [
					{ id: 3, url: "https://c.test/", title: "C", tags: ["x"] },
					{ id: 1, url: "https://a.test/", title: "A", tags: [] },
				],
			}),
		);

		const result = await putPinnedOrder(config, fetchImpl as never, [3, 1]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pinned.map((b) => b.id)).toEqual([3, 1]);
		expect(result.pinned[0]).toEqual(
			bookmark({
				id: 3,
				url: "https://c.test/",
				title: "C",
				tags: ["x"],
				updatedAt: "",
			}),
		);
	});

	it("drops a junk row instead of failing the whole commit", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				pinned: [
					{ id: 1, url: "https://a.test/" },
					{ id: "nope", url: "https://bad.test/" },
					null,
				],
			}),
		);

		const result = await putPinnedOrder(config, fetchImpl as never, [1]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pinned.map((b) => b.id)).toEqual([1]);
	});

	it("treats a body without a shelf as an empty shelf, never a throw", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null));
		const result = await putPinnedOrder(config, fetchImpl as never, [1]);
		expect(result).toEqual({ ok: true, pinned: [] });
	});

	it("reports 401 as the revoked-token signal", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
		const result = await putPinnedOrder(config, fetchImpl as never, [1, 2]);
		expect(result).toEqual({ ok: false, status: 401 });
	});

	it("reports any other status distinguishably", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
		expect(await putPinnedOrder(config, fetchImpl as never, [1])).toEqual({
			ok: false,
			status: 500,
		});
		const bad = vi.fn().mockResolvedValue(jsonResponse({}, 400));
		expect(await putPinnedOrder(config, bad as never, [1])).toEqual({
			ok: false,
			status: 400,
		});
	});

	it("reports a network failure as status null with the message", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
		const result = await putPinnedOrder(config, fetchImpl as never, [1]);
		expect(result).toEqual({ ok: false, status: null, message: "offline" });
	});

	it("reports a malformed body as a network-class failure, never a throw", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("<html>", { status: 200 }));
		const result = await putPinnedOrder(config, fetchImpl as never, [1]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBeNull();
	});

	it("sends an empty list as an empty list rather than omitting it", async () => {
		// The server validates the body; the client never second-guesses it.
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pinned: [] }));
		await putPinnedOrder(config, fetchImpl as never, []);
		expect(firstCall(fetchImpl)[1].body).toBe('{"ids":[]}');
	});
});
