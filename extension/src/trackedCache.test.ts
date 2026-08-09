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
		cache.set(URL_A, true);
		cache.set(URL_B, false);
		expect(cache.get(URL_A)).toBe(true);
		expect(cache.get(URL_B)).toBe(false);
	});

	it("keeps the value up to the TTL and drops it at/after expiry", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, true);
		advance(TTL - 1);
		expect(cache.get(URL_A)).toBe(true);
		advance(1); // exactly at the TTL boundary
		expect(cache.get(URL_A)).toBeUndefined();
	});

	it("expired entries stay gone, they don't resurrect", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, true);
		advance(TTL * 10);
		expect(cache.get(URL_A)).toBeUndefined();
		expect(cache.get(URL_A)).toBeUndefined();
	});

	it("re-setting refreshes the clock (a fresh write restarts the TTL)", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, true);
		advance(TTL - 1);
		cache.set(URL_A, true);
		advance(TTL - 1);
		expect(cache.get(URL_A)).toBe(true); // would have expired without the re-set
		advance(1);
		expect(cache.get(URL_A)).toBeUndefined();
	});

	it("an optimistic override wins over the cached value until it expires", () => {
		const { cache, advance } = withClock();
		// Resolved lookup says tracked; the popup then archives the page.
		cache.set(URL_A, true);
		advance(1_000);
		cache.set(URL_A, false); // optimistic override
		expect(cache.get(URL_A)).toBe(false);
		advance(TTL - 1);
		expect(cache.get(URL_A)).toBe(false); // still winning inside its own TTL
		advance(1);
		expect(cache.get(URL_A)).toBeUndefined(); // then falls back to a lookup
	});

	it("an optimistic true override wins over a cached false", () => {
		const { cache, advance } = withClock();
		cache.set(URL_A, false);
		cache.set(URL_A, true); // bookmarks.onCreated / CTA create ping
		advance(TTL - 1);
		expect(cache.get(URL_A)).toBe(true);
	});

	it("invalidate clears one url and leaves the others alone", () => {
		const { cache } = withClock();
		cache.set(URL_A, true);
		cache.set(URL_B, true);
		cache.invalidate(URL_A);
		expect(cache.get(URL_A)).toBeUndefined();
		expect(cache.get(URL_B)).toBe(true);
		// Invalidating an unknown url is a no-op, not an error.
		expect(() => {
			cache.invalidate("https://nope.example/");
		}).not.toThrow();
	});

	it("clear empties the whole cache", () => {
		const { cache } = withClock();
		cache.set(URL_A, true);
		cache.set(URL_B, false);
		cache.clear();
		expect(cache.size()).toBe(0);
		expect(cache.get(URL_A)).toBeUndefined();
	});

	it("keys on the RAW url — variants are distinct entries (no normalization)", () => {
		const { cache } = withClock();
		cache.set("https://example.com/a", true);
		expect(cache.get("https://example.com/a?utm_source=x")).toBeUndefined();
		expect(cache.get("https://example.com/a/")).toBeUndefined();
	});

	it("does not grow without bound: expired entries are swept on write", () => {
		const { cache, advance } = withClock();
		for (let i = 0; i < 200; i += 1)
			cache.set(`https://example.com/${i}`, true);
		advance(TTL + 1);
		cache.set("https://example.com/fresh", true);
		expect(cache.size()).toBe(1);
		expect(cache.get("https://example.com/fresh")).toBe(true);
	});

	it("statusFor shapes hits and misses for resolveIconState", () => {
		const { cache, advance } = withClock();
		expect(cache.statusFor(URL_A)).toEqual({ status: "unknown" });
		cache.set(URL_A, true);
		expect(cache.statusFor(URL_A)).toEqual({
			status: "tracked",
			tracked: true,
		});
		cache.set(URL_A, false);
		expect(cache.statusFor(URL_A)).toEqual({
			status: "tracked",
			tracked: false,
		});
		advance(TTL);
		expect(cache.statusFor(URL_A)).toEqual({ status: "unknown" });
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
		cache.set(URL_A, true);
		advance(TTL);
		expect(resolveIconState(cache.statusFor(URL_A))).toBe("default");
		cache.set(URL_A, true);
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
