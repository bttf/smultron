// Pure presentation helpers for the browse-event log view (SPEC §9 "Browse-
// events log view (m19)", kinds per §13). Kept out of the component so the
// contract-bearing bits — the 24h clock, the day-divider grouping, the detail
// column's per-kind rules, and the kind→palette mapping — are unit-testable
// without a DOM.
//
// Everything here is local-time by design: this is a personal diagnostic tool
// read in the same timezone the events were captured in, and the rows only
// ever render client-side (SWR data), so there is no hydration mismatch to
// worry about.

/** The §13 kind set, in the order the toolbar's filter chips render. */
export const BROWSE_EVENT_KINDS = [
	"nav",
	"tab_activated",
	"window_focus",
	"window_blur",
	"idle",
	"capture_start",
	"capture_stop",
] as const;

export type BrowseEventKind = (typeof BROWSE_EVENT_KINDS)[number];

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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Row timestamp: `HH:MM:SS`, 24h, local. */
export function formatEventTime(date: Date): string {
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

/**
 * Local calendar day, `YYYY-MM-DD`. Two events share a divider iff their keys
 * match — comparing keys (not Date objects) is what makes "the day changed"
 * well-defined across DST shifts.
 */
export function dayKey(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * Divider label: "Tue Aug 11" inside the current year, "Tue Aug 11 2025"
 * outside it. Weekday included on purpose — the collection week's sanity check
 * is mostly "what did Tuesday look like". `now` is injectable for tests.
 */
export function formatDayDivider(date: Date, now: Date = new Date()): string {
	const base = `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`;
	return date.getFullYear() !== now.getFullYear()
		? `${base} ${date.getFullYear()}`
		: base;
}

/**
 * Walk the (occurred_at desc) rows and decide where a date divider goes: the
 * FIRST row always carries one, and every later row whose local day differs
 * from the row above it. Pure so the divider rule is testable without a DOM;
 * the component just renders whatever `divider` is non-null.
 */
export function withDayDividers<T extends { occurredAt: string }>(
	events: T[],
	now: Date = new Date(),
): Array<{ event: T; divider: string | null }> {
	let lastDay: string | null = null;
	return events.map((event) => {
		const date = new Date(event.occurredAt);
		const key = dayKey(date);
		const divider = key === lastDay ? null : formatDayDivider(date, now);
		lastDay = key;
		return { event, divider };
	});
}

/**
 * The log's detail column (SPEC §9): `transition` for nav, `idle_state` for
 * idle, nothing for the other kinds. A nav's `documentLifecycle` (recorded
 * verbatim when present — prerendered commits, §13) is appended so a prerender
 * is visible in the log rather than indistinguishable from a real commit.
 * Empty string = render nothing.
 */
export function formatEventDetail(event: {
	kind: string;
	transition?: string | null;
	idleState?: string | null;
	documentLifecycle?: string | null;
}): string {
	if (event.kind === "nav") {
		return [event.transition, event.documentLifecycle]
			.filter((part): part is string => Boolean(part))
			.join(" · ");
	}
	if (event.kind === "idle") {
		return event.idleState ?? "";
	}
	return "";
}

export type KindBadgeStyle = {
	background: string;
	color: string;
	borderColor: string;
};

/**
 * Kind → badge colors, drawn ONLY from the `--log-*` palette in globals.css
 * (both schemes are covered by the variables — never hardcode a color here).
 * Applied as inline styles rather than Tailwind arbitrary values so the
 * mapping stays a plain, testable data structure.
 *
 * The grouping is the signal ranking: `nav` is the event you scan for (accent
 * fill); tab/window edges are neutral chips, `window_blur` dimmer than
 * `window_focus`; `idle` is an outlined ghost; the capture-session boundaries
 * (`capture_start`/`capture_stop`) are outlined so a boot boundary reads as a
 * rule across the log rather than as another event.
 */
const KIND_STYLES: Record<BrowseEventKind, KindBadgeStyle> = {
	nav: {
		background: "var(--log-facet-active)",
		color: "var(--log-accent)",
		borderColor: "transparent",
	},
	tab_activated: {
		background: "var(--log-soft)",
		color: "var(--log-fg)",
		borderColor: "var(--log-card-border)",
	},
	window_focus: {
		background: "var(--log-chip-bg)",
		color: "var(--log-fg)",
		borderColor: "transparent",
	},
	window_blur: {
		background: "var(--log-chip-bg)",
		color: "var(--log-faint)",
		borderColor: "transparent",
	},
	idle: {
		background: "transparent",
		color: "var(--log-faint)",
		borderColor: "var(--log-dash)",
	},
	capture_start: {
		background: "transparent",
		color: "var(--log-accent)",
		borderColor: "var(--log-accent)",
	},
	capture_stop: {
		background: "transparent",
		color: "var(--log-faint)",
		borderColor: "var(--log-strong-border)",
	},
};

const UNKNOWN_KIND_STYLE: KindBadgeStyle = {
	background: "var(--log-chip-bg)",
	color: "var(--log-chip-fg)",
	borderColor: "transparent",
};

/**
 * Never throws on an unrecognized kind: the server owns the enum, and a kind
 * added there before this view learns about it must still render as a row.
 */
export function kindBadgeStyle(kind: string): KindBadgeStyle {
	return KIND_STYLES[kind as BrowseEventKind] ?? UNKNOWN_KIND_STYLE;
}
