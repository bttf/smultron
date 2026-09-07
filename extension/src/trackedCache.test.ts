import { describe, expect, it } from "vitest";
import {
	createTrackedCache,
	isTrackableUrl,
	isTrackedBookmark,
	parseTrackedChangedMessage,
	resolveIconState,
	TRACKED_CHANGED,
	type TrackedCache,
	type TrackedStatus,
	trackedChangedMessage,
	trackedEntryFor,
} from "./trackedCache";

const TTL = 30_000;
const URL_A = "https://example.com/a?utm_source=x";
const URL_B = "https://example.com/b";

/** Manual clock: tests advance time explicitly — no timers, no fake timers. */
function withClock(ttlMs = TTL): {
	cache: TrackedCache;
	advance: (ms: number) => void;
} {
	let time = 1_000;
	const cache = createTrackedCache({ ttlMs, now: () => time });
	return {
		cache,
		advance: (ms) => {
			time += ms;
		},
	};
}

describe("createTrackedCache", () => {
	it("returns undefined for a url it has never seen", () => {
		const { cache } = withClock();
		expect(cache.get(URL_A)).toBeUndefined();
	});

	it("returns a freshly set value (both polarities)", () => {
		const { cache } = withClock();
		cache.set(URL_A, { tracked: true });
		cache.set(URL_B, { tracked: false });
		expect(cache.get(URL_A)).toEqual({ tracked: true });
		expect(cache.get(URL_B)).toEqual({ tracked: false });
	});

	it("keeps the value up to the TTL and drops it at/after expiry", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, { tracked: true });
		advance(TTL - 1);
		expect(cache.get(URL_A)).toEqual({ tracked: true });
		advance(1); // exactly at the TTL boundary
		expect(cache.get(URL_A)).toBeUndefined();
	});

	it("expired entries stay gone, they don't resurrect", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, { tracked: true });
		advance(TTL * 10);
		expect(cache.get(URL_A)).toBeUndefined();
		expect(cache.get(URL_A)).toBeUndefined();
	});

	it("re-setting refreshes the clock (a fresh write restarts the TTL)", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, { tracked: true });
		advance(TTL - 1);
		cache.set(URL_A, { tracked: true });
		advance(TTL - 1);
		expect(cache.get(URL_A)).toEqual({ tracked: true }); // would have expired without the re-set
		advance(1);
		expect(cache.get(URL_A)).toBeUndefined();
	});

	it("an optimistic override wins over the cached value until it expires", () => {
		const { cache, advance } = withClock();
		// Resolved lookup says tracked; the popup then archives the page.
		cache.set(URL_A, { tracked: true });
		advance(1_000);
		cache.set(URL_A, { tracked: false }); // optimistic override
		expect(cache.get(URL_A)).toEqual({ tracked: false });
		advance(TTL - 1);
		expect(cache.get(URL_A)).toEqual({ tracked: false }); // still winning inside its own TTL
		advance(1);
		expect(cache.get(URL_A)).toBeUndefined(); // then falls back to a lookup
	});

	it("an optimistic true override wins over a cached false", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, { tracked: false });
		cache.set(URL_A, { tracked: true }); // bookmarks.onCreated / CTA create ping
		advance(TTL - 1);
		expect(cache.get(URL_A)).toEqual({ tracked: true });
	});

	it("invalidate clears one url and leaves the others alone", () => {
		const { cache } = withClock();
		cache.set(URL_A, { tracked: true });
		cache.set(URL_B, { tracked: true });
		cache.invalidate(URL_A);
		expect(cache.get(URL_A)).toBeUndefined();
		expect(cache.get(URL_B)).toEqual({ tracked: true });
		// Invalidating an unknown url is a no-op, not an error.
		expect(() => {
			cache.invalidate("https://nope.example/");
		}).not.toThrow();
	});

	it("clear empties the whole cache", () => {
		const { cache } = withClock();
		cache.set(URL_A, { tracked: true });
		cache.set(URL_B, { tracked: false });
		cache.clear();
		expect(cache.size()).toBe(0);
		expect(cache.get(URL_A)).toBeUndefined();
	});

	it("keys on the RAW url — variants are distinct entries (no normalization)", () => {
		const { cache } = withClock();
		cache.set("https://example.com/a", { tracked: true });
		expect(cache.get("https://example.com/a?utm_source=x")).toBeUndefined();
		expect(cache.get("https://example.com/a/")).toBeUndefined();
	});

	it("does not grow without bound: expired entries are swept on write", () => {
		const { cache, advance } = withClock();
		for (let i = 0; i < 200; i += 1)
			cache.set(`https://example.com/${i}`, { tracked: true });
		advance(TTL + 1);
		cache.set("https://example.com/fresh", { tracked: true });
		expect(cache.size()).toBe(1);
		expect(cache.get("https://example.com/fresh")).toEqual({ tracked: true });
	});

	it("statusFor shapes hits and misses for resolveIconState", () => {
		const { cache, advance } = withClock();
		expect(cache.statusFor(URL_A)).toEqual({ status: "unknown" });
		cache.set(URL_A, { tracked: true });
		expect(cache.statusFor(URL_A)).toEqual({
			status: "tracked",
			tracked: true,
		});
		cache.set(URL_A, { tracked: false });
		expect(cache.statusFor(URL_A)).toEqual({
			status: "tracked",
			tracked: false,
		});
		advance(TTL);
		expect(cache.statusFor(URL_A)).toEqual({ status: "unknown" });
	});

	// --- m23 (SPEC §15.4): the widened value -------------------------------

	it("a lookup stores all three fields and reads them back verbatim", () => {
		const { cache } = withClock();
		cache.set(URL_A, {
			tracked: true,
			bookmarkId: "bm-1",
			hasScreenshot: false,
		});
		expect(cache.get(URL_A)).toEqual({
			tracked: true,
			bookmarkId: "bm-1",
			hasScreenshot: false,
		});
	});

	it("an optimistic override stores `tracked` alone — no screenshot state", () => {
		const { cache } = withClock();
		cache.set(URL_A, { tracked: true }); // onCreated / popup ping
		const entry = cache.get(URL_A);
		expect(entry).toEqual({ tracked: true });
		expect(entry?.bookmarkId).toBeUndefined();
		expect(entry?.hasScreenshot).toBeUndefined();
	});

	it("an override REPLACES a full entry rather than merging into it", () => {
		const { cache } = withClock();
		cache.set(URL_A, {
			tracked: true,
			bookmarkId: "bm-1",
			hasScreenshot: true,
		});
		cache.set(URL_A, { tracked: false }); // the popup archived the page
		expect(cache.get(URL_A)).toEqual({ tracked: false });
	});

	it("statusFor reads ONLY `tracked` off a full entry (the icon is unchanged)", () => {
		const { cache } = withClock();
		cache.set(URL_A, {
			tracked: true,
			bookmarkId: "bm-1",
			hasScreenshot: false,
		});
		expect(cache.statusFor(URL_A)).toEqual({
			status: "tracked",
			tracked: true,
		});
		expect(resolveIconState(cache.statusFor(URL_A))).toBe("glow");
		cache.set(URL_B, {
			tracked: false,
			bookmarkId: "bm-2",
			hasScreenshot: true,
		});
		expect(resolveIconState(cache.statusFor(URL_B))).toBe("default");
	});

	it("the extra fields expire with the entry", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, {
			tracked: true,
			bookmarkId: "bm-1",
			hasScreenshot: false,
		});
		advance(TTL);
		expect(cache.get(URL_A)).toBeUndefined();
	});
});

describe("trackedEntryFor", () => {
	it("keeps the row's id and screenshot state alongside tracked", () => {
		// The server serializes the integer id as a JSON number (the real
		// by-url shape); the key is its decimal string.
		expect(
			trackedEntryFor({ id: 90453, archivedAt: null, screenshotUrl: null }),
		).toEqual({ tracked: true, bookmarkId: "90453", hasScreenshot: false });
		expect(
			trackedEntryFor({
				id: 90453,
				archivedAt: null,
				screenshotUrl: "https://cdn.example/s/u/90453/abc.jpg",
			}),
		).toEqual({ tracked: true, bookmarkId: "90453", hasScreenshot: true });
	});

	it("a string id is accepted as-is", () => {
		expect(
			trackedEntryFor({ id: "bm-1", archivedAt: null, screenshotUrl: null }),
		).toEqual({ tracked: true, bookmarkId: "bm-1", hasScreenshot: false });
	});

	it("an archived row is untracked but still identifiable", () => {
		expect(
			trackedEntryFor({
				id: "bm-1",
				archivedAt: "2026-09-01T00:00:00.000Z",
				screenshotUrl: null,
			}),
		).toEqual({ tracked: false, bookmarkId: "bm-1", hasScreenshot: false });
	});

	it("no row yields `{ tracked: false }` and nothing else", () => {
		expect(trackedEntryFor(null)).toEqual({ tracked: false });
		expect(trackedEntryFor(undefined)).toEqual({ tracked: false });
	});

	it("a body without screenshotUrl leaves hasScreenshot undefined", () => {
		// An older server: absent is uncertainty, never a guessed `true`.
		const entry = trackedEntryFor({ id: "bm-1", archivedAt: null });
		expect(entry).toEqual({ tracked: true, bookmarkId: "bm-1" });
		expect(entry.hasScreenshot).toBeUndefined();
	});

	it("a missing, empty or non-integer id leaves bookmarkId undefined", () => {
		expect(trackedEntryFor({ archivedAt: null, screenshotUrl: null })).toEqual({
			tracked: true,
			hasScreenshot: false,
		});
		expect(
			trackedEntryFor({ id: "", archivedAt: null, screenshotUrl: null }),
		).toEqual({ tracked: true, hasScreenshot: false });
		expect(
			trackedEntryFor({ id: 1.5, archivedAt: null, screenshotUrl: null }),
		).toEqual({ tracked: true, hasScreenshot: false });
	});
});

describe("resolveIconState", () => {
	it("glows only for a definite tracked === true", () => {
		expect(resolveIconState({ status: "tracked", tracked: true })).toBe("glow");
	});

	it("never glows on uncertainty", () => {
		const uncertain: Array<TrackedStatus | undefined> = [
			{ status: "tracked", tracked: false }, // archived / not bookmarked
			{ status: "unknown" }, // cache miss, lookup still in flight
			{ status: "error" }, // network error or non-2xx
			{ status: "unpaired" }, // no token stored
			{ status: "unsupported" }, // non-http(s) or missing URL
			undefined,
		];
		for (const input of uncertain) {
			expect(resolveIconState(input)).toBe("default");
		}
	});

	it("a cache miss resolves to the default icon end to end", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, { tracked: true });
		advance(TTL);
		expect(resolveIconState(cache.statusFor(URL_A))).toBe("default");
		cache.set(URL_A, { tracked: true });
		expect(resolveIconState(cache.statusFor(URL_A))).toBe("glow");
	});
});

describe("isTrackableUrl", () => {
	it("accepts http(s) pages", () => {
		expect(isTrackableUrl("https://example.com/a")).toBe(true);
		expect(isTrackableUrl("http://localhost:3000/")).toBe(true);
		expect(isTrackableUrl("HTTPS://EXAMPLE.COM/")).toBe(true);
	});

	it("rejects everything else, including missing urls", () => {
		for (const url of [
			undefined,
			null,
			"",
			"chrome://extensions",
			"chrome-extension://abc/popup.html",
			"about:blank",
			"file:///Users/me/notes.txt",
			"ftp://example.com/x",
			"javascript:void(0)",
		]) {
			expect(isTrackableUrl(url)).toBe(false);
		}
	});

	it("an untrackable url can never glow", () => {
		const status: TrackedStatus = isTrackableUrl("chrome://newtab")
			? { status: "tracked", tracked: true }
			: { status: "unsupported" };
		expect(resolveIconState(status)).toBe("default");
	});
});

describe("isTrackedBookmark", () => {
	it("is true only for an existing, non-archived row", () => {
		expect(isTrackedBookmark({ archivedAt: null })).toBe(true);
		expect(isTrackedBookmark({ archivedAt: "2026-08-09T00:00:00.000Z" })).toBe(
			false,
		);
		expect(isTrackedBookmark(null)).toBe(false);
		expect(isTrackedBookmark(undefined)).toBe(false);
	});
});

describe("parseTrackedChangedMessage", () => {
	it("accepts a well-formed ping", () => {
		expect(
			parseTrackedChangedMessage(trackedChangedMessage(URL_A, true)),
		).toEqual({ kind: TRACKED_CHANGED, url: URL_A, tracked: true });
		expect(
			parseTrackedChangedMessage({
				kind: TRACKED_CHANGED,
				url: URL_A,
				tracked: false,
			}),
		).toEqual({ kind: TRACKED_CHANGED, url: URL_A, tracked: false });
	});

	it("ignores anything else on the shared channel", () => {
		for (const message of [
			undefined,
			null,
			42,
			"tracked-changed",
			[],
			{},
			{ kind: "something-else", url: URL_A, tracked: true },
			{ kind: TRACKED_CHANGED, tracked: true },
			{ kind: TRACKED_CHANGED, url: URL_A },
			{ kind: TRACKED_CHANGED, url: "", tracked: true },
			{ kind: TRACKED_CHANGED, url: 7, tracked: true },
			{ kind: TRACKED_CHANGED, url: URL_A, tracked: "true" },
			{ kind: TRACKED_CHANGED, url: URL_A, tracked: 1 },
		]) {
			expect(parseTrackedChangedMessage(message)).toBeUndefined();
		}
	});

	it("strips extra fields — only the contract's three survive", () => {
		expect(
			parseTrackedChangedMessage({
				kind: TRACKED_CHANGED,
				url: URL_A,
				tracked: true,
				extra: "ignored",
			}),
		).toEqual({ kind: TRACKED_CHANGED, url: URL_A, tracked: true });
	});
});
