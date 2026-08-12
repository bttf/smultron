import { describe, expect, it } from "vitest";
import {
	BROWSE_EVENT_KINDS,
	dayKey,
	formatDayDivider,
	formatEventDetail,
	formatEventTime,
	kindBadgeStyle,
	withDayDividers,
} from "./eventLog";

// Local-time constructor + ISO round-trip: the helpers format in local time
// (see the module header), so the fixtures must be built in local time too or
// the expectations would only hold in UTC.
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0): Date =>
	new Date(y, m - 1, d, h, min, s);
const iso = (...args: Parameters<typeof at>): string =>
	at(...args).toISOString();

describe("formatEventTime", () => {
	it("formats HH:MM:SS, zero-padded", () => {
		expect(formatEventTime(at(2026, 8, 11, 9, 4, 3))).toBe("09:04:03");
		expect(formatEventTime(at(2026, 8, 11, 0, 0, 0))).toBe("00:00:00");
	});

	it("is 24h — no am/pm wrap", () => {
		expect(formatEventTime(at(2026, 8, 11, 13, 30, 59))).toBe("13:30:59");
		expect(formatEventTime(at(2026, 8, 11, 23, 59, 59))).toBe("23:59:59");
	});
});

describe("dayKey", () => {
	it("is the local calendar day, zero-padded", () => {
		expect(dayKey(at(2026, 8, 1, 23, 59, 59))).toBe("2026-08-01");
		expect(dayKey(at(2026, 12, 31, 0, 0, 0))).toBe("2026-12-31");
	});

	it("differs across midnight and matches within a day", () => {
		expect(dayKey(at(2026, 8, 11, 23, 59, 59))).not.toBe(
			dayKey(at(2026, 8, 12, 0, 0, 1)),
		);
		expect(dayKey(at(2026, 8, 11, 0, 0, 1))).toBe(
			dayKey(at(2026, 8, 11, 23, 59, 59)),
		);
	});
});

describe("formatDayDivider", () => {
	const now = at(2026, 8, 11, 12);

	it("omits the year inside the current year", () => {
		expect(formatDayDivider(at(2026, 8, 11, 9), now)).toBe("Tue Aug 11");
	});

	it("includes the year outside it", () => {
		expect(formatDayDivider(at(2025, 7, 3, 9), now)).toBe("Thu Jul 3 2025");
	});
});

describe("withDayDividers", () => {
	it("marks the first row and every day change, nothing else", () => {
		const now = at(2026, 8, 11, 12);
		const rows = withDayDividers(
			[
				{ occurredAt: iso(2026, 8, 11, 10, 0, 0) },
				{ occurredAt: iso(2026, 8, 11, 9, 30, 0) },
				{ occurredAt: iso(2026, 8, 10, 23, 0, 0) },
				{ occurredAt: iso(2026, 8, 10, 8, 0, 0) },
				{ occurredAt: iso(2026, 8, 9, 22, 0, 0) },
			],
			now,
		);
		expect(rows.map((r) => r.divider)).toEqual([
			"Tue Aug 11",
			null,
			"Mon Aug 10",
			null,
			"Sun Aug 9",
		]);
	});

	it("keeps the events, in order, untouched", () => {
		const input = [
			{ occurredAt: iso(2026, 8, 11, 10), id: 2 },
			{ occurredAt: iso(2026, 8, 11, 9), id: 1 },
		];
		expect(withDayDividers(input).map((r) => r.event)).toEqual(input);
	});

	it("handles an empty page", () => {
		expect(withDayDividers([])).toEqual([]);
	});
});

describe("formatEventDetail", () => {
	it("shows the transition for nav", () => {
		expect(
			formatEventDetail({ kind: "nav", transition: "typed|from_address_bar" }),
		).toBe("typed|from_address_bar");
	});

	it("appends documentLifecycle to a nav (prerendered commits stay visible)", () => {
		expect(
			formatEventDetail({
				kind: "nav",
				transition: "link",
				documentLifecycle: "prerender",
			}),
		).toBe("link · prerender");
		expect(
			formatEventDetail({ kind: "nav", documentLifecycle: "prerender" }),
		).toBe("prerender");
	});

	it("shows the idle state for idle", () => {
		expect(formatEventDetail({ kind: "idle", idleState: "locked" })).toBe(
			"locked",
		);
	});

	it("is empty for the other kinds, and for missing fields", () => {
		expect(formatEventDetail({ kind: "nav" })).toBe("");
		expect(formatEventDetail({ kind: "idle", idleState: null })).toBe("");
		for (const kind of [
			"tab_activated",
			"window_focus",
			"window_blur",
			"capture_start",
			"capture_stop",
		]) {
			// Fields that belong to other kinds must never leak into the column.
			expect(
				formatEventDetail({
					kind,
					transition: "link",
					idleState: "idle",
					documentLifecycle: "prerender",
				}),
			).toBe("");
		}
	});
});

describe("kindBadgeStyle", () => {
	it("covers every §13 kind", () => {
		expect(BROWSE_EVENT_KINDS).toHaveLength(7);
		for (const kind of BROWSE_EVENT_KINDS) {
			expect(kindBadgeStyle(kind)).toBeDefined();
		}
	});

	it("only ever uses --log-* palette variables (never a literal color)", () => {
		const values = BROWSE_EVENT_KINDS.flatMap((kind) =>
			Object.values(kindBadgeStyle(kind)),
		);
		expect(values.length).toBeGreaterThan(0);
		for (const value of values) {
			expect(
				value === "transparent" || /^var\(--log-[a-z-]+\)$/.test(value),
			).toBe(true);
		}
	});

	it("distinguishes the kinds a scan depends on", () => {
		expect(kindBadgeStyle("nav")).not.toEqual(kindBadgeStyle("tab_activated"));
		expect(kindBadgeStyle("window_focus")).not.toEqual(
			kindBadgeStyle("window_blur"),
		);
		expect(kindBadgeStyle("capture_start")).not.toEqual(
			kindBadgeStyle("capture_stop"),
		);
	});

	it("falls back to a neutral chip for an unknown kind", () => {
		const fallback = kindBadgeStyle("something_new");
		expect(fallback.color).toBe("var(--log-chip-fg)");
		// …and no known kind renders as the fallback, so "unstyled" is visible.
		for (const kind of BROWSE_EVENT_KINDS) {
			expect(kindBadgeStyle(kind)).not.toEqual(fallback);
		}
	});
});
