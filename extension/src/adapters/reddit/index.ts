import type { Adapter } from "../types";

// TODO(RED-412): post + full comment tree (SPEC §17.6).
export const redditPostAdapter: Adapter = {
	id: "reddit-post",
	name: "Reddit post",
	description: "A reddit post and its full comment thread.",
	version: "0.0.0",
	matches: (url) =>
		/(^|\.)reddit\.com$/.test(url.hostname) &&
		/^\/r\/[^/]+\/comments\/[^/]+/.test(url.pathname),
	async extract() {
		throw new Error("reddit-post adapter not implemented");
	},
};
