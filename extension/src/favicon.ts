/**
 * Live-capture favicon lookup (SPEC §5/§6).
 *
 * Chrome hangs `favIconUrl` off the *tab*, never off the bookmark node, so a
 * live capture reads the page's own icon from whichever open tab is showing
 * the URL being saved. Without it the row keeps `favicon_url = null` and both
 * renderers fall back to a hostname-keyed icon service, which answers with the
 * DOMAIN's icon (calendar.google.com → the Google "G").
 *
 * Pure and dependency-injected like every other `src/` helper — no Chrome
 * imports — and total: any failure is simply "no favicon", never a thrown
 * enqueue. Backfill never calls this (SPEC §5: backfill carries no favicon).
 */

/** The one field of `chrome.tabs.Tab` this reads. */
export interface TabFavicon {
	favIconUrl?: string;
}

/** `chrome.tabs.query({ url })`, narrowed to what the lookup needs. */
export type QueryTabsByUrl = (url: string) => Promise<TabFavicon[]>;

/**
 * The `favIconUrl` of the first tab open on `url`, or undefined when there is
 * no such tab, no icon, or the query failed. The URL goes out RAW (hard rule
 * #3) — no validation happens here beyond "non-empty string"; the server
 * decides what is storable.
 */
export async function lookupTabFavicon(
	queryTabsByUrl: QueryTabsByUrl,
	url: string,
): Promise<string | undefined> {
	try {
		const tabs = await queryTabsByUrl(url);
		const favicon = tabs[0]?.favIconUrl;
		// Chrome reports an empty string for a page that declares no icon.
		return typeof favicon === "string" && favicon !== "" ? favicon : undefined;
	} catch {
		// `tabs.query` rejects on a URL Chrome won't take as a match pattern
		// (fragments, `chrome://`, `javascript:`) and on a missing permission.
		return undefined;
	}
}
