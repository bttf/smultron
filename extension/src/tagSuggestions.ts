/**
 * Tag autocomplete filter (SPEC §9, shared behavior spec — web/ owns an
 * intentionally duplicated copy; no shared workspace package).
 *
 * Contract: the trimmed draft drives matching; an empty draft yields no
 * suggestions (the dropdown stays closed). Matching is case-insensitive,
 * prefix matches rank before substring matches, and `available`'s order
 * (server-side count desc / tag asc) is preserved within each group. Tags
 * already applied to the bookmark are excluded by exact string comparison —
 * the caller passes its live local array, so an added tag disappears from the
 * next recompute. Pure: no Chrome/DOM access.
 */
export function filterTagSuggestions(
	available: string[],
	applied: string[],
	draft: string,
	cap = 8,
): string[] {
	const query = draft.trim().toLowerCase();
	if (query === "") return [];

	const prefix: string[] = [];
	const substring: string[] = [];
	for (const tag of available) {
		if (applied.includes(tag)) continue;
		const index = tag.toLowerCase().indexOf(query);
		if (index === 0) prefix.push(tag);
		else if (index > 0) substring.push(tag);
	}
	return [...prefix, ...substring].slice(0, cap);
}
