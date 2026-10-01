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
		// m19 adds "webNavigation" for browse-event capture (SPEC §13). m19 also
		// held "idle", removed 2026-09-27 with the canceled attention project.
		// m23 adds "unlimitedStorage" (no install warning): queued screenshots
		// can reach ~13 MiB, and `chrome.storage.local`'s default 10 MB quota
		// would start failing EVERY outbox write, bookmark syncs included
		// (SPEC §6, §15.3).
		// Deliberately NOT "history": nothing reads Chrome's history store, its
		// install warning escalates over "tabs"', and an unused permission is
		// contrary to least-privilege (SPEC §6).
		// m25 adds "scripting" and "debugger" for page snapshots (SPEC §17.7),
		// used ONLY after the user clicks Snapshot in the popup, and only on the
		// active tab: "scripting" injects the `snapshot` unlisted script (no new
		// install warning — `<all_urls>` is already held); "debugger" captures
		// the full page over CDP. It adds the "access the page debugger
		// backend" warning, Chrome disables the extension on update until the
		// user re-approves, and a "started debugging this browser" bar shows
		// while a capture runs.
		permissions: [
			"bookmarks",
			"storage",
			"unlimitedStorage",
			"alarms",
			"contextMenus",
			"activeTab",
			"tabs",
			"webNavigation",
			"scripting",
			"debugger",
		],
		// `<all_urls>` (m23) is the second recorded exception to least
		// privilege: `chrome.tabs.captureVisibleTab` may only capture a tab
		// whose origin the extension holds a host permission for, and a Ctrl+D
		// save is not an extension invocation, so it grants no `activeTab` —
		// without it a save-time screenshot is impossible. The install warning
		// escalates to "read and change all your data on all websites". SPEC §6
		// and §15 record the trade-off. Since m25 (SPEC §6 amendment, §17) the
		// extension DOES read page content, in exactly one place: after the user
		// clicks Snapshot in the popup, it injects the `snapshot` script into the
		// active tab (which may make same-origin requests with the user's
		// session) and captures that tab over CDP. Nothing else injects or reads
		// a tab. The other page read is the m24 speed-dial metadata fill (SPEC
		// §16.2): an uncredentialed GET, from the Options page, of a URL the user
		// typed there.
		host_permissions: [
			"http://localhost:3000/*",
			"https://smultron.redpine.software/*",
			"<all_urls>",
		],
	},
});
