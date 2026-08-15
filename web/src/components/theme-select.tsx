"use client";
// Appearance control (SPEC §Theming) — the only UI over the theme preference.
//
// Renders a native <select> on purpose: it inherits the root `color-scheme`,
// so the dropdown itself is themed by the browser, and it needs no popover
// code. The stored preference is read after mount (localStorage is not
// available while rendering on the server); until then the control shows the
// default. The PAINTED theme never waits on this component — THEME_INIT_SCRIPT
// has already resolved it in <head>.
import { useEffect, useState } from "react";
import {
	applyResolvedTheme,
	DARK_SCHEME_QUERY,
	DEFAULT_THEME_PREFERENCE,
	parseThemePreference,
	readStoredPreference,
	resolveTheme,
	systemPrefersDark,
	type ThemePreference,
	writeStoredPreference,
} from "../lib/theme";

const LABELS: Record<ThemePreference, string> = {
	system: "System",
	light: "Light",
	dark: "Dark",
};

export function ThemeSelect() {
	const [preference, setPreference] = useState<ThemePreference>(
		DEFAULT_THEME_PREFERENCE,
	);

	// Mount-time sync with what the inline script already read.
	useEffect(() => {
		setPreference(readStoredPreference());
	}, []);

	// While the preference is "system", a live OS/browser scheme change has to
	// repaint the app — the inline script only runs once per page load.
	useEffect(() => {
		if (preference !== "system") return;
		const query = window.matchMedia(DARK_SCHEME_QUERY);
		const onChange = () => {
			applyResolvedTheme(
				document.documentElement,
				resolveTheme("system", query.matches),
			);
		};
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, [preference]);

	function onSelect(value: string) {
		const next = parseThemePreference(value);
		setPreference(next);
		writeStoredPreference(next);
		applyResolvedTheme(
			document.documentElement,
			resolveTheme(next, systemPrefersDark()),
		);
	}

	return (
		<label className="flex items-center gap-2 text-sm">
			<span className="text-muted-foreground">Theme</span>
			<select
				value={preference}
				onChange={(event) => onSelect(event.target.value)}
				className="rounded-md border border-border bg-background px-2 py-1.5 text-sm hover:bg-accent"
			>
				{(Object.keys(LABELS) as ThemePreference[]).map((value) => (
					<option key={value} value={value}>
						{LABELS[value]}
					</option>
				))}
			</select>
		</label>
	);
}
