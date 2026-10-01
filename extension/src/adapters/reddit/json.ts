// Reddit's .json endpoints: request URLs, the fetch itself, and normalization of
// the raw things into the shapes in ./types (SPEC §17.6).
import type {
	RawThing,
	RedditComment,
	RedditGalleryItem,
	RedditMore,
	RedditPost,
} from "./types";

/** Canonical origin for the permalinks written into the markdown and data. */
export const REDDIT_ORIGIN = "https://www.reddit.com";
/** `limit` on thread and comment-permalink fetches. */
export const THREAD_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 20_000;

const POST_PATH = /^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i;

/** Subreddit and post id from a `/r/<sub>/comments/<id>/…` URL. */
export function parsePostUrl(
	url: URL,
): { subreddit: string; postId: string } | null {
	const [, subreddit, postId] = url.pathname.match(POST_PATH) ?? [];
	return subreddit && postId
		? { subreddit, postId: postId.toLowerCase() }
		: null;
}

/** The page's `sort` query param (`top`, `new`, `old`, …), when it is a plain word. */
export function sortParam(url: URL): string | undefined {
	const sort = url.searchParams.get("sort")?.trim();
	return sort && /^[a-z_]+$/i.test(sort) ? sort.toLowerCase() : undefined;
}

/** `<origin>/r/<sub>/comments/<id>/.json?limit=500&raw_json=1[&sort=…]` on the page's own origin. */
export function threadJsonUrl(url: URL, sort?: string): string {
	const post = parsePostUrl(url);
	if (!post) throw new Error(`not a reddit post URL: ${url.pathname}`);
	const out = new URL(
		`/r/${post.subreddit}/comments/${post.postId}/.json`,
		url.origin,
	);
	out.searchParams.set("limit", String(THREAD_LIMIT));
	out.searchParams.set("raw_json", "1");
	if (sort) out.searchParams.set("sort", sort);
	return out.href;
}

/** `/api/morechildren.json` for up to 100 comment ids of one post. */
export function moreChildrenUrl(
	origin: string,
	postId: string,
	ids: string[],
	sort?: string,
): string {
	const out = new URL("/api/morechildren.json", origin);
	out.searchParams.set("api_type", "json");
	out.searchParams.set("link_id", `t3_${postId}`);
	out.searchParams.set("children", ids.join(","));
	out.searchParams.set("raw_json", "1");
	out.searchParams.set("limit_children", "false");
	if (sort) out.searchParams.set("sort", sort);
	return out.href;
}

/**
 * The `.json` of one comment's permalink, used for "continue this thread" stubs.
 * Falls back to the `/_/<id>` permalink form when reddit gave no permalink.
 */
export function commentJsonUrl(
	origin: string,
	post: Pick<RedditPost, "id" | "subreddit">,
	comment: Pick<RedditComment, "id" | "permalink">,
	sort?: string,
): string {
	let path = "";
	if (comment.permalink) {
		try {
			path = new URL(comment.permalink, REDDIT_ORIGIN).pathname;
		} catch {
			path = "";
		}
	}
	if (!path) path = `/r/${post.subreddit}/comments/${post.id}/_/${comment.id}/`;
	if (!path.endsWith("/")) path += "/";
	const out = new URL(`${path}.json`, origin);
	out.searchParams.set("limit", String(THREAD_LIMIT));
	out.searchParams.set("raw_json", "1");
	if (sort) out.searchParams.set("sort", sort);
	return out.href;
}

/**
 * GET a reddit JSON endpoint with the page's fetch (same-origin, so the user's session
 * cookies go along). Throws on a network error, a non-2xx status, or a non-JSON body
 * (logged-out old reddit answers with a login page, for example).
 */
export async function getJson(
	fetchFn: typeof fetch,
	url: string,
): Promise<unknown> {
	const init: RequestInit = {
		credentials: "same-origin",
		headers: { Accept: "application/json" },
	};
	if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
		init.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	}
	// A plain call, not `ctx.fetch(…)`: the page's fetch throws "Illegal invocation"
	// when called with a `this` other than the window.
	const res = await fetchFn(url, init);
	const where = new URL(url).pathname;
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${where}`);
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`non-JSON response from ${where}`);
	}
}

/** Post and pre-order comment things from a thread (or comment permalink) response. */
export function parseThreadResponse(json: unknown): {
	post: RedditPost;
	things: RawThing[];
} {
	if (!Array.isArray(json) || json.length < 2) {
		throw new Error("unexpected thread JSON: not a [post, comments] pair");
	}
	const postThing = listingChildren(json[0])[0];
	if (postThing?.kind !== "t3") {
		throw new Error("unexpected thread JSON: no post");
	}
	return {
		post: normalizePost(postThing.data),
		things: flattenListing(listingChildren(json[1])),
	};
}

/**
 * The pre-order replies of comment `commentId` in a comment-permalink response,
 * or null when the response does not contain that comment.
 */
export function repliesInResponse(
	json: unknown,
	commentId: string,
): RawThing[] | null {
	if (!Array.isArray(json) || json.length < 2) return null;
	for (const thing of flattenListing(listingChildren(json[1]))) {
		if (thing.kind === "t1" && thing.data.id === commentId) {
			return flattenListing(listingChildren(thing.data.replies));
		}
	}
	return null;
}

/** The flat `things` of a morechildren response. Throws on reddit-reported errors. */
export function parseMoreChildrenResponse(json: unknown): RawThing[] {
	const body = asRecord(asRecord(json)?.json);
	if (!body) throw new Error("unexpected morechildren JSON");
	const errors = body.errors;
	if (Array.isArray(errors) && errors.length > 0) {
		throw new Error(`morechildren error: ${JSON.stringify(errors[0])}`);
	}
	const things = asRecord(body.data)?.things;
	return Array.isArray(things) ? things.filter(isThing) : [];
}

/** Things of a nested listing in pre-order, `replies` listings flattened in place. */
export function flattenListing(children: RawThing[]): RawThing[] {
	const out: RawThing[] = [];
	const visit = (list: RawThing[]) => {
		for (const thing of list) {
			out.push(thing);
			visit(listingChildren(thing.data.replies));
		}
	};
	visit(children);
	return out;
}

export function normalizePost(d: Record<string, unknown>): RedditPost {
	const isSelf = d.is_self === true;
	const crosspost = asRecord(
		Array.isArray(d.crosspost_parent_list) ? d.crosspost_parent_list[0] : null,
	);
	const linkUrl = str(d.url_overridden_by_dest) || str(d.url);
	return {
		id: str(d.id),
		subreddit: str(d.subreddit),
		title: str(d.title).trim(),
		author: str(d.author) || "[deleted]",
		score: num(d.score),
		upvoteRatio:
			typeof d.upvote_ratio === "number" ? d.upvote_ratio : undefined,
		createdAt: isoFromEpoch(d.created_utc),
		...editedFields(d.edited),
		numComments: num(d.num_comments),
		flair: str(d.link_flair_text).trim() || undefined,
		permalink: absoluteUrl(str(d.permalink)),
		url: !isSelf && linkUrl ? absoluteUrl(linkUrl) : undefined,
		domain: str(d.domain) || undefined,
		selftext: str(d.selftext),
		gallery: galleryItems(d),
		crosspostOf: crosspost
			? {
					permalink: absoluteUrl(str(crosspost.permalink)),
					subreddit: str(crosspost.subreddit),
					title: str(crosspost.title).trim(),
					author: str(crosspost.author) || "[deleted]",
				}
			: undefined,
		nsfw: d.over_18 === true,
		spoiler: d.spoiler === true,
		locked: d.locked === true,
		stickied: d.stickied === true,
		distinguished: str(d.distinguished) || undefined,
	};
}

/** A comment without its replies (the tree builder attaches those by parent id). */
export function normalizeComment(d: Record<string, unknown>): RedditComment {
	return {
		kind: "comment",
		id: str(d.id),
		parentId: str(d.parent_id),
		author: str(d.author) || "[deleted]",
		isSubmitter: d.is_submitter === true,
		score: num(d.score),
		scoreHidden: d.score_hidden === true,
		createdAt: isoFromEpoch(d.created_utc),
		...editedFields(d.edited),
		distinguished: str(d.distinguished) || undefined,
		stickied: d.stickied === true,
		body: str(d.body),
		permalink: str(d.permalink) ? absoluteUrl(str(d.permalink)) : "",
		replies: [],
	};
}

export function normalizeMore(d: Record<string, unknown>): RedditMore {
	const children = Array.isArray(d.children)
		? d.children.filter((c): c is string => typeof c === "string" && c !== "")
		: [];
	return {
		kind: "more",
		id: str(d.id),
		parentId: str(d.parent_id),
		count: num(d.count),
		children,
	};
}

/** A `more` stub that stands for "continue this thread" rather than a list of ids. */
export function isContinueStub(more: RedditMore): boolean {
	return more.id === "_";
}

/** Resolves reddit's relative permalinks against https://www.reddit.com. */
export function absoluteUrl(value: string): string {
	if (!value) return "";
	try {
		return new URL(value, REDDIT_ORIGIN).href;
	} catch {
		return value;
	}
}

function galleryItems(d: Record<string, unknown>): RedditGalleryItem[] {
	const items = asRecord(d.gallery_data)?.items;
	if (!Array.isArray(items)) return [];
	const metadata = asRecord(d.media_metadata) ?? {};
	const out: RedditGalleryItem[] = [];
	for (const raw of items) {
		const item = asRecord(raw);
		if (!item) continue;
		const mediaId = str(item.media_id);
		const url = mediaUrl(mediaId, asRecord(metadata[mediaId]));
		if (!url) continue;
		out.push({
			url,
			caption: str(item.caption).trim() || undefined,
			outboundUrl: str(item.outbound_url) || undefined,
		});
	}
	return out;
}

/** i.redd.it original for images; reddit's preview/source URL otherwise. */
function mediaUrl(
	mediaId: string,
	meta: Record<string, unknown> | null,
): string {
	const ext = str(meta?.m)
		.replace(/^image\//, "")
		.replace("jpeg", "jpg");
	if (/^[a-z0-9]+$/i.test(mediaId) && /^(jpg|png|gif|webp)$/.test(ext)) {
		return `https://i.redd.it/${mediaId}.${ext}`;
	}
	const source = asRecord(meta?.s);
	return str(source?.u) || str(source?.gif) || str(source?.mp4);
}

function editedFields(value: unknown): { edited: boolean; editedAt?: string } {
	if (typeof value === "number" && value > 0) {
		return { edited: true, editedAt: isoFromEpoch(value) };
	}
	return { edited: value === true };
}

function isoFromEpoch(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? new Date(value * 1000).toISOString()
		: "";
}

function listingChildren(listing: unknown): RawThing[] {
	const children = asRecord(asRecord(listing)?.data)?.children;
	return Array.isArray(children) ? children.filter(isThing) : [];
}

function isThing(value: unknown): value is RawThing {
	const rec = asRecord(value);
	return !!rec && typeof rec.kind === "string" && asRecord(rec.data) !== null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
