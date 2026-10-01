// The `snapshot` unlisted script (m25, SPEC §17.7 step 1). The service worker
// injects it into the active tab's top frame with
// `chrome.scripting.executeScript({ files: ["/snapshot.js"] })`, ONLY after
// the user clicks Snapshot in the popup (§17.1). Nothing else injects it.
//
// It runs in the isolated world: the page's DOM, plus a `fetch` that is
// same-origin with the user's session (what reddit's `.json` endpoints need).
// WXT builds it as an IIFE whose completion value is `main()`'s return value,
// and Chrome awaits a returned promise, so `executeScript` resolves with the
// string returned below.

import { collectMetadata, runAdapter } from "@/src/adapters";
import {
	DISABLED_ADAPTERS_KEY,
	encodePageCapture,
	encodePageCaptureError,
	parseDisabledAdapters,
} from "@/src/snapshot";

/**
 * The adapters switched off in Options (§17.5). Content scripts can read
 * `chrome.storage.sync` directly; a failed read means nothing is disabled.
 */
async function readDisabledAdapters(): Promise<string[]> {
	try {
		const stored = await browser.storage.sync.get(DISABLED_ADAPTERS_KEY);
		return parseDisabledAdapters(stored[DISABLED_ADAPTERS_KEY]);
	} catch {
		return [];
	}
}

export default defineUnlistedScript(async (): Promise<string> => {
	try {
		// The DOM as it is at the click: metadata and raw HTML first, then the
		// adapter, which may spend seconds on same-origin requests.
		const metadata = collectMetadata(document);
		const html = document.documentElement.outerHTML;
		const result = await runAdapter(
			{
				document,
				url: new URL(location.href),
				fetch: window.fetch.bind(window),
			},
			await readDisabledAdapters(),
		);
		return encodePageCapture({ result, metadata, html });
	} catch (error) {
		return encodePageCaptureError(error);
	}
});
