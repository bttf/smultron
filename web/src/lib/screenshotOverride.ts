// Release of the cleared-screenshot override — SPEC §9 "Clear screenshot"
// (RED-206). Pure, no DOM, no React: the same released-on-confirmation
// contract the m13 pin overlays and the m21 order override follow
// (`shelfOrder.ts`), applied to the feed's `overrides` map.
//
// Clearing a screenshot paints `screenshotUrl: null` over the row at once so
// the card reverts without waiting for a poll. That overlay must NOT outlive
// the server's agreement: the extension backfills a screenshot for any row
// that has none, so a permanent override would spread `null` over the new URL
// on every later poll and the card would stay plain until a reload.

/**
 * `overrides` with the `screenshotUrl: null` entry dropped from every row the
 * server now agrees has no screenshot.
 *
 * - Only a `null` override is releasable — it is the only one this feature
 *   writes, and a non-null value means some other patch put it there.
 * - Only the `screenshotUrl` key is removed; a pending title/tags/note
 *   override on the same row survives. An entry left with no keys is dropped
 *   whole rather than kept as an empty patch.
 * - A server row that still carries a URL confirms nothing (a poll that raced
 *   the DELETE), so the override stands and the card never flicks back.
 * - Returns the SAME map when nothing was released, so a React caller can set
 *   state unconditionally without re-rendering.
 */
export function releaseClearedScreenshots<
	T extends { screenshotUrl?: string | null },
>(
	overrides: Map<number, T>,
	serverRows: Iterable<{ id: number; screenshotUrl: string | null }>,
): Map<number, T> {
	const cleared = new Set<number>();
	for (const row of serverRows) {
		if (row.screenshotUrl === null) {
			cleared.add(row.id);
		}
	}

	let next: Map<number, T> | null = null;
	for (const [id, patch] of overrides) {
		if (patch.screenshotUrl !== null || !("screenshotUrl" in patch)) {
			continue;
		}
		if (!cleared.has(id)) {
			continue;
		}
		next ??= new Map(overrides);
		const rest = { ...patch };
		delete rest.screenshotUrl;
		if (Object.keys(rest).length === 0) {
			next.delete(id);
		} else {
			next.set(id, rest);
		}
	}

	return next ?? overrides;
}
