// Theme preference (SPEC §Theming).
//
// `system` — the default — follows `prefers-color-scheme`. `light`/`dark` pin
// the palette regardless of what the browser reports, which is the escape
// hatch for browsers that force a scheme on web content independently of the
// OS setting (Chrome's own appearance setting, Android's "Dark theme", the
// force-dark flag) — those make a media-query-only site look permanently dark
// with nothing the user can do about it from inside the page.
//
// The RESOLVED value ("light" | "dark") is what lands on `<html data-theme>`;
// `globals.css` keys its dark palette off `:root[data-theme="dark"]` and
// nothing else, so there is exactly one dark palette in the stylesheet. The
// preference itself (which may be "system") is what gets persisted.

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** What actually gets painted — "system" is always resolved away first. */
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "smultron:theme";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
	return (
		typeof value === "string" &&
		(THEME_PREFERENCES as readonly string[]).includes(value)
	);
}

/**
 * Anything unrecognized (missing key, a value from an older build, a string
 * someone typed into devtools) degrades to the system default rather than
 * throwing — a corrupt preference must never leave the app unstyled.
 */
export function parseThemePreference(value: unknown): ThemePreference {
	return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
}

export function resolveTheme(
	preference: ThemePreference,
	systemPrefersDark: boolean,
): ResolvedTheme {
	if (preference === "system") {
		return systemPrefersDark ? "dark" : "light";
	}
	return preference;
}

/** Reads the stored preference; unavailable storage (Safari private mode,
 *  blocked cookies) is treated as "not set", never as an error. */
export function readStoredPreference(): ThemePreference {
	try {
		return parseThemePreference(
			globalThis.localStorage?.getItem(THEME_STORAGE_KEY),
		);
	} catch {
		return DEFAULT_THEME_PREFERENCE;
	}
}

export function writeStoredPreference(preference: ThemePreference): void {
	try {
		globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference);
	} catch {
		// Best-effort: the preference still applies for this page load.
	}
}

export function systemPrefersDark(): boolean {
	return (
		typeof globalThis.matchMedia === "function" &&
		globalThis.matchMedia(DARK_SCHEME_QUERY).matches
	);
}

/** The single place that mutates the document — the inline script below does
 *  the same thing by hand, since it must run before React exists. */
export function applyResolvedTheme(
	root: { dataset: DOMStringMap },
	resolved: ResolvedTheme,
): void {
	root.dataset.theme = resolved;
}

// Runs blocking in <head>, before first paint, so the resolved palette is on
// the element by the time anything is painted (no light-then-dark flash). Kept
// dependency-free and interpolated from the constants above so the storage key
// and the preference names have one definition. Wrapped in try/catch: a theme
// failure must never take the page down with it.
export const THEME_INIT_SCRIPT = `(function(){try{var p=null;try{p=window.localStorage.getItem(${JSON.stringify(
	THEME_STORAGE_KEY,
)});}catch(e){}if(${JSON.stringify(
	THEME_PREFERENCES as readonly string[],
)}.indexOf(p)===-1){p=${JSON.stringify(DEFAULT_THEME_PREFERENCE)};}var d=p==="dark"||(p==="system"&&window.matchMedia(${JSON.stringify(
	DARK_SCHEME_QUERY,
)}).matches);document.documentElement.dataset.theme=d?"dark":"light";}catch(e){}})();`;
