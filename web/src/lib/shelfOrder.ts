// Pinned-shelf order composition — SPEC §9 "Shelf reordering (m21)". Pure, no
// DOM, no React: the contract shared by the feed's optimistic order override
// and its release-on-confirmation effect.
//
// The shelf's server order is `pin_position asc` (SPEC §8) and `pin_position`
// itself is never serialized — the array's order IS the contract. After a drop
// the client paints its own order at once and lets the `PUT /api/bookmarks/pinned`
// response (or the next poll) confirm it; `orderShelf` is what lays that
// override over whatever the server currently says, and what decides when the
// override may be released.

/**
 * The shelf `server` should render as, given a pending client order `override`
 * (a list of bookmark ids).
 *
 * - `override === null` → the server's own order, already `confirmed`.
 * - Otherwise: rows whose id the override lists come first, in the override's
 *   order; rows the override doesn't know about follow, in SERVER order (a pin
 *   made elsewhere mid-drag lands at the end, matching where a new pin goes —
 *   SPEC §8). Override ids the server no longer lists are ignored (unpinned
 *   from the popup, archived, …), as are duplicate ids.
 * - `confirmed` is true iff the resulting id sequence already equals the
 *   server's own — i.e. the server has caught up and the override can be
 *   dropped. Holding a confirmed override longer would mask a reorder made on
 *   the other surface (the extension's new tab shelf), exactly like the m13
 *   pin/unpin overlays.
 */
export function orderShelf<T extends { id: number }>(
	server: T[],
	override: number[] | null,
): { items: T[]; confirmed: boolean } {
	if (override === null) {
		return { items: server, confirmed: true };
	}

	const byId = new Map<number, T>();
	for (const row of server) {
		if (!byId.has(row.id)) {
			byId.set(row.id, row);
		}
	}

	const listed: T[] = [];
	const taken = new Set<number>();
	for (const id of override) {
		if (taken.has(id)) {
			continue;
		}
		const row = byId.get(id);
		if (row) {
			listed.push(row);
			taken.add(id);
		}
	}

	const items =
		listed.length === 0
			? server
			: [...listed, ...server.filter((row) => !taken.has(row.id))];

	// `items` is always a permutation of `server`, so equal lengths are given
	// and an index-wise id comparison is the whole test.
	const confirmed = items.every((row, i) => server[i]?.id === row.id);
	return { items, confirmed };
}

/**
 * `list` with the item at `fromIndex` moved to `toIndex`, immutably.
 *
 * Returns the SAME array reference when the move is a no-op (equal indexes) or
 * either index is out of range / not an integer — callers use that to skip a
 * pointless state write and a pointless PUT.
 */
export function moveItem<T>(
	list: T[],
	fromIndex: number,
	toIndex: number,
): T[] {
	if (
		fromIndex === toIndex ||
		!Number.isInteger(fromIndex) ||
		!Number.isInteger(toIndex) ||
		fromIndex < 0 ||
		toIndex < 0 ||
		fromIndex >= list.length ||
		toIndex >= list.length
	) {
		return list;
	}
	const next = [...list];
	const [moved] = next.splice(fromIndex, 1);
	next.splice(toIndex, 0, moved);
	return next;
}
