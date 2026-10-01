// Markdown for a reddit thread (SPEC §17.6). The output is pasted into LLM prompts,
// so the tree must survive a paste that loses indentation (every comment carries a
// path label like **[1.2.3]**) and must still render as markdown (nesting is
// blockquote depth, and every line of a body carries its depth's prefix).
import type {
	RedditComment,
	RedditMore,
	RedditNode,
	RedditPost,
	RedditThread,
} from "./types";

export function renderThread(thread: RedditThread): string {
	const { post } = thread;
	const out: string[] = [
		`# ${oneLine(post.title) || "(untitled)"}`,
		"",
		postHeader(post),
		post.permalink,
		"",
	];
	const body = postBody(post);
	if (body) out.push(body, "");
	out.push("---", "", "## Comments", "");
	for (const note of captureNotes(thread)) out.push(note, "");
	const comments = renderComments(thread.comments);
	if (comments.length > 0) out.push(...comments);
	else out.push("_No comments._");
	return `${out.join("\n")}\n`;
}

function postHeader(post: RedditPost): string {
	const parts = [
		`r/${post.subreddit}`,
		authorLabel(post.author),
		points(post.score),
	];
	const date = isoDate(post.createdAt);
	if (date) parts.push(date);
	parts.push(
		`${post.numComments} ${plural(post.numComments, "comment", "comments")}`,
	);
	if (post.flair) parts.push(`flair: ${oneLine(post.flair)}`);
	return parts.join(" · ");
}

/** Link URL, gallery image URLs, or the crosspost source; then the selftext. */
function postBody(post: RedditPost): string {
	const parts: string[] = [];
	if (post.crosspostOf) {
		parts.push(`crosspost of ${post.crosspostOf.permalink}`);
	} else if (post.gallery.length > 0) {
		parts.push(
			post.gallery
				.map((item) => {
					let line = `- ${item.url}`;
					if (item.caption) line += ` (${oneLine(item.caption)})`;
					if (item.outboundUrl) line += ` → ${item.outboundUrl}`;
					return line;
				})
				.join("\n"),
		);
	} else if (post.url && post.url !== post.permalink) {
		parts.push(post.url);
	}
	const selftext = bodyLines(post.selftext).join("\n");
	if (selftext) parts.push(selftext);
	return parts.join("\n\n");
}

/** Notes on what the capture left out, shown under the Comments heading. */
function captureNotes(thread: RedditThread): string[] {
	const { stats, post } = thread;
	const notes: string[] = [];
	const tally = `${stats.comments} of ${post.numComments} comments captured`;
	if (thread.source === "dom") {
		notes.push(
			`_Read from the rendered page because the JSON endpoint failed; ${tally}. Comments the page had not loaded are missing._`,
		);
	}
	const caps: string[] = [];
	if (stats.hitCommentCap) caps.push(`${stats.maxComments}-comment`);
	if (stats.hitRequestCap) caps.push(`${stats.maxRequests}-request`);
	if (caps.length > 0) {
		notes.push(
			`_Truncated: stopped at the ${caps.join(" and ")} ${caps.length > 1 ? "caps" : "cap"}; ${tally}. Branches not loaded are marked "not captured"._`,
		);
	}
	if (stats.failedRequests > 0 && stats.unexpanded > 0) {
		notes.push(
			`_Incomplete: ${stats.failedRequests} ${plural(stats.failedRequests, "request", "requests")} for more comments failed; ${tally}. Branches not loaded are marked "not captured"._`,
		);
	}
	return notes;
}

type Block = { depth: number; lines: string[] };

/** Comment lines, blockquote-nested, with a separator line between consecutive comments. */
export function renderComments(nodes: RedditNode[]): string[] {
	const blocks: Block[] = [];
	collectBlocks(nodes, [], 0, blocks);
	const out: string[] = [];
	let prevDepth: number | null = null;
	for (const block of blocks) {
		if (prevDepth !== null) {
			// Blank line within the shallower of the two quote levels: ends the previous
			// paragraph (and any deeper quote) without leaving the shared ancestors.
			out.push(quotePrefix(Math.min(prevDepth, block.depth)).trimEnd());
		}
		const prefix = quotePrefix(block.depth);
		for (const line of block.lines) {
			out.push(line.trim() === "" ? prefix.trimEnd() : prefix + line);
		}
		prevDepth = block.depth;
	}
	return out;
}

function collectBlocks(
	nodes: RedditNode[],
	path: number[],
	depth: number,
	blocks: Block[],
): void {
	let n = 0;
	for (const node of nodes) {
		if (node.kind === "more") {
			blocks.push({ depth, lines: [moreLine(node, depth)] });
			continue;
		}
		n++;
		const label = [...path, n].join(".");
		blocks.push({
			depth,
			lines: [commentHeader(node, label), ...bodyLines(node.body)],
		});
		collectBlocks(node.replies, [...path, n], depth + 1, blocks);
	}
}

/** `**[1.2]** u/name (OP) (mod) · 12 points · 2026-09-30 · stickied · edited` */
export function commentHeader(c: RedditComment, label: string): string {
	const who = [authorLabel(c.author)];
	if (c.isSubmitter) who.push("(OP)");
	if (c.distinguished) who.push(`(${distinguishedLabel(c.distinguished)})`);
	const parts = [`**[${label}]** ${who.join(" ")}`];
	parts.push(c.scoreHidden ? "score hidden" : points(c.score));
	const date = isoDate(c.createdAt);
	if (date) parts.push(date);
	if (c.stickied) parts.push("stickied");
	if (c.edited) parts.push("edited");
	return parts.join(" · ");
}

function moreLine(more: RedditMore, depth: number): string {
	const n = Math.max(more.count, more.children.length);
	if (more.id === "_" || n === 0) return "_(thread continues; not captured)_";
	const noun =
		depth === 0
			? plural(n, "comment", "comments")
			: plural(n, "reply", "replies");
	return `_(${n} more ${noun} not captured)_`;
}

/**
 * Body lines with line endings normalized, outer blank lines trimmed, and an unclosed
 * code fence closed, so one comment's fence cannot swallow the rest of the thread.
 */
export function bodyLines(body: string): string[] {
	const text = body
		.replace(/\r\n?/g, "\n")
		.replace(/^(?:[ \t]*\n)+/, "")
		.trimEnd();
	if (!text) return [];
	const lines = text.split("\n");
	const fence = openFence(lines);
	if (fence) lines.push(fence);
	return lines;
}

/** The fence string of a code block left open at the end, if any. */
function openFence(lines: string[]): string | null {
	let open: string | null = null;
	for (const line of lines) {
		const [, marker = "", rest = ""] =
			line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) ?? [];
		if (!marker) continue;
		if (open === null) {
			// A backtick fence's info string may not contain backticks.
			if (marker.startsWith("`") && rest.includes("`")) continue;
			open = marker;
		} else if (
			marker.charAt(0) === open.charAt(0) &&
			marker.length >= open.length &&
			rest.trim() === ""
		) {
			open = null;
		}
	}
	return open;
}

function quotePrefix(depth: number): string {
	return "> ".repeat(depth);
}

function authorLabel(author: string): string {
	return author === "[deleted]" ? "[deleted]" : `u/${author}`;
}

function distinguishedLabel(value: string): string {
	const v = value.toLowerCase();
	return v === "moderator" ? "mod" : v;
}

function points(score: number): string {
	return `${score} ${plural(score, "point", "points")}`;
}

function plural(n: number, one: string, many: string): string {
	return Math.abs(n) === 1 ? one : many;
}

function isoDate(iso: string): string {
	return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "";
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
