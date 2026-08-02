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
		// activeTab (not broad "tabs"): the popup reads the active tab's
		// url/title, which the action click grants access to.
		permissions: [
			"bookmarks",
			"storage",
			"alarms",
			"contextMenus",
			"activeTab",
		],
		host_permissions: [
			"http://localhost:3000/*",
			"https://smultron.redpine.software/*",
		],
	},
});
