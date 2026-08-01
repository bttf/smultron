import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const NOW = new Date("2026-08-01T12:00:00.000Z");

describe("relativeTime", () => {
	it("says 'just now' under 45s", () => {
		expect(relativeTime(new Date(NOW.getTime() - 10_000), NOW)).toBe(
			"just now",
		);
		expect(relativeTime(new Date(NOW.getTime() - 44_000), NOW)).toBe(
			"just now",
		);
	});

	it("formats minutes ago", () => {
		expect(relativeTime(new Date(NOW.getTime() - 5 * 60 * 1000), NOW)).toBe(
			"5 minutes ago",
		);
	});

	it("formats hours ago", () => {
		expect(
			relativeTime(new Date(NOW.getTime() - 3 * 60 * 60 * 1000), NOW),
		).toBe("3 hours ago");
	});

	it("formats days ago", () => {
		expect(
			relativeTime(new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000), NOW),
		).toBe("2 days ago");
	});

	it("formats yesterday specially via Intl (numeric: auto)", () => {
		expect(
			relativeTime(new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000), NOW),
		).toBe("yesterday");
	});

	it("formats future times", () => {
		expect(relativeTime(new Date(NOW.getTime() + 5 * 60 * 1000), NOW)).toBe(
			"in 5 minutes",
		);
	});

	it("formats months and years ago", () => {
		expect(
			relativeTime(new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000), NOW),
		).toBe("3 months ago");
		expect(
			relativeTime(new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000), NOW),
		).toBe("last year");
	});
});
