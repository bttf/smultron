// Log timestamp formatters (SPEC §9), shared by the feed log, the expanded
// panel and the snapshot views (m25). Moved here from bookmark-editor.tsx so
// the snapshot components can use them without an import cycle.

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

// Log timestamp: "Aug 1 09:14" (24h, no year) inside the current year,
// "Jul 3 2025" outside it. Manual formatting keeps the shape byte-stable
// across locales; this only ever renders client-side (SWR data), so there
// are no hydration concerns.
export function formatTimestamp(date: Date, now: Date = new Date()): string {
	const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
	if (date.getFullYear() !== now.getFullYear()) {
		return `${base} ${date.getFullYear()}`;
	}
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${base} ${hh}:${mm}`;
}

// Date only, no time: "Aug 1" in-year, "Aug 1 2025" outside it. Used on the
// compact mobile row, which drops the time from `formatTimestamp` to save
// horizontal space.
export function formatDate(date: Date, now: Date = new Date()): string {
	const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
	return date.getFullYear() !== now.getFullYear()
		? `${base} ${date.getFullYear()}`
		: base;
}
