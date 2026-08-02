/**
 * Compact relative timestamp for the popup footer ("saved just now",
 * "saved 5m", "saved 3h", "saved 2d", then an absolute date beyond ~7 days).
 * Pure — `now` is injectable for tests. Fixed en-US month names so output
 * doesn't depend on the host locale.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
	const then = new Date(iso);
	if (Number.isNaN(then.getTime())) return "";
	// Clock skew can make server timestamps land slightly in the future;
	// anything under a minute (including negatives) reads as "just now".
	const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days <= 7) return `${days}d`;
	const options: Intl.DateTimeFormatOptions = {
		month: "short",
		day: "numeric",
	};
	if (then.getFullYear() !== now.getFullYear()) options.year = "numeric";
	return then.toLocaleDateString("en-US", options);
}
