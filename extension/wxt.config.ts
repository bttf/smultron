import { defineConfig } from "wxt";

export default defineConfig({
	manifest: {
		name: "Smultronstället",
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
