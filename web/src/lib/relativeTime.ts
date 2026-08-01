// Tiny relative-time formatter for card timestamps (SPEC §9) — built on
// Intl.RelativeTimeFormat, no date library. Kept deliberately small: coarse
// units only, "just now" for anything under 45s.
const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
	{ unit: "year", ms: 365.25 * 24 * 60 * 60 * 1000 },
	{ unit: "month", ms: (365.25 / 12) * 24 * 60 * 60 * 1000 },
	{ unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
	{ unit: "day", ms: 24 * 60 * 60 * 1000 },
	{ unit: "hour", ms: 60 * 60 * 1000 },
	{ unit: "minute", ms: 60 * 1000 },
];

const JUST_NOW_THRESHOLD_MS = 45_000;

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** e.g. "5 minutes ago", "yesterday", "in 2 hours". `now` is injectable for tests. */
export function relativeTime(date: Date, now: Date = new Date()): string {
	const diffMs = date.getTime() - now.getTime();
	const absMs = Math.abs(diffMs);

	if (absMs < JUST_NOW_THRESHOLD_MS) {
		return "just now";
	}

	for (const { unit, ms } of UNITS) {
		if (absMs >= ms || unit === "minute") {
			return rtf.format(Math.round(diffMs / ms), unit);
		}
	}

	// Unreachable: the loop's last entry (minute) always matches.
	return "just now";
}
