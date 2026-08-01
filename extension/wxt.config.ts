import { defineConfig } from "wxt";

export default defineConfig({
	manifest: {
		name: "Smultronstället",
		permissions: ["bookmarks", "storage", "alarms"],
		host_permissions: [
			"http://localhost:3000/*",
			"https://smultron.redpine.software/*",
		],
	},
});
