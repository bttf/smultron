import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const NOW = new Date("2026-08-01T12:00:00.000Z");

function at(iso: string): string {
	return relativeTime(iso, NOW);
}

describe("relativeTime", () => {
	it("returns 'just now' under a minute", () => {
		expect(at("2026-08-01T11:59:59.000Z")).toBe("just now");
		expect(at("2026-08-01T11:59:01.000Z")).toBe("just now");
	});

	it("clamps future timestamps (clock skew) to 'just now'", () => {
		expect(at("2026-08-01T12:05:00.000Z")).toBe("just now");
	});

	it("formats minutes from 1m to 59m", () => {
		expect(at("2026-08-01T11:59:00.000Z")).toBe("1m");
		expect(at("2026-08-01T11:23:00.000Z")).toBe("37m");
		expect(at("2026-08-01T11:00:01.000Z")).toBe("59m");
	});

	it("formats hours from 1h to 23h", () => {
		expect(at("2026-08-01T11:00:00.000Z")).toBe("1h");
		expect(at("2026-07-31T13:00:00.000Z")).toBe("23h");
	});

	it("formats days up to 7d", () => {
		expect(at("2026-07-31T12:00:00.000Z")).toBe("1d");
		expect(at("2026-07-25T12:00:00.000Z")).toBe("7d");
	});

	it("falls back to a date beyond ~7 days (same year: no year)", () => {
		expect(at("2026-07-24T12:00:00.000Z")).toBe("Jul 24");
	});

	it("includes the year when it differs from now", () => {
		expect(at("2025-12-30T12:00:00.000Z")).toBe("Dec 30, 2025");
	});

	it("returns empty string for unparseable input", () => {
		expect(at("not a date")).toBe("");
	});
});
