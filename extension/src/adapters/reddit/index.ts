// Reddit post adapter (SPEC §17.6): the post and its full comment tree from the
// page's own .json endpoints (same-origin, with the user's session), `more` stubs
// expanded under caps; the rendered DOM when the JSON fetch fails.
import type { Adapter, AdapterContext } from "../types";
import { readThreadFromDom } from "./dom";
import {
	CommentTree,
	countStubs,
	expandTree,
	MAX_COMMENTS,
	MAX_REQUESTS,
} from "./expand";
import { getJson, parseThreadResponse, sortParam, threadJsonUrl } from "./json";
import { renderThread } from "./render";
import type { RedditThread } from "./types";

export type {
	CaptureStats,
	RedditComment,
	RedditMore,
	RedditNode,
	RedditPost,
	RedditThread,
} from "./types";
export { renderThread };

export const redditPostAdapter: Adapter = {
	id: "reddit-post",
	name: "Reddit post",
	description: "A reddit post and its full comment thread.",
	version: "1.0.0",
	matches: (url) =>
		/(^|\.)reddit\.com$/.test(url.hostname) &&
		/^\/r\/[^/]+\/comments\/[^/]+/.test(url.pathname),
	async extract(ctx) {
		const thread = await captureThread(ctx);
		return {
			title: thread.post.title,
			markdown: renderThread(thread),
			data: thread,
		};
	},
};

export type CaptureLimits = { maxComments?: number; maxRequests?: number };

/**
 * The normalized thread: JSON first, the rendered DOM when the initial JSON fetch fails.
 * Throws when neither works, so the runner falls back to the generic adapter.
 */
export async function captureThread(
	ctx: AdapterContext,
	limits: CaptureLimits = {},
): Promise<RedditThread> {
	const maxComments = limits.maxComments ?? MAX_COMMENTS;
	const maxRequests = limits.maxRequests ?? MAX_REQUESTS;
	const sort = sortParam(ctx.url);
	const fetchFn = ctx.fetch;

	let first: ReturnType<typeof parseThreadResponse>;
	try {
		first = parseThreadResponse(
			await getJson(fetchFn, threadJsonUrl(ctx.url, sort)),
		);
	} catch (err) {
		const jsonError = err instanceof Error ? err.message : String(err);
		const thread = readThreadFromDom(ctx.document, ctx.url);
		if (!thread) {
			throw new Error(
				`reddit JSON failed (${jsonError}) and the page has no shreddit-post`,
			);
		}
		return { ...thread, sort, jsonError };
	}

	const tree = new CommentTree(`t3_${first.post.id}`, maxComments);
	tree.insert(first.things);
	const expansion = await expandTree(tree, {
		fetch: fetchFn,
		origin: ctx.url.origin,
		post: first.post,
		sort,
		maxRequests,
		requests: 1,
	});

	return {
		source: "json",
		sort,
		post: first.post,
		comments: tree.root,
		stats: {
			comments: tree.count,
			requests: expansion.requests,
			maxComments,
			maxRequests,
			hitCommentCap: tree.hitCap,
			hitRequestCap: expansion.hitRequestCap,
			failedRequests: expansion.failedRequests,
			unexpanded: countStubs(tree.root),
		},
	};
}
