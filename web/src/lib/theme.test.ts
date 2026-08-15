import { describe, expect, it } from "vitest";
import {
	applyResolvedTheme,
	DEFAULT_THEME_PREFERENCE,
	isThemePreference,
	parseThemePreference,
	resolveTheme,
	THEME_INIT_SCRIPT,
	THEME_STORAGE_KEY,
	type ThemePreference,
} from "./theme";

describe("isThemePreference", () => {
	it("accepts exactly the three preferences", () => {
		expect(isThemePreference("system")).toBe(true);
		expect(isThemePreference("light")).toBe(true);
		expect(isThemePreference("dark")).toBe(true);
	});

	it("rejects anything else", () => {
		for (const value of [
			"System",
			"auto",
			"",
			null,
			undefined,
			0,
			{ theme: "dark" },
		]) {
			expect(isThemePreference(value)).toBe(false);
		}
	});
});

describe("parseThemePreference", () => {
	it("passes through valid preferences", () => {
		expect(parseThemePreference("dark")).toBe("dark");
		expect(parseThemePreference("light")).toBe("light");
		expect(parseThemePreference("system")).toBe("system");
	});

	it("degrades unknown/corrupt values to the system default", () => {
		expect(parseThemePreference(null)).toBe(DEFAULT_THEME_PREFERENCE);
		expect(parseThemePreference("nonsense")).toBe(DEFAULT_THEME_PREFERENCE);
		expect(DEFAULT_THEME_PREFERENCE).toBe("system");
	});
});

describe("resolveTheme", () => {
	it("follows the system query when the preference is system", () => {
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
	});

	// The whole point of the feature: an explicit choice wins over whatever
	// the browser reports, in BOTH directions.
	it("pins the palette when the preference is explicit", () => {
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("light", false)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
		expect(resolveTheme("dark", true)).toBe("dark");
	});

	it("never resolves to anything but light or dark", () => {
		const preferences: ThemePreference[] = ["system", "light", "dark"];
		for (const preference of preferences) {
			for (const dark of [true, false]) {
				expect(["light", "dark"]).toContain(resolveTheme(preference, dark));
			}
		}
	});
});

describe("applyResolvedTheme", () => {
	it("writes the resolved scheme onto the element's dataset", () => {
		const root = { dataset: {} as DOMStringMap };
		applyResolvedTheme(root, "dark");
		expect(root.dataset.theme).toBe("dark");
		applyResolvedTheme(root, "light");
		expect(root.dataset.theme).toBe("light");
	});
});

describe("THEME_INIT_SCRIPT", () => {
	// The script is inlined into <head> as raw HTML: a literal `</script>` in
	// it would close the tag early and dump the rest onto the page.
	it("is safe to inline", () => {
		expect(THEME_INIT_SCRIPT).not.toMatch(/<\/script/i);
		expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY);
	});

	/**
	 * Runs the real script source against a minimal window/document stand-in.
	 * Keeps the hand-written script honest about the same contract
	 * `resolveTheme` is tested against.
	 */
	function runInitScript(options: {
		stored?: string | null;
		systemDark: boolean;
		storageThrows?: boolean;
	}): string | undefined {
		const documentElement = { dataset: {} as DOMStringMap };
		const win = {
			localStorage: {
				getItem(key: string) {
					if (options.storageThrows) throw new Error("blocked");
					return key === THEME_STORAGE_KEY ? (options.stored ?? null) : null;
				},
			},
			matchMedia: () => ({ matches: options.systemDark }),
			document: { documentElement },
		};
		new Function("window", "document", THEME_INIT_SCRIPT)(win, win.document);
		return documentElement.dataset.theme;
	}

	it("resolves a stored preference the same way resolveTheme does", () => {
		expect(runInitScript({ stored: "dark", systemDark: false })).toBe("dark");
		expect(runInitScript({ stored: "light", systemDark: true })).toBe("light");
		expect(runInitScript({ stored: "system", systemDark: true })).toBe("dark");
		expect(runInitScript({ stored: "system", systemDark: false })).toBe(
			"light",
		);
	});

	it("defaults to the system scheme with nothing stored", () => {
		expect(runInitScript({ stored: null, systemDark: true })).toBe("dark");
		expect(runInitScript({ stored: null, systemDark: false })).toBe("light");
	});

	it("ignores a corrupt stored value instead of pinning a wrong scheme", () => {
		expect(runInitScript({ stored: "Dark", systemDark: false })).toBe("light");
		expect(runInitScript({ stored: "nonsense", systemDark: true })).toBe(
			"dark",
		);
	});

	it("still resolves when storage is unavailable", () => {
		expect(runInitScript({ systemDark: true, storageThrows: true })).toBe(
			"dark",
		);
		expect(runInitScript({ systemDark: false, storageThrows: true })).toBe(
			"light",
		);
	});
});
