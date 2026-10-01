// DOM fallback for new reddit (SPEC §17.6): when the JSON fetch fails, read the
// rendered `shreddit-post` and `shreddit-comment` elements. Only what the page has
// loaded is captured; nothing is expanded.
import { htmlToMarkdown } from "../generic/markdown";
import { MAX_COMMENTS } from "./expand";
import { absoluteUrl, parsePostUrl } from "./json";
import type {
	RedditComment,
	RedditGalleryItem,
	RedditNode,
	RedditPost,
	RedditThread,
} from "./types";

/** The thread as rendered by new reddit, or null when the page has no `shreddit-post`. */
export function readThreadFromDom(
	document: Document,
	pageUrl: URL,
): RedditThread | null {
	const postEl = document.querySelector("shreddit-post");
	if (!postEl) return null;
	const baseUrl = document.baseURI || pageUrl.href;
	const post = readPost(postEl, pageUrl, baseUrl);

	const root: RedditNode[] = [];
	const byName = new Map<string, RedditComment>();
	/** Last comment seen at each depth, for a comment whose parent is not on the page. */
	const lastAtDepth: RedditComment[] = [];
	let count = 0;
	let hitCommentCap = false;
	for (const el of Array.from(document.querySelectorAll("shreddit-comment"))) {
		const thingId = attr(el, "thingid", "thingId");
		if (!/^t1_[a-z0-9]+$/i.test(thingId) || byName.has(thingId)) continue;
		if (count >= MAX_COMMENTS) {
			hitCommentCap = true;
			break;
		}
		const depth = Math.max(0, toInt(attr(el, "depth")));
		const comment = readComment(el, thingId, post, baseUrl, pageUrl.href);
		const parent =
			byName.get(comment.parentId) ??
			(depth > 0 ? lastAtDepth[depth - 1] : undefined);
		if (parent) {
			comment.parentId = `t1_${parent.id}`;
			parent.replies.push(comment);
		} else {
			comment.parentId = `t3_${post.id}`;
			root.push(comment);
		}
		byName.set(thingId, comment);
		lastAtDepth[depth] = comment;
		lastAtDepth.length = depth + 1;
		count++;
	}

	return {
		source: "dom",
		post,
		comments: root,
		stats: {
			comments: count,
			requests: 0,
			maxComments: MAX_COMMENTS,
			maxRequests: 0,
			hitCommentCap,
			hitRequestCap: false,
			failedRequests: 0,
			unexpanded: 0,
		},
	};
}

function readPost(el: Element, pageUrl: URL, baseUrl: string): RedditPost {
	const fromUrl = parsePostUrl(pageUrl);
	const permalink =
		absoluteUrl(attr(el, "permalink")) || absoluteUrl(pageUrl.pathname);
	const postType = attr(el, "post-type");
	const contentHref = attr(el, "content-href");
	const linkUrl =
		postType !== "text" && contentHref && absoluteUrl(contentHref) !== permalink
			? absoluteUrl(contentHref)
			: undefined;
	const crosspost =
		linkUrl && /^https:\/\/[^/]*reddit\.com\/r\/[^/]+\/comments\//.test(linkUrl)
			? linkUrl
			: undefined;

	const bodyEl = el.querySelector('[slot="text-body"]');
	const richText =
		bodyEl?.querySelector('[id$="-post-rtjson-content"]') ?? bodyEl;
	const flairEl = el.querySelector("shreddit-post-flair");

	return {
		id: attr(el, "id").replace(/^t3_/, "") || fromUrl?.postId || "",
		subreddit:
			attr(el, "subreddit-name") ||
			attr(el, "subreddit-prefixed-name").replace(/^r\//, "") ||
			fromUrl?.subreddit ||
			"",
		title: attr(el, "post-title") || el.ownerDocument?.title || "",
		author: attr(el, "author") || "[deleted]",
		score: toInt(attr(el, "score")),
		createdAt: parseTimestamp(attr(el, "created-timestamp")),
		edited: false,
		numComments: toInt(attr(el, "comment-count")),
		flair: oneLine(flairEl?.textContent ?? "") || undefined,
		permalink,
		url: crosspost ? undefined : linkUrl,
		domain: attr(el, "domain") || undefined,
		selftext: richText ? toMarkdown(richText, baseUrl, pageUrl.href) : "",
		gallery: postType === "gallery" ? galleryFromDom(el) : [],
		crosspostOf: crosspost
			? { permalink: crosspost, subreddit: "", title: "", author: "" }
			: undefined,
		nsfw: el.hasAttribute("nsfw"),
		spoiler: el.hasAttribute("spoiler"),
		locked: el.hasAttribute("locked"),
		stickied: el.hasAttribute("stickied"),
	};
}

function readComment(
	el: Element,
	thingId: string,
	post: RedditPost,
	baseUrl: string,
	pageHref: string,
): RedditComment {
	const author =
		attr(el, "is-author-deleted") === "true"
			? "[deleted]"
			: attr(el, "author") || "[deleted]";
	const meta = slotChild(el, "commentMeta");
	const editedEl = meta
		? Array.from(meta.querySelectorAll("span")).find((s) =>
				/^\s*Edited\b/.test(s.textContent ?? ""),
			)
		: undefined;
	const created = meta
		? Array.from(meta.querySelectorAll("faceplate-timeago[ts]")).find(
				(t) => !editedEl?.contains(t),
			)
		: undefined;
	const badges =
		meta?.querySelector("shreddit-comment-badges") ??
		el.querySelector(`shreddit-comment-badges[thing-id="${thingId}"]`);
	const distinguished = (
		badges?.getAttribute("distinguished-as") ??
		meta
			?.querySelector("[distinguished-as]")
			?.getAttribute("distinguished-as") ??
		""
	).toLowerCase();

	return {
		kind: "comment",
		id: thingId.slice(3),
		parentId: attr(el, "parentid", "parentId") || `t3_${post.id}`,
		author,
		isSubmitter: author !== "[deleted]" && author === post.author,
		score: toInt(attr(el, "score")),
		scoreHidden: !el.hasAttribute("score"),
		createdAt: parseTimestamp(created?.getAttribute("ts") ?? ""),
		edited: !!editedEl,
		editedAt:
			parseTimestamp(
				editedEl?.querySelector("faceplate-timeago[ts]")?.getAttribute("ts") ??
					"",
			) || undefined,
		distinguished: distinguished || undefined,
		stickied: !!badges?.hasAttribute("stickied"),
		body: commentBody(el, thingId, author, baseUrl, pageHref),
		permalink: absoluteUrl(attr(el, "permalink")),
		replies: [],
	};
}

function commentBody(
	el: Element,
	thingId: string,
	author: string,
	baseUrl: string,
	pageHref: string,
): string {
	if (attr(el, "is-comment-deleted") === "true") return "[deleted]";
	if (
		/remov/i.test(attr(el, "moderation-verdict")) ||
		attr(el, "is-comment-removed") === "true"
	) {
		return "[removed]";
	}
	const slot = slotChild(el, "comment");
	if (!slot) return author === "[deleted]" ? "[deleted]" : "[removed]";
	// Mod comments wrap the text in a "Read More" teaser; the rich text has the full body.
	const rich =
		Array.from(slot.querySelectorAll("[id]")).find(
			(n) => n.id === `${thingId}-post-rtjson-content`,
		) ?? slot;
	return toMarkdown(rich, baseUrl, pageHref);
}

function galleryFromDom(el: Element): RedditGalleryItem[] {
	const seen = new Set<string>();
	const items: RedditGalleryItem[] = [];
	for (const img of Array.from(
		el.querySelectorAll("gallery-carousel img, [slot='gallery'] img"),
	)) {
		const src =
			img.getAttribute("src") || img.getAttribute("data-lazy-src") || "";
		if (!/^https?:\/\//.test(src) || seen.has(src)) continue;
		seen.add(src);
		items.push({
			url: src,
			caption: oneLine(img.getAttribute("alt") ?? "") || undefined,
		});
	}
	return items;
}

/** The direct child carrying `slot="<name>"` (slotted content of the custom element). */
function slotChild(el: Element, name: string): Element | undefined {
	return Array.from(el.children).find((c) => c.getAttribute("slot") === name);
}

function toMarkdown(el: Element, baseUrl: string, pageHref: string): string {
	try {
		return htmlToMarkdown(el as HTMLElement, baseUrl, pageHref);
	} catch {
		return oneLine(el.textContent ?? "");
	}
}

/** First present attribute among `names` (parsers differ on attribute-name case). */
function attr(el: Element, ...names: string[]): string {
	for (const name of names) {
		const v = el.getAttribute(name);
		if (v !== null) return v.trim();
	}
	return "";
}

function toInt(value: string): number {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : 0;
}

/** shreddit's `2020-10-17T13:43:07.881000+0000` (and plain ISO) → ISO 8601, or "". */
export function parseTimestamp(value: string): string {
	const m = value
		.trim()
		.match(
			/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/,
		);
	if (!m) return "";
	const fraction = m[2] ? m[2].slice(0, 4) : "";
	const zone =
		!m[3] || m[3] === "Z" ? "Z" : `${m[3].slice(0, 3)}:${m[3].slice(-2)}`;
	const time = Date.parse(`${m[1]}${fraction}${zone}`);
	return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
