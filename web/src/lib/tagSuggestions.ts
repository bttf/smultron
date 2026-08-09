// Tag autocomplete filter — SPEC §9 (m14). Pure, no DOM, no React: the
// behavior contract shared by the feed panel's add-tag input and the
// extension popup's (each package keeps its own copy — deliberate, no shared
// workspace package for ~15 lines).

/**
 * Suggestions for `draft`, drawn from `available` (already ordered by usage —
 * source order is the tiebreak) minus the tags already on the bookmark.
 *
 * - Empty/whitespace draft → `[]` (the dropdown never opens on an empty input).
 * - Matching is case-insensitive; prefix matches rank before substring
 *   matches, each group keeping `available`'s order.
 * - `applied` exclusion is an EXACT string comparison — tags are exact
 *   strings, so a case variant of an applied tag is still suggestable.
 * - Result is capped at `cap`.
 */
export function filterTagSuggestions(
	available: string[],
	applied: string[],
	draft: string,
	cap = 8,
): string[] {
	const needle = draft.trim().toLowerCase();
	if (!needle) {
		return [];
	}

	const appliedSet = new Set(applied);
	const prefix: string[] = [];
	const substring: string[] = [];

	for (const tag of available) {
		if (appliedSet.has(tag)) {
			continue;
		}
		const lower = tag.toLowerCase();
		if (lower.startsWith(needle)) {
			prefix.push(tag);
		} else if (lower.includes(needle)) {
			substring.push(tag);
		}
	}

	return [...prefix, ...substring].slice(0, cap);
}
