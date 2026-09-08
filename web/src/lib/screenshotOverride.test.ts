// releaseClearedScreenshots — SPEC §9 "Clear screenshot" (RED-206).
import { describe, expect, it } from "vitest";
import { releaseClearedScreenshots } from "./screenshotOverride";

type Patch = {
	screenshotUrl?: string | null;
	title?: string;
};

const SHOT = "https://project.supabase.co/storage/v1/object/public/b/a.jpg";

describe("releaseClearedScreenshots", () => {
	it("releases the override once the server agrees the row has none", () => {
		const overrides = new Map<number, Patch>([[1, { screenshotUrl: null }]]);

		const next = releaseClearedScreenshots(overrides, [
			{ id: 1, screenshotUrl: null },
		]);

		expect(next.has(1)).toBe(false);
	});

	// The bug this exists to prevent: a released override lets the backfill's
	// new screenshot show; a held one would spread null over it forever.
	it("holds the override while the server still reports a screenshot", () => {
		const overrides = new Map<number, Patch>([[1, { screenshotUrl: null }]]);

		const next = releaseClearedScreenshots(overrides, [
			{ id: 1, screenshotUrl: SHOT },
		]);

		expect(next.get(1)).toEqual({ screenshotUrl: null });
	});

	it("keeps the row's other pending edits, dropping only screenshotUrl", () => {
		const overrides = new Map<number, Patch>([
			[1, { screenshotUrl: null, title: "Edited" }],
		]);

		const next = releaseClearedScreenshots(overrides, [
			{ id: 1, screenshotUrl: null },
		]);

		expect(next.get(1)).toEqual({ title: "Edited" });
	});

	it("never touches an override that isn't a cleared screenshot", () => {
		const overrides = new Map<number, Patch>([
			[1, { title: "Edited" }],
			[2, { screenshotUrl: SHOT }],
		]);

		const next = releaseClearedScreenshots(overrides, [
			{ id: 1, screenshotUrl: null },
			{ id: 2, screenshotUrl: null },
		]);

		expect(next).toBe(overrides);
	});

	it("leaves an override the server hasn't mentioned at all", () => {
		// The row is on a deeper page or outside the current view — nothing has
		// confirmed the clear, so the overlay stands.
		const overrides = new Map<number, Patch>([[9, { screenshotUrl: null }]]);

		expect(releaseClearedScreenshots(overrides, [])).toBe(overrides);
	});

	it("returns the same map when nothing is released (no re-render)", () => {
		const overrides = new Map<number, Patch>([[1, { screenshotUrl: null }]]);

		expect(
			releaseClearedScreenshots(overrides, [{ id: 1, screenshotUrl: SHOT }]),
		).toBe(overrides);
		expect(releaseClearedScreenshots(new Map<number, Patch>(), [])).toEqual(
			new Map(),
		);
	});

	it("releases across several rows and both server lists", () => {
		const overrides = new Map<number, Patch>([
			[1, { screenshotUrl: null }],
			[2, { screenshotUrl: null }],
			[3, { screenshotUrl: null }],
		]);

		// The caller passes the log page and the shelf concatenated.
		const next = releaseClearedScreenshots(overrides, [
			{ id: 1, screenshotUrl: null },
			{ id: 2, screenshotUrl: SHOT },
			{ id: 3, screenshotUrl: null },
		]);

		expect([...next.keys()]).toEqual([2]);
		// The input map is never mutated.
		expect([...overrides.keys()]).toEqual([1, 2, 3]);
	});
});
