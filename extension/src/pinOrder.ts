/**
 * Pinned-shelf reordering (m21, SPEC §6/§8) — the new tab page's ONE write.
 *
 * `newtab.ts` promises in its header that everything it holds is read-only, so
 * the reorder request lives here instead: a pure `moveItem` (what the live
 * drag reflow is made of) plus the single `PUT /api/bookmarks/pinned` a commit
 * sends. Chrome-free and fetch-injected like `fetchBookmarksPage`, so both are
 * unit-testable without a browser.
 *
 * The request is direct, never the outbox: the new tab page is a surface with
 * a user present, and a reorder must report its own outcome truthfully.
 */

import {
	asBookmarkList,
	type NewTabBookmark,
	type NewTabConfig,
} from "./newtab";

/**
 * `list` with the item at `fromIndex` moved to `toIndex`, as the shelf reflows
 * while a dragged card crosses its neighbours (SPEC §6).
 *
 * ALWAYS returns a new array and never mutates `list`. A no-op move (equal
 * indexes) or an out-of-range index yields an equal copy rather than the same
 * reference, so callers can assign the result unconditionally.
 */
export function moveItem<T>(
	list: readonly T[],
	fromIndex: number,
	toIndex: number,
): T[] {
	const next = list.slice();
	if (fromIndex === toIndex) return next;
	if (fromIndex < 0 || fromIndex >= list.length) return next;
	if (toIndex < 0 || toIndex >= list.length) return next;
	const moved = next.splice(fromIndex, 1);
	next.splice(toIndex, 0, ...moved);
	return next;
}

export type PutPinnedOrderResult =
	| { ok: true; pinned: NewTabBookmark[] }
	| { ok: false; status: number }
	| { ok: false; status: null; message: string };

/**
 * Commit a shelf order: ONE `PUT /api/bookmarks/pinned` with the pairing token
 * (SPEC §8), body `{ids}` = every pinned id in the order the shelf should take.
 *
 * `200` returns the whole shelf in its new order, parsed with the same tolerant
 * row reader the listing uses — one junk row costs that row, never the commit.
 * `401` is the revoked-token signal (the page falls back to the unpaired
 * prompt); every other status and a thrown fetch are distinguishable failures,
 * exactly as in `fetchBookmarksPage`.
 */
export async function putPinnedOrder(
	config: NewTabConfig,
	fetchImpl: typeof fetch,
	ids: number[],
): Promise<PutPinnedOrderResult> {
	try {
		const response = await fetchImpl(`${config.baseUrl}/api/bookmarks/pinned`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${config.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ids }),
		});
		if (!response.ok) return { ok: false, status: response.status };
		const body = ((await response.json()) ?? {}) as Record<string, unknown>;
		return { ok: true, pinned: asBookmarkList(body.pinned) };
	} catch (error) {
		return {
			ok: false,
			status: null,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
