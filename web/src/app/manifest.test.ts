import { describe, expect, it } from "vitest";
import manifest from "./manifest";

describe("web app manifest", () => {
	const m = manifest();

	it("is a standalone installable app", () => {
		expect(m.name).toBe("Smultronstället");
		expect(m.short_name).toBe("Smultron");
		expect(m.display).toBe("standalone");
		expect(m.start_url).toBe("/");
		expect(m.description).toBeTruthy();
		expect(m.theme_color).toBe("#ffffff");
		expect(m.background_color).toBe("#ffffff");
	});

	it("declares the share target that /share handles", () => {
		expect(m.share_target).toEqual({
			action: "/share",
			method: "GET",
			params: { title: "title", text: "text", url: "url" },
		});
	});

	it("ships any + maskable icons at 192 and 512 from /icons/", () => {
		const icons = m.icons ?? [];
		expect(icons.length).toBeGreaterThanOrEqual(4);
		for (const icon of icons) {
			expect(icon.src.startsWith("/icons/")).toBe(true);
			expect(icon.type).toBe("image/png");
		}
		const key = (purpose: string, sizes: string) =>
			icons.some((i) => i.purpose === purpose && i.sizes === sizes);
		expect(key("any", "192x192")).toBe(true);
		expect(key("any", "512x512")).toBe(true);
		expect(key("maskable", "192x192")).toBe(true);
		expect(key("maskable", "512x512")).toBe(true);
	});
});
