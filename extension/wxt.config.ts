import { defineConfig } from "wxt";

export default defineConfig({
	manifest: {
		name: "Smultronstället",
		// WXT auto-fills manifest.icons from public/icon/*.png, but not the
		// toolbar action icon — without default_icon some Chrome versions
		// fall back to a placeholder.
		action: {
			default_icon: {
				16: "icon/16.png",
				32: "icon/32.png",
				48: "icon/48.png",
			},
		},
		// Broad "tabs" (m15): the background icon watcher reads the ACTIVE
		// tab's URL passively — on tabs.onActivated/onUpdated and window
		// focus changes, with no action click to lean on — so activeTab is
		// not enough. This deliberately supersedes the earlier activeTab-only
		// stance and accepts Chrome's "read your browsing history" install
		// warning (SPEC §6 records the trade-off). activeTab stays for the
		// popup's own url/title read.
		// m19 adds "idle" + "webNavigation" for browse-event capture (SPEC §13).
		// m23 adds "unlimitedStorage" (no install warning): queued screenshots
		// can reach ~13 MiB, and `chrome.storage.local`'s default 10 MB quota
		// would start failing EVERY outbox write, bookmark syncs included
		// (SPEC §6, §15.3).
		// Deliberately NOT "history": the backfill that would use it is RED-93,
		// its install warning escalates over "tabs"', and an unused permission
		// is contrary to least-privilege (SPEC §6).
		permissions: [
			"bookmarks",
			"storage",
			"unlimitedStorage",
			"alarms",
			"contextMenus",
			"activeTab",
			"tabs",
			"idle",
			"webNavigation",
		],
		// `<all_urls>` (m23) is the second recorded exception to least
		// privilege: `chrome.tabs.captureVisibleTab` may only capture a tab
		// whose origin the extension holds a host permission for, and a Ctrl+D
		// save is not an extension invocation, so it grants no `activeTab` —
		// without it a save-time screenshot is impossible. The install warning
		// escalates to "read and change all your data on all websites"; the
		// extension never injects scripts or reads page content, only pixels of
		// the tab being bookmarked. SPEC §6 and §15 record the trade-off.
		host_permissions: [
			"http://localhost:3000/*",
			"https://smultron.redpine.software/*",
			"<all_urls>",
		],
	},
});
