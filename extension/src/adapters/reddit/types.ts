// Normalized reddit thread (SPEC §17.6). This is the adapter's `data` output
// and the renderer's only input, whichever source (JSON or DOM) produced it.

export type RedditPost = {
	/** Base36 id without the `t3_` prefix. */
	id: string;
	subreddit: string;
	title: string;
	/** `[deleted]` when the account is gone. */
	author: string;
	score: number;
	upvoteRatio?: number;
	/** ISO 8601. */
	createdAt: string;
	/** ISO 8601 when reddit reports an edit time; `edited` alone when it does not. */
	editedAt?: string;
	edited: boolean;
	/** Reddit's count, which includes deleted and removed comments. */
	numComments: number;
	flair?: string;
	/** Absolute https://www.reddit.com URL. */
	permalink: string;
	/** Link target of a link post. Absent on self posts. */
	url?: string;
	domain?: string;
	/** Markdown body of a self post. Empty string when there is none. */
	selftext: string;
	gallery: RedditGalleryItem[];
	crosspostOf?: {
		permalink: string;
		subreddit: string;
		title: string;
		author: string;
	};
	nsfw: boolean;
	spoiler: boolean;
	locked: boolean;
	stickied: boolean;
	distinguished?: string;
};

export type RedditGalleryItem = {
	url: string;
	caption?: string;
	/** A link attached to the gallery item. */
	outboundUrl?: string;
};

export type RedditComment = {
	kind: "comment";
	/** Base36 id without the `t1_` prefix. */
	id: string;
	/** Fullname of the parent: `t1_…` for a reply, `t3_…` for a top-level comment. */
	parentId: string;
	/** `[deleted]` when the account is gone. */
	author: string;
	isSubmitter: boolean;
	score: number;
	scoreHidden: boolean;
	/** ISO 8601. Empty when the source did not say. */
	createdAt: string;
	edited: boolean;
	editedAt?: string;
	/** `moderator`, `admin`, or another reddit value. */
	distinguished?: string;
	stickied: boolean;
	/** Markdown. Reddit's own `[deleted]` / `[removed]` placeholders are kept verbatim. */
	body: string;
	/** Absolute URL. */
	permalink: string;
	replies: RedditNode[];
};

/**
 * Comments that were not loaded: a reddit `more` stub left unexpanded, or comments
 * dropped at the comment cap.
 */
export type RedditMore = {
	kind: "more";
	/** `_` for a "continue this thread" stub. */
	id: string;
	parentId: string;
	/** Reddit's estimate of the comments behind this stub (0 for "continue this thread"). */
	count: number;
	/** Ids (no prefix) still to load. Empty for "continue this thread". */
	children: string[];
};

export type RedditNode = RedditComment | RedditMore;

export type CaptureStats = {
	/** Comment nodes in the tree. */
	comments: number;
	/** HTTP requests made, the initial thread fetch included. */
	requests: number;
	maxComments: number;
	maxRequests: number;
	hitCommentCap: boolean;
	hitRequestCap: boolean;
	/** Expansion requests that failed (network, HTTP status, or unparseable body). */
	failedRequests: number;
	/** `more` stubs left in the tree. */
	unexpanded: number;
};

export type RedditThread = {
	/** `json`: the .json endpoints. `dom`: the rendered page, after the JSON fetch failed. */
	source: "json" | "dom";
	/** The `sort` query param of the page, passed through to every request. */
	sort?: string;
	post: RedditPost;
	comments: RedditNode[];
	stats: CaptureStats;
	/** Why the JSON source was not used (DOM source only). */
	jsonError?: string;
};

/** A `kind`/`data` pair as reddit's JSON API returns it. */
export type RawThing = { kind: string; data: Record<string, unknown> };
