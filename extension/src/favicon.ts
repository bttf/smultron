/**
 * Live-capture favicon lookup (SPEC §5/§6).
 *
 * Chrome hangs `favIconUrl` off the *tab*, never off the bookmark node, so a
 * live capture reads the page's own icon from whichever open tab is showing
 * the URL being saved. Without it the row keeps `favicon_url = null` and both
 * renderers fall back to a hostname-keyed icon service, which answers with the
 * DOMAIN's icon (calendar.google.com → the Google "G").
 *
 * The tab is found by listing ALL tabs and comparing `tab.url` as a STRING —
 * deliberately not `chrome.tabs.query({ url })`, whose argument is a MATCH
 * PATTERN, not a URL:
 *   - a pattern containing `#` matches nothing (Chromium matches the path
 *     against `GURL::PathForRequest()`, which has no fragment), and returns
 *     `[]` rather than throwing — so every SPA route bookmark
 *     (`mail.google.com/mail/u/0/#inbox`, `docs.google.com/…/edit#gid=0`)
 *     would silently get no favicon;
 *   - a `*` in the URL would act as a wildcard and could pull an unrelated
 *     tab's icon;
 *   - userinfo (`https://u@host/`) is not a valid pattern at all.
 * String equality has none of those semantics.
 *
 * Pure and dependency-injected like every other `src/` helper — no Chrome
 * imports — and total: any failure is simply "no favicon", never a thrown
 * enqueue. Backfill never calls this (SPEC §5: backfill carries no favicon).
 */

/** The fields of `chrome.tabs.Tab` this reads. */
export interface TabFavicon {
	url?: string;
	favIconUrl?: string;
	active?: boolean;
}

/** `chrome.tabs.query({})` — every tab in every window. */
export type QueryAllTabs = () => Promise<TabFavicon[]>;

/**
 * The favicon of an open tab showing exactly `url`, or undefined when there is
 * no such tab, none of them has an icon, or the query failed. Active tabs are
 * preferred when several tabs share the URL — the one the user is looking at
 * is the one they just bookmarked.
 *
 * The value goes out RAW: no validation beyond "non-empty string" happens
 * here (hard rule #3's spirit — the server decides what is storable).
 */
export async function lookupTabFavicon(
	queryAllTabs: QueryAllTabs,
	url: string,
): Promise<string | undefined> {
	try {
		const tabs = await queryAllTabs();
		const matches = tabs.filter((tab) => tab.url === url);
		// Stable partition, active first; `filter` preserves tab order within
		// each group so ties fall back to "first tab Chrome listed".
		const ordered = [
			...matches.filter((tab) => tab.active === true),
			...matches.filter((tab) => tab.active !== true),
		];
		for (const tab of ordered) {
			const favicon = tab.favIconUrl;
			// Chrome reports an empty string for a page that declares no icon;
			// another tab on the same URL may still have one.
			if (typeof favicon === "string" && favicon !== "") return favicon;
		}
		return undefined;
	} catch {
		// `tabs.query` rejects when the permission is missing or the extension
		// context is tearing down. No favicon, never a failure.
		return undefined;
	}
}
