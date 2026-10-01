// Reddit renderer tests (SPEC §17.10): fixture JSON through the adapter's own
// fetch/normalize/expand path with a fake fetch. No network.
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import continueRaw from "./fixtures/continue.json?raw";
import moreChildrenRaw from "./fixtures/morechildren.json?raw";
import shredditHtml from "./fixtures/shreddit.html?raw";
import specExampleRaw from "./fixtures/spec-example.json?raw";
import threadRaw from "./fixtures/thread.json?raw";
import { type CaptureLimits, captureThread, redditPostAdapter } from "./index";
import { normalizePost } from "./json";
import { bodyLines, renderComments, renderThread } from "./render";
import type { RawThing, RedditComment, RedditThread } from "./types";

const THREAD_URL =
	"https://www.reddit.com/r/rust/comments/abc123/fixture_thread/";
const MORE_THINGS = (
	JSON.parse(moreChildrenRaw) as { json: { data: { things: RawThing[] } } }
).json.data.things;

type Handler = (url: URL) => unknown;

/**
 * A fetch that answers from `handler` and records every URL. It throws "Illegal invocation"
 * like the page's own fetch does when called with a `this`.
 */
function fakeFetch(handler: Handler) {
	const calls: URL[] = [];
	const fn = function (this: unknown, input: RequestInfo | URL) {
		if (this !== undefined) {
			return Promise.reject(new TypeError("Illegal invocation"));
		}
		const url = new URL(String(input));
		calls.push(url);
		try {
			const body = handler(url);
			return Promise.resolve(
				body instanceof Response
					? body
					: new Response(JSON.stringify(body), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
			);
		} catch (err) {
			return Promise.reject(err);
		}
	};
	return { fetch: fn as unknown as typeof fetch, calls };
}

/** morechildren with limit_children=false: the requested ids plus their descendants. */
function moreChildren(url: URL, things: RawThing[] = MORE_THINGS) {
	const ids = new Set(url.searchParams.get("children")?.split(",") ?? []);
	const names = new Set<string>();
	const out: RawThing[] = [];
	for (const thing of things) {
		if (
			ids.has(String(thing.data.id)) ||
			names.has(String(thing.data.parent_id))
		) {
			out.push(thing);
			names.add(String(thing.data.name));
		}
	}
	return { json: { errors: [], data: { things: out } } };
}

/** The fixture thread: thread.json, morechildren.json, and continue.json for c4. */
function fixtureHandler(overrides: { more?: Handler } = {}): Handler {
	return (url) => {
		if (url.pathname === "/r/rust/comments/abc123/.json")
			return JSON.parse(threadRaw);
		if (url.pathname === "/api/morechildren.json") {
			return (overrides.more ?? moreChildren)(url);
		}
		if (url.pathname === "/r/rust/comments/abc123/fixture_thread/c4/.json") {
			return JSON.parse(continueRaw);
		}
		return new Response("not found", { status: 404 });
	};
}

function emptyDocument(): Document {
	return parseHTML("<!doctype html><html><body></body></html>")
		.document as unknown as Document;
}

async function capture(
	pageUrl: string,
	handler: Handler,
	limits?: CaptureLimits,
	document = emptyDocument(),
) {
	const { fetch, calls } = fakeFetch(handler);
	const thread = await captureThread(
		{ document, url: new URL(pageUrl), fetch },
		limits,
	);
	return { thread, markdown: renderThread(thread), calls };
}

/** The markdown after the `## Comments` heading. */
function commentsSection(markdown: string): string {
	return markdown.slice(
		markdown.indexOf("## Comments\n\n") + "## Comments\n\n".length,
	);
}

const FULL_COMMENTS = `**[1]** u/RustMod (mod) · score hidden · 2026-09-30 · stickied
Please read the rules.

This thread is moderated.

**[2]** u/dave · 50 points · 2026-09-30 · edited
Multi-line top level.
Second line.

> **[2.1]** u/carol (OP) · 20 points · 2026-09-30
> OP reply with a list:
>
> - one
> - two
>
> > **[2.1.1]** u/erin · 5 points · 2026-09-30
> > Code at depth two:
> >
> > \`\`\`rust
> > fn main() {}
> >
> > // blank line above
> > \`\`\`
> > After the fence.
> >
> > > **[2.1.1.1]** u/jack · 2 points · 2026-09-30
> > > Continued thread reply.
> > > With two lines.
> > >
> > > > **[2.1.1.1.1]** u/kim · 1 point · 2026-09-30
> > > > Deep reply.
>
> **[2.2]** [deleted] · 2 points · 2026-09-30
> [deleted]
>
> **[2.3]** u/gina · 6 points · 2026-09-30
> Loaded from morechildren.
>
> > **[2.3.1]** u/hank · 1 point · 2026-09-30
> > Nested under a loaded comment.
>
> **[2.4]** u/lee · 1 point · 2026-09-30
> Last sibling.

**[3]** [deleted] · 7 points · 2026-09-30
[removed]

> **[3.1]** u/frank (admin) · 4 points · 2026-09-30
> Admin note.

**[4]** u/ivy · 3 points · 2026-09-30
Late top-level comment.

**[5]** u/carol (OP) · 2 points · 2026-09-30
OP top-level follow-up.
`;

describe("renderThread", () => {
	it("renders the SPEC §17.6 format example", async () => {
		const { markdown } = await capture(
			"https://www.reddit.com/r/example/comments/spec01/spec_example/",
			() => JSON.parse(specExampleRaw),
		);
		// As in the SPEC example, except [1] is also the OP's (the post is alice's).
		expect(markdown).toBe(`# Spec example

r/example · u/alice · 99 points · 2026-09-30 · 4 comments
https://www.reddit.com/r/example/comments/spec01/spec_example/

---

## Comments

**[1]** u/alice (OP) · 120 points · 2026-09-30
Top-level comment text.

> **[1.1]** u/bob · 40 points · 2026-09-30
> Reply text.
>
> > **[1.1.1]** u/alice (OP) · 12 points · 2026-09-30 · edited
> > Reply to the reply.
> > Second line of the same comment.

**[2]** [deleted] · 3 points · 2026-09-30
[removed]
`);
	});

	it("writes the post header, permalink, selftext and a Comments section", async () => {
		const { markdown } = await capture(THREAD_URL, fixtureHandler());
		expect(
			markdown.startsWith(`# Fixture thread: tree rendering

r/rust · u/carol · 321 points · 2026-09-29 · 14 comments · flair: Discussion
https://www.reddit.com/r/rust/comments/abc123/fixture_thread/

Line one of the post.

Line two with **bold**.

---

## Comments

`),
		).toBe(true);
	});

	it("labels every comment with its path and nests replies as blockquotes", async () => {
		const { markdown, thread } = await capture(THREAD_URL, fixtureHandler());
		expect(commentsSection(markdown)).toBe(FULL_COMMENTS);
		expect(thread.stats.comments).toBe(14);
		expect(thread.stats.unexpanded).toBe(0);
	});

	it("prefixes every line of a multi-line body at depth, blank lines included", async () => {
		const { markdown } = await capture(THREAD_URL, fixtureHandler());
		const lines = markdown.split("\n");
		const start = lines.findIndex((l) => l.includes("**[2.1.1]**"));
		const end = lines.findIndex((l) => l.includes("**[2.1.1.1]**"));
		const block = lines.slice(start, end - 1);
		expect(block).toHaveLength(9);
		for (const line of block)
			expect(line === "> >" || line.startsWith("> > ")).toBe(true);
		// The separator before a child sits at the parent's depth; before an uncle, at the uncle's.
		expect(lines[end - 1]).toBe("> >");
		expect(lines[lines.findIndex((l) => l.includes("**[2.2]**")) - 1]).toBe(
			">",
		);
		expect(lines[lines.findIndex((l) => l.includes("**[3]**")) - 1]).toBe("");
	});

	it("marks OP, deleted, removed, distinguished, stickied, edited and hidden scores", async () => {
		const { markdown } = await capture(THREAD_URL, fixtureHandler());
		const headers = markdown.split("\n").filter((l) => /^(> )*\*\*\[/.test(l));
		expect(headers).toContain(
			"**[1]** u/RustMod (mod) · score hidden · 2026-09-30 · stickied",
		);
		expect(headers).toContain(
			"**[2]** u/dave · 50 points · 2026-09-30 · edited",
		);
		expect(headers).toContain(
			"> **[2.1]** u/carol (OP) · 20 points · 2026-09-30",
		);
		expect(headers).toContain("> **[2.2]** [deleted] · 2 points · 2026-09-30");
		expect(headers).toContain("**[3]** [deleted] · 7 points · 2026-09-30");
		expect(headers).toContain(
			"> **[3.1]** u/frank (admin) · 4 points · 2026-09-30",
		);
		expect(markdown).toContain(
			"> **[2.2]** [deleted] · 2 points · 2026-09-30\n> [deleted]\n",
		);
		expect(markdown).toContain(
			"**[3]** [deleted] · 7 points · 2026-09-30\n[removed]\n",
		);
	});

	it("closes a code fence a comment leaves open, so it cannot swallow later comments", () => {
		expect(bodyLines("Look:\n```js\nlet a = 1;")).toEqual([
			"Look:",
			"```js",
			"let a = 1;",
			"```",
		]);
		expect(bodyLines("~~~~\ncode\n~~~~")).toEqual(["~~~~", "code", "~~~~"]);
		expect(bodyLines("\n\n  \nText\r\nmore\n\n")).toEqual(["Text", "more"]);
	});

	it("renders link, gallery and crosspost bodies", () => {
		const base = {
			id: "p1",
			subreddit: "pics",
			title: "T",
			author: "x",
			permalink: "/r/pics/comments/p1/t/",
			created_utc: 1790755200,
		};
		const render = (extra: Record<string, unknown>) =>
			renderThread(thread(normalizePost({ ...base, ...extra }), []));

		expect(
			render({ is_self: false, url: "https://example.com/a?b=1&c=2" }),
		).toContain(
			"https://www.reddit.com/r/pics/comments/p1/t/\n\nhttps://example.com/a?b=1&c=2\n\n---",
		);
		expect(
			render({
				is_self: false,
				url: "https://www.reddit.com/gallery/p1",
				gallery_data: {
					items: [
						{ media_id: "abc", caption: "First" },
						{ media_id: "def", outbound_url: "https://example.com/" },
					],
				},
				media_metadata: {
					abc: {
						status: "valid",
						e: "Image",
						m: "image/jpg",
						s: { u: "https://preview.redd.it/abc.jpg?s=1" },
					},
					def: {
						status: "valid",
						e: "Image",
						m: "image/png",
						s: { u: "https://preview.redd.it/def.png?s=1" },
					},
				},
			}),
		).toContain(
			"- https://i.redd.it/abc.jpg (First)\n- https://i.redd.it/def.png → https://example.com/\n\n---",
		);
		expect(
			render({
				is_self: false,
				url: "/r/rust/comments/zz9/original/",
				crosspost_parent_list: [
					{
						permalink: "/r/rust/comments/zz9/original/",
						subreddit: "rust",
						title: "Original",
						author: "y",
					},
				],
			}),
		).toContain(
			"crosspost of https://www.reddit.com/r/rust/comments/zz9/original/\n\n---",
		);
		expect(render({ is_self: true, selftext: "" })).toContain("_No comments._");
	});
});

describe("truncation", () => {
	it("notes the comment cap and marks what was not loaded in place", async () => {
		const { markdown, thread } = await capture(THREAD_URL, fixtureHandler(), {
			maxComments: 10,
		});
		expect(thread.stats.hitCommentCap).toBe(true);
		expect(thread.stats.comments).toBe(10);
		expect(
			commentsSection(markdown).startsWith(
				'_Truncated: stopped at the 10-comment cap; 10 of 14 comments captured. Branches not loaded are marked "not captured"._\n\n**[1]**',
			),
		).toBe(true);
		// c7 arrived with c6 but did not fit; c8 was never requested; c4's continuation never fetched.
		expect(markdown).toContain(
			"> **[2.3]** u/gina · 6 points · 2026-09-30\n> Loaded from morechildren.\n>\n> > _(1 more reply not captured)_\n>\n> _(1 more reply not captured)_\n\n**[3]**",
		);
		expect(markdown).toContain(
			"> > After the fence.\n> >\n> > > _(thread continues; not captured)_\n",
		);
	});

	it("notes the request cap", async () => {
		const { markdown, thread, calls } = await capture(
			THREAD_URL,
			fixtureHandler(),
			{
				maxRequests: 2,
			},
		);
		expect(calls).toHaveLength(2);
		expect(thread.stats.hitRequestCap).toBe(true);
		expect(markdown).toContain(
			'_Truncated: stopped at the 2-request cap; 9 of 14 comments captured. Branches not loaded are marked "not captured"._',
		);
		expect(markdown).toContain("> _(3 more replies not captured)_");
	});

	it("notes failed expansion requests and keeps the stubs", async () => {
		const { markdown, thread } = await capture(
			THREAD_URL,
			fixtureHandler({ more: () => new Response("busy", { status: 503 }) }),
		);
		expect(thread.stats.failedRequests).toBe(2);
		expect(markdown).toContain(
			'_Incomplete: 2 requests for more comments failed; 9 of 14 comments captured. Branches not loaded are marked "not captured"._',
		);
		expect(markdown).toContain("\n_(2 more comments not captured)_\n");
		expect(markdown).not.toContain("_Truncated");
		// The continue stub does not depend on morechildren and still loads.
		expect(markdown).toContain("**[2.1.1.1.1]** u/kim");
	});
});

describe("captureThread", () => {
	it("uses the page's origin and sort for every request, the permalink .json for a continue stub", async () => {
		const { calls } = await capture(
			"https://old.reddit.com/r/rust/comments/abc123/fixture_thread/?sort=top",
			fixtureHandler(),
		);
		expect(calls.map((u) => u.origin)).toEqual(
			Array(4).fill("https://old.reddit.com"),
		);
		expect(calls.map((u) => u.searchParams.get("sort"))).toEqual(
			Array(4).fill("top"),
		);
		const [first, rootMore, replyMore, cont] = calls;
		expect(first?.href).toBe(
			"https://old.reddit.com/r/rust/comments/abc123/.json?limit=500&raw_json=1&sort=top",
		);
		// Shallowest stub first.
		expect(rootMore?.pathname).toBe("/api/morechildren.json");
		expect(Object.fromEntries(rootMore?.searchParams ?? [])).toEqual({
			api_type: "json",
			link_id: "t3_abc123",
			children: "c11,c12",
			raw_json: "1",
			limit_children: "false",
			sort: "top",
		});
		expect(replyMore?.searchParams.get("children")).toBe("c6,c8");
		expect(cont?.pathname).toBe(
			"/r/rust/comments/abc123/fixture_thread/c4/.json",
		);
		expect(cont?.searchParams.get("limit")).toBe("500");
	});

	it("splits a long stub into morechildren batches of at most 100 ids", async () => {
		const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
		const things = ids.map((id) => comment(id, "t3_big1"));
		const { calls, thread } = await capture(
			"https://www.reddit.com/r/x/comments/big1/t/",
			(url) =>
				url.pathname === "/api/morechildren.json"
					? moreChildren(url, things)
					: threadJson("big1", [
							{
								kind: "more",
								data: {
									id: "m0",
									parent_id: "t3_big1",
									count: 250,
									children: ids,
								},
							},
						]),
		);
		const sizes = calls
			.slice(1)
			.map((u) => u.searchParams.get("children")?.split(",").length);
		expect(sizes).toEqual([100, 100, 50]);
		expect(thread.stats.comments).toBe(250);
		expect(thread.comments.map((c) => c.id)).toEqual(ids);
	});

	it("follows the stub reddit re-lists for ids it did not return, and stops on one that never loads", async () => {
		// Reddit returns a few comments per call and re-lists the rest of the requested ids.
		const ids = ["r1", "r2", "r3", "r4"];
		const stuck = ["s1", "s2"];
		const { calls, thread } = await capture(
			"https://www.reddit.com/r/x/comments/rl1/t/",
			(url) => {
				if (url.pathname !== "/api/morechildren.json") {
					return threadJson("rl1", [
						{
							kind: "more",
							data: { id: "r1", parent_id: "t3_rl1", count: 4, children: ids },
						},
						comment("p1", "t3_rl1", {
							kind: "Listing",
							data: {
								children: [
									{
										kind: "more",
										data: {
											id: "s1",
											parent_id: "t1_p1",
											count: 2,
											children: stuck,
										},
									},
								],
							},
						}),
					]);
				}
				const requested = url.searchParams.get("children")?.split(",") ?? [];
				const [head, ...rest] = requested;
				if (head?.startsWith("s")) {
					// Never loads: no comments, the same ids re-listed.
					return {
						json: {
							errors: [],
							data: {
								things: [
									{
										kind: "more",
										data: {
											id: "s1",
											parent_id: "t1_p1",
											count: 2,
											children: requested,
										},
									},
								],
							},
						},
					};
				}
				const things: RawThing[] = [comment(head ?? "", "t3_rl1")];
				if (rest.length) {
					things.push({
						kind: "more",
						data: {
							id: rest[0],
							parent_id: "t3_rl1",
							count: rest.length,
							children: rest,
						},
					});
				}
				return { json: { errors: [], data: { things } } };
			},
		);
		expect(thread.comments.map((c) => c.id)).toEqual([
			"r1",
			"r2",
			"r3",
			"r4",
			"p1",
		]);
		// 1 thread + 4 productive calls + 1 call for the stuck stub, which is then dropped.
		expect(calls).toHaveLength(6);
		expect(thread.stats.unexpanded).toBe(0);
	});

	it("calls the page's fetch without a `this`", async () => {
		const { thread } = await capture(THREAD_URL, fixtureHandler());
		expect(thread.source).toBe("json");
	});

	it("returns the normalized post and tree as data", async () => {
		const { fetch } = fakeFetch(fixtureHandler());
		const out = await redditPostAdapter.extract({
			document: emptyDocument(),
			url: new URL(THREAD_URL),
			fetch,
		});
		expect(out.title).toBe("Fixture thread: tree rendering");
		const data = out.data as RedditThread;
		expect(data.post.flair).toBe("Discussion");
		expect(data.comments.map((c) => c.id)).toEqual([
			"c1",
			"c2",
			"c9",
			"c11",
			"c12",
		]);
		const dave = data.comments[1] as RedditComment;
		expect(dave.editedAt).toBe("2026-09-30T10:15:00.000Z");
		expect(dave.replies.map((c) => c.id)).toEqual(["c3", "c5", "c6", "c8"]);
		expect(JSON.parse(JSON.stringify(data))).toEqual(data);
		expect(redditPostAdapter.version).toBe("1.0.0");
	});
});

describe("DOM fallback", () => {
	it("reads shreddit-post and shreddit-comment when the JSON fetch fails", async () => {
		const document = parseHTML(shredditHtml).document as unknown as Document;
		const { markdown, thread, calls } = await capture(
			THREAD_URL,
			() => new Response("blocked", { status: 403 }),
			undefined,
			document,
		);
		expect(calls).toHaveLength(1);
		expect(thread.source).toBe("dom");
		expect(thread.jsonError).toContain("HTTP 403");
		expect(markdown).toContain(
			"r/rust · u/carol · 321 points · 2026-09-29 · 5 comments · flair: Discussion",
		);
		expect(
			commentsSection(markdown),
		).toBe(`_Read from the rendered page because the JSON endpoint failed; 5 of 5 comments captured. Comments the page had not loaded are missing._

**[1]** u/RustMod (mod) · 1 point · 2026-09-30 · stickied
Please read the rules.

This thread is moderated.

**[2]** u/dave · 50 points · 2026-09-30 · edited
Multi-line top level.

See [the FAQ](https://www.reddit.com/r/rust/wiki/faq).

> **[2.1]** u/carol (OP) · 20 points · 2026-09-30
> OP reply with a list:
>
> - one
> - two
>
> > **[2.1.1]** [deleted] · score hidden · 2026-09-30
> > [deleted]

**[3]** u/ivy · 3 points · 2026-09-30
Late top-level comment.
`);
	});

	it("throws when the JSON fails and the page has no shreddit-post, so the runner falls back", async () => {
		await expect(
			capture(
				THREAD_URL,
				() => new Response("<html>login</html>", { status: 200 }),
			),
		).rejects.toThrow(/non-JSON response.*no shreddit-post/);
	});
});

describe("renderComments", () => {
	it("returns no lines for an empty tree", () => {
		expect(renderComments([])).toEqual([]);
	});
});

function thread(
	post: RedditThread["post"],
	comments: RedditThread["comments"],
): RedditThread {
	return {
		source: "json",
		post,
		comments,
		stats: {
			comments: 0,
			requests: 1,
			maxComments: 2000,
			maxRequests: 50,
			hitCommentCap: false,
			hitRequestCap: false,
			failedRequests: 0,
			unexpanded: 0,
		},
	};
}

function comment(
	id: string,
	parentId: string,
	replies: unknown = "",
): RawThing {
	return {
		kind: "t1",
		data: {
			id,
			name: `t1_${id}`,
			parent_id: parentId,
			author: "u",
			body: id,
			score: 1,
			created_utc: 1790755200,
			permalink: `/r/x/comments/${parentId.slice(3)}/t/${id}/`,
			replies,
		},
	};
}

function threadJson(postId: string, children: RawThing[]) {
	return [
		{
			kind: "Listing",
			data: {
				children: [
					{
						kind: "t3",
						data: {
							id: postId,
							subreddit: "x",
							title: "T",
							author: "op",
							permalink: `/r/x/comments/${postId}/t/`,
							is_self: true,
							created_utc: 1790755200,
						},
					},
				],
			},
		},
		{ kind: "Listing", data: { children } },
	];
}
