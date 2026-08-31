import { describe, expect, it, vi } from "vitest";
import {
	createLatestOnly,
	displayHost,
	displayUrl,
	faviconUrlFor,
	fetchBookmarksPage,
	NEWTAB_SNAPSHOT_RECENT_CAP,
	type NewTabBookmark,
	parseBookmarksResponse,
	readSnapshot,
	writeSnapshot,
} from "./newtab";
import { type KeyValueStorage, NEWTAB_KEY } from "./types";

function memoryStorage(
	initial: Record<string, unknown> = {},
): KeyValueStorage & {
	values: Record<string, unknown>;
} {
	const values = { ...initial };
	return {
		values,
		async get(key) {
			return values[key];
		},
		async set(key, value) {
			values[key] = value;
		},
	};
}

function bookmark(over: Partial<NewTabBookmark> = {}): NewTabBookmark {
	return {
		id: 1,
		url: "https://example.com/a",
		title: "A",
		faviconUrl: null,
		tags: [],
		updatedAt: "2026-08-30T10:00:00.000Z",
		pinnedAt: null,
		...over,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const config = { token: "tok", baseUrl: "https://smultron.redpine.software" };

/** The request a mocked fetch actually received, typed for assertions. */
function firstCall(fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit] {
	const call = fetchImpl.mock.calls[0];
	if (call === undefined) throw new Error("fetch was never called");
	return call as [string, RequestInit];
}

describe("parseBookmarksResponse", () => {
	it("splits the listing into the shelf and the log", () => {
		const page = parseBookmarksResponse({
			bookmarks: [{ id: 2, url: "https://a.test/", title: "A", tags: ["x"] }],
			pinned: [{ id: 9, url: "https://p.test/", title: "P", tags: [] }],
			total: 12,
		});
		expect(page.recent.map((b) => b.id)).toEqual([2]);
		expect(page.pinned.map((b) => b.id)).toEqual([9]);
		expect(page.recent[0]?.tags).toEqual(["x"]);
	});

	it("drops unusable rows instead of failing the whole page", () => {
		// A new tab paints this on every open — one bad row must cost that row,
		// never the page.
		const page = parseBookmarksResponse({
			bookmarks: [
				{ id: 1, url: "https://ok.test/" },
				{ id: "not-a-number", url: "https://bad.test/" },
				{ id: 3 },
				null,
				"nope",
				{ id: 4, url: "" },
			],
			pinned: "not-an-array",
		});
		expect(page.recent.map((b) => b.id)).toEqual([1]);
		expect(page.pinned).toEqual([]);
	});

	it("fills absent optional fields rather than carrying undefined", () => {
		const [row] = parseBookmarksResponse({
			bookmarks: [{ id: 1, url: "https://ok.test/", tags: ["a", 7, null] }],
		}).recent;
		expect(row).toEqual({
			id: 1,
			url: "https://ok.test/",
			title: "",
			faviconUrl: null,
			tags: ["a"],
			updatedAt: "",
			pinnedAt: null,
		});
	});

	it("carries the pin timestamp the log's ★ reads (m22)", () => {
		const page = parseBookmarksResponse({
			bookmarks: [
				{ id: 1, url: "https://p.test/", pinnedAt: "2026-08-30T09:00:00.000Z" },
				{ id: 2, url: "https://u.test/", pinnedAt: 7 },
			],
		});
		expect(page.recent[0]?.pinnedAt).toBe("2026-08-30T09:00:00.000Z");
		// A wrong-typed value degrades to "not pinned", never to a bad row.
		expect(page.recent[1]?.pinnedAt).toBeNull();
	});

	it("survives a body that isn't a listing at all", () => {
		expect(parseBookmarksResponse(null)).toEqual({ pinned: [], recent: [] });
		expect(parseBookmarksResponse("boom")).toEqual({ pinned: [], recent: [] });
	});
});

describe("fetchBookmarksPage", () => {
	it("sends the pairing token and reads the feed when there is no query", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ bookmarks: [], pinned: [] }));

		const result = await fetchBookmarksPage(config, fetchImpl as never);

		expect(result.ok).toBe(true);
		const [url, init] = firstCall(fetchImpl);
		expect(url).toBe("https://smultron.redpine.software/api/bookmarks");
		expect(init.headers).toEqual({ Authorization: "Bearer tok" });
		expect(init.method).toBe("GET");
	});

	it("percent-encodes the search query", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ bookmarks: [], pinned: [] }));

		await fetchBookmarksPage(config, fetchImpl as never, { q: "a b&c=d" });

		expect(firstCall(fetchImpl)[0]).toBe(
			"https://smultron.redpine.software/api/bookmarks?q=a%20b%26c%3Dd",
		);
	});

	it("treats a whitespace-only query as no query", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ bookmarks: [], pinned: [] }));

		await fetchBookmarksPage(config, fetchImpl as never, { q: "   " });

		expect(firstCall(fetchImpl)[0]).toBe(
			"https://smultron.redpine.software/api/bookmarks",
		);
	});

	it("reports the status for a non-2xx (401 is the unpaired signal)", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
		const result = await fetchBookmarksPage(config, fetchImpl as never);
		expect(result).toEqual({ ok: false, status: 401 });
	});

	it("reports a network failure distinguishably from an HTTP status", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
		const result = await fetchBookmarksPage(config, fetchImpl as never);
		expect(result).toEqual({ ok: false, status: null, message: "offline" });
	});

	it("reports a malformed body as a network-class failure, never a throw", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("<html>", { status: 200 }));
		const result = await fetchBookmarksPage(config, fetchImpl as never);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBeNull();
	});

	it("passes the abort signal through", async () => {
		const controller = new AbortController();
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ bookmarks: [], pinned: [] }));
		await fetchBookmarksPage(config, fetchImpl as never, {
			signal: controller.signal,
		});
		expect(firstCall(fetchImpl)[1].signal).toBe(controller.signal);
	});
});

describe("new tab snapshot", () => {
	it("round-trips a page with its clock reading", async () => {
		const storage = memoryStorage();
		const page = {
			// The recent row is pinned too (m22): the log's ★ has to survive a
			// paint that comes from the cache rather than the network.
			pinned: [bookmark({ id: 9, pinnedAt: "2026-08-30T09:00:00.000Z" })],
			recent: [bookmark({ id: 2, pinnedAt: "2026-08-30T09:00:00.000Z" })],
		};

		await writeSnapshot(storage, page, 1_700_000_000_000);

		expect(await readSnapshot(storage)).toEqual({
			pinned: page.pinned,
			recent: page.recent,
			fetchedAtMs: 1_700_000_000_000,
		});
	});

	it("caps the recent rows it stores, keeping the newest", async () => {
		const storage = memoryStorage();
		const recent = Array.from({ length: 50 }, (_, i) => bookmark({ id: i }));

		await writeSnapshot(storage, { pinned: [], recent }, 1);

		const snapshot = await readSnapshot(storage);
		expect(snapshot?.recent).toHaveLength(NEWTAB_SNAPSHOT_RECENT_CAP);
		expect(snapshot?.recent[0]?.id).toBe(0);
	});

	it("keeps every pin (the shelf is small and always fully rendered)", async () => {
		const storage = memoryStorage();
		const pinned = Array.from({ length: 40 }, (_, i) => bookmark({ id: i }));
		await writeSnapshot(storage, { pinned, recent: [] }, 1);
		expect((await readSnapshot(storage))?.pinned).toHaveLength(40);
	});

	it("reads an absent key as no cache", async () => {
		expect(await readSnapshot(memoryStorage())).toBeUndefined();
	});

	it.each([
		["a string", "nonsense"],
		["a number", 7],
		["null", null],
		["an object with no clock", { pinned: [], recent: [] }],
		["an object with no rows", { fetchedAtMs: 1 }],
		["a legacy shape", { bookmarks: [], fetchedAtMs: 1 }],
		["a wrong-typed clock", { pinned: [], recent: [], fetchedAtMs: "soon" }],
	])("degrades %s to no cache", async (_label, value) => {
		const storage = memoryStorage({ [NEWTAB_KEY]: value });
		expect(await readSnapshot(storage)).toBeUndefined();
	});

	it("degrades a storage failure to no cache instead of throwing", async () => {
		const storage: KeyValueStorage = {
			get: () => Promise.reject(new Error("storage gone")),
			set: () => Promise.resolve(),
		};
		await expect(readSnapshot(storage)).resolves.toBeUndefined();
	});

	it("drops unusable rows out of a cached page", async () => {
		const storage = memoryStorage({
			[NEWTAB_KEY]: {
				pinned: [{ id: 1, url: "https://ok.test/" }],
				recent: [{ id: "bad" }, { id: 2, url: "https://ok2.test/" }],
				fetchedAtMs: 5,
			},
		});
		const snapshot = await readSnapshot(storage);
		expect(snapshot?.recent.map((b) => b.id)).toEqual([2]);
		expect(snapshot?.pinned.map((b) => b.id)).toEqual([1]);
	});

	it("swallows a write failure — the page already rendered", async () => {
		const storage: KeyValueStorage = {
			get: () => Promise.resolve(undefined),
			set: () => Promise.reject(new Error("quota")),
		};
		await expect(
			writeSnapshot(storage, { pinned: [], recent: [] }, 1),
		).resolves.toBeUndefined();
	});
});

describe("createLatestOnly", () => {
	it("discards a slow earlier response that settles after a later one", async () => {
		const run = createLatestOnly<string>();
		let resolveFirst: (value: string) => void = () => {};
		const first = run(
			() =>
				new Promise<string>((resolve) => {
					resolveFirst = resolve;
				}),
		);
		const second = run(() => Promise.resolve("second"));

		expect(await second).toBe("second");
		resolveFirst("first");
		// "first" started earlier but landed later — it must never paint.
		expect(await first).toBeUndefined();
	});

	it("keeps the latest result even when responses arrive in order", async () => {
		const run = createLatestOnly<string>();
		expect(await run(() => Promise.resolve("a"))).toBe("a");
		expect(await run(() => Promise.resolve("b"))).toBe("b");
	});

	it("lets a rejection reach its own caller without wedging the sequencer", async () => {
		const run = createLatestOnly<string>();
		await expect(run(() => Promise.reject(new Error("boom")))).rejects.toThrow(
			"boom",
		);
		expect(await run(() => Promise.resolve("after"))).toBe("after");
	});
});

describe("display helpers", () => {
	it("shows host plus path, dropping a bare root slash", () => {
		expect(displayUrl("https://example.com/")).toBe("example.com");
		expect(displayUrl("https://example.com/a/b")).toBe("example.com/a/b");
		expect(displayUrl("https://example.com:8443/a")).toBe("example.com:8443/a");
		expect(displayUrl("not a url")).toBe("not a url");
	});

	it("shows the bare host for shelf cards", () => {
		expect(displayHost("https://example.com/a/b")).toBe("example.com");
		expect(displayHost("nope")).toBe("nope");
	});

	it("prefers the stored favicon and falls back to the hostname service", () => {
		expect(
			faviconUrlFor(bookmark({ faviconUrl: "https://x.test/i.png" })),
		).toBe("https://x.test/i.png");
		expect(faviconUrlFor(bookmark({ url: "https://example.com/a" }))).toBe(
			"https://www.google.com/s2/favicons?domain=example.com&sz=32",
		);
		expect(faviconUrlFor(bookmark({ faviconUrl: "" }))).toContain(
			"s2/favicons",
		);
		expect(faviconUrlFor(bookmark({ url: "not a url" }))).toBeUndefined();
	});
});
