// Comment tree assembly and `more` expansion (SPEC §17.6): morechildren batches of
// ≤ 100 ids inserted by parent_id, "continue this thread" via the parent comment's
// permalink .json, under a comment cap and a request cap.
import {
	commentJsonUrl,
	getJson,
	isContinueStub,
	moreChildrenUrl,
	normalizeComment,
	normalizeMore,
	parseMoreChildrenResponse,
	repliesInResponse,
} from "./json";
import type {
	RawThing,
	RedditComment,
	RedditMore,
	RedditNode,
	RedditPost,
} from "./types";

export const MAX_COMMENTS = 2000;
export const MAX_REQUESTS = 50;
/** morechildren takes at most 100 ids per call. */
export const MORE_BATCH = 100;
/** Stop expanding after this many failed requests in a row (rate limit, logged out, …). */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Where the direct children of `parentName` go: `container`, starting at index `at`. */
export type Anchor = {
	parentName: string;
	container: RedditNode[];
	at: number;
};

/**
 * The comment tree under construction. Reddit hands out comments as things carrying a
 * `parent_id`; this places each under its parent and enforces the comment cap.
 */
export class CommentTree {
	readonly root: RedditNode[] = [];
	/** Comments in the tree. */
	count = 0;
	/** A comment was dropped because the tree was full. */
	hitCap = false;
	private readonly byName = new Map<string, RedditComment>();
	/** Fullname of a dropped comment → the stub that counts it, so its descendants count there too. */
	private readonly dropped = new Map<string, RedditMore>();
	/** Stubs this tree created for dropped comments (never sent to reddit). */
	private readonly capStubs = new WeakSet<RedditMore>();
	/**
	 * Ids sent to morechildren in a request that added no comments, and parents already
	 * fetched for "continue this thread". Stubs listing them again are dropped, so a
	 * response that repeats a stub cannot cause a request loop. (Ids from a request that
	 * did add comments stay loadable: reddit returns ~20 comments per call and re-lists
	 * the rest of the requested ids in a new stub.)
	 */
	readonly dead = new Set<string>();
	readonly continued = new Set<string>();

	constructor(
		readonly postName: string,
		readonly maxComments: number = MAX_COMMENTS,
	) {}

	has(fullname: string): boolean {
		return this.byName.has(fullname);
	}

	get(fullname: string): RedditComment | undefined {
		return this.byName.get(fullname);
	}

	/** Appends top-level things after the existing ones. */
	rootAnchor(): Anchor {
		return {
			parentName: this.postName,
			container: this.root,
			at: this.root.length,
		};
	}

	/**
	 * Inserts things given in pre-order (parents before children, siblings in reddit's
	 * order). Direct children of `anchor.parentName` go into the anchor's container at its
	 * position; everything else is appended under its parent by `parent_id`. Returns the
	 * number of comments added.
	 */
	insert(things: RawThing[], anchor: Anchor = this.rootAnchor()): number {
		let added = 0;
		let pending = things;
		// Reddit's order is pre-order, so one pass places everything; a second pass
		// catches a child that arrived before its parent. Whatever is left has no parent
		// in the tree and is dropped.
		for (let pass = 0; pass < 2 && pending.length > 0; pass++) {
			const orphans: RawThing[] = [];
			for (const thing of pending) {
				const result = this.place(thing, anchor);
				if (result === "orphan") orphans.push(thing);
				else if (result === "comment") added++;
			}
			if (orphans.length === pending.length) break;
			pending = orphans;
		}
		return added;
	}

	private place(
		thing: RawThing,
		anchor: Anchor,
	): "comment" | "more" | "skip" | "orphan" {
		if (thing.kind !== "t1" && thing.kind !== "more") return "skip";
		const parentName =
			typeof thing.data.parent_id === "string" ? thing.data.parent_id : "";

		const droppedWith = this.dropped.get(parentName);
		if (droppedWith) {
			// The parent was dropped at the cap; count this one with it.
			if (thing.kind === "t1") {
				droppedWith.count += 1;
				this.dropped.set(`t1_${String(thing.data.id)}`, droppedWith);
			} else {
				droppedWith.count += normalizeMore(thing.data).count;
			}
			return "skip";
		}

		let container: RedditNode[];
		let positional = false;
		if (parentName === anchor.parentName) {
			container = anchor.container;
			positional = true;
		} else {
			const parent = this.byName.get(parentName);
			if (!parent) return "orphan";
			container = parent.replies;
		}
		const put = (node: RedditNode) => {
			if (positional) container.splice(anchor.at++, 0, node);
			else container.push(node);
		};

		if (thing.kind === "more") {
			const more = normalizeMore(thing.data);
			if (isContinueStub(more)) {
				if (this.continued.has(more.parentId)) return "skip";
			} else {
				more.children = more.children.filter(
					(id) => !this.dead.has(id) && !this.byName.has(`t1_${id}`),
				);
				if (more.children.length === 0) return "skip";
			}
			put(more);
			return "more";
		}

		const comment = normalizeComment(thing.data);
		const name = `t1_${comment.id}`;
		if (!comment.id || this.byName.has(name) || this.dropped.has(name)) {
			return "skip";
		}
		if (this.count >= this.maxComments) {
			this.hitCap = true;
			const prev = positional
				? container[anchor.at - 1]
				: container[container.length - 1];
			let stub: RedditMore;
			if (prev?.kind === "more" && this.capStubs.has(prev)) {
				stub = prev;
			} else {
				stub = {
					kind: "more",
					id: comment.id,
					parentId: parentName,
					count: 0,
					children: [],
				};
				this.capStubs.add(stub);
				put(stub);
			}
			stub.children.push(comment.id);
			stub.count += 1;
			this.dropped.set(name, stub);
			return "skip";
		}
		put(comment);
		this.byName.set(name, comment);
		this.count++;
		return "comment";
	}
}

export type ExpandOptions = {
	fetch: typeof fetch;
	/** The page's origin; every request goes there so the user's session applies. */
	origin: string;
	post: Pick<RedditPost, "id" | "subreddit">;
	sort?: string;
	maxRequests?: number;
	/** Requests already spent (the initial thread fetch). */
	requests?: number;
};

export type ExpandResult = {
	requests: number;
	failedRequests: number;
	hitRequestCap: boolean;
};

/**
 * Expands `more` stubs, shallowest first, until none are left or a cap is reached.
 * A failed request leaves its stub in place (rendered as "not captured") and moves on.
 */
export async function expandTree(
	tree: CommentTree,
	opts: ExpandOptions,
): Promise<ExpandResult> {
	const fetchFn = opts.fetch;
	const maxRequests = opts.maxRequests ?? MAX_REQUESTS;
	let requests = opts.requests ?? 0;
	let failedRequests = 0;
	let consecutiveFailures = 0;
	let hitRequestCap = false;
	const failed = new WeakSet<RedditMore>();

	for (;;) {
		const next = nextStub(tree.root, failed);
		if (!next) break;
		const { stub, container } = next;

		// Drop work that needs no request: ids already in the tree or dead, a continue
		// stub whose parent is unknown or already continued.
		if (isContinueStub(stub)) {
			if (!tree.get(stub.parentId) || tree.continued.has(stub.parentId)) {
				removeNode(container, stub);
				continue;
			}
		} else {
			stub.children = stub.children.filter(
				(id) => !tree.has(`t1_${id}`) && !tree.dead.has(id),
			);
			if (stub.children.length === 0) {
				removeNode(container, stub);
				continue;
			}
		}

		if (tree.count >= tree.maxComments) {
			tree.hitCap = true;
			break;
		}
		if (requests >= maxRequests) {
			hitRequestCap = true;
			break;
		}
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;

		requests++;
		try {
			if (isContinueStub(stub)) {
				await continueThread(tree, stub, container, fetchFn, opts);
			} else {
				await loadMore(tree, stub, container, fetchFn, opts);
			}
			consecutiveFailures = 0;
		} catch {
			failed.add(stub);
			failedRequests++;
			consecutiveFailures++;
		}
	}
	return { requests, failedRequests, hitRequestCap };
}

async function loadMore(
	tree: CommentTree,
	stub: RedditMore,
	container: RedditNode[],
	fetchFn: typeof fetch,
	opts: ExpandOptions,
): Promise<void> {
	const room = Math.max(1, tree.maxComments - tree.count);
	const batch = stub.children.slice(0, Math.min(MORE_BATCH, room));
	const json = await getJson(
		fetchFn,
		moreChildrenUrl(opts.origin, opts.post.id, batch, opts.sort),
	);
	const things = parseMoreChildrenResponse(json);

	// The batch leaves this stub either way. Reddit re-lists requested ids it did not
	// return in a new stub of its own (inserted below); ids it drops silently (deleted
	// comments without replies) are gone.
	const requested = new Set(batch);
	stub.children = stub.children.filter((id) => !requested.has(id));
	const at = container.indexOf(stub);
	const added = tree.insert(things, {
		parentName: stub.parentId,
		container,
		at,
	});
	if (added === 0) {
		for (const id of batch) tree.dead.add(id);
	}
	if (stub.children.length === 0) {
		removeNode(container, stub);
	} else {
		// Every returned comment leaves this stub's count, kept or dropped at the cap.
		const returned = things.filter((t) => t.kind === "t1").length;
		stub.count = Math.max(stub.children.length, stub.count - returned);
	}
}

async function continueThread(
	tree: CommentTree,
	stub: RedditMore,
	container: RedditNode[],
	fetchFn: typeof fetch,
	opts: ExpandOptions,
): Promise<void> {
	const parent = tree.get(stub.parentId);
	if (!parent) throw new Error(`continue stub without parent ${stub.parentId}`);
	tree.continued.add(stub.parentId);
	const json = await getJson(
		fetchFn,
		commentJsonUrl(opts.origin, opts.post, parent, opts.sort),
	);
	const things = repliesInResponse(json, parent.id);
	if (!things)
		throw new Error(`comment ${parent.id} missing from its permalink JSON`);
	const at = container.indexOf(stub);
	removeNode(container, stub);
	tree.insert(things, { parentName: stub.parentId, container, at });
}

/** The first expandable stub in breadth-first order, so shallow comments load first. */
function nextStub(
	root: RedditNode[],
	skip: WeakSet<RedditMore>,
): { stub: RedditMore; container: RedditNode[] } | undefined {
	let level: RedditNode[][] = [root];
	while (level.length > 0) {
		const deeper: RedditNode[][] = [];
		for (const container of level) {
			for (const node of container) {
				if (node.kind === "more") {
					if (!skip.has(node)) return { stub: node, container };
				} else if (node.replies.length > 0) {
					deeper.push(node.replies);
				}
			}
		}
		level = deeper;
	}
	return undefined;
}

function removeNode(container: RedditNode[], node: RedditNode): void {
	const i = container.indexOf(node);
	if (i >= 0) container.splice(i, 1);
}

/** `more` stubs anywhere in the tree. */
export function countStubs(nodes: RedditNode[]): number {
	let n = 0;
	for (const node of nodes) {
		n += node.kind === "more" ? 1 : countStubs(node.replies);
	}
	return n;
}
