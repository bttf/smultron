// RED-92 scratch: dwell reconstruction + sessionization over the exported
// browse_events snapshot. Throwaway analysis code — the durable outputs are
// config.json and FINDINGS.md. Deliberately no abstractions beyond what the
// detectors need.
//
// Dwell rule (SPEC §13): dwell = intervals where a tab is the active tab of
// the focused window AND the user is non-idle, reconstructed from the raw
// edges. Intervals never cross a bootId; everything after the last event of a
// boot is unknown time.
import { readFileSync } from "node:fs";

export type Ev = {
	id: number;
	boot_id: string;
	kind:
		| "nav"
		| "tab_activated"
		| "window_focus"
		| "window_blur"
		| "idle"
		| "capture_start"
		| "capture_stop";
	occurred_at_ms: number;
	url: string | null;
	url_normalized: string | null;
	title: string | null;
	tab_id: number | null;
	window_id: number | null;
	idle_state: "active" | "idle" | "locked" | null;
	transition: string | null;
	document_lifecycle: string | null;
};

export type Config = typeof import("./config.json");
export type Category = "focus" | "drift" | "shopping" | "newtab" | "neutral";

export type Dwell = {
	start: number;
	end: number;
	bootId: string;
	tabId: number;
	url: string | null;
	host: string;
	category: Category;
	/** true when the interval was cut by the idle grace or the silent cap */
	truncated: "idle-grace" | "silent-cap" | null;
	/**
	 * false = the user gave input within the last 60s (Chrome's idle detection
	 * interval); true = the tab was in front but no input since the `idle`
	 * edge — a video playing, or reading without scrolling. Passive time is
	 * bounded by dwell.idleGraceMs per idle stretch; active time is not
	 * affected by the grace at all.
	 */
	passive: boolean;
};

/** Consecutive dwells on the same host, merged (tab switches within a host don't break a stay). */
export type Stay = {
	start: number;
	end: number;
	host: string;
	category: Category;
	dwells: Dwell[];
	/** how the stay was entered: first non-prerender nav transition at/just before start, if any */
	entryTransition: string | null;
	/** number of non-prerender navs on this host during the stay */
	navCount: number;
	linkNavCount: number;
	sessionIndex: number;
	/** engaged time = sum of dwell durations (NOT end-start: a stay may span blur/idle gaps up to stayBreakMs) */
	ms: number;
	activeMs: number;
	passiveMs: number;
};

export type Session = {
	index: number;
	start: number;
	end: number;
	dwells: Dwell[];
	stays: Stay[];
	bootIds: Set<string>;
	msByCategory: Record<Category, number>;
	activeByCategory: Record<Category, number>;
	engagedMs: number;
	activeMs: number;
};

export function loadConfig(): Config {
	const cfg = JSON.parse(
		readFileSync(new URL("./config.json", import.meta.url), "utf8"),
	) as Config;
	// Host classification is personal, so the committed config ships it empty
	// and the real lists live in a gitignored local file (this repo is public).
	// No local file = every host is `neutral` and no detector can fire, which is
	// the same "when unsure, do nothing" default the product uses (SPEC §13).
	try {
		const local = JSON.parse(
			readFileSync(
				new URL("./config.hosts.local.json", import.meta.url),
				"utf8",
			),
		) as { hosts?: Config["hosts"] };
		if (local.hosts) {
			cfg.hosts = { ...cfg.hosts, ...local.hosts };
		}
	} catch {
		console.warn(
			"[red92] no config.hosts.local.json — every host is neutral, detectors will not fire",
		);
	}
	return cfg;
}

export function loadEvents(): Ev[] {
	const rows: Ev[] = JSON.parse(
		readFileSync(new URL("./data/events.json", import.meta.url), "utf8"),
	);
	rows.sort((a, b) => a.occurred_at_ms - b.occurred_at_ms || a.id - b.id);
	return rows;
}

export function hostOf(url: string | null): string {
	if (!url) return "(unknown)";
	try {
		const u = new URL(url);
		if (
			u.protocol === "chrome:" ||
			u.protocol === "chrome-extension:" ||
			u.protocol === "about:"
		) {
			return u.host || u.pathname.replace(/^\/+/, "") || u.protocol;
		}
		return u.host.replace(/^www\./, "");
	} catch {
		return "(unparseable)";
	}
}

export function makeCategorizer(cfg: Config): (host: string) => Category {
	const table = new Map<string, Category>();
	for (const cat of ["focus", "drift", "shopping", "newtab"] as const) {
		for (const h of cfg.hosts[cat]) table.set(h, cat);
	}
	return (host) => {
		// exact, then parent-domain match (e.g. gist.github.com → github.com)
		if (table.has(host)) return table.get(host)!;
		const parts = host.split(".");
		for (let i = 1; i < parts.length - 1; i++) {
			const parent = parts.slice(i).join(".");
			if (table.has(parent)) return table.get(parent)!;
		}
		if (host.startsWith("localhost") || host.startsWith("127.0.0.1"))
			return "focus";
		return "neutral";
	};
}

// ---------------------------------------------------------------------------
// Dwell reconstruction
// ---------------------------------------------------------------------------

export type DwellDiagnostics = {
	boots: number;
	idleGraceTruncations: number;
	silentCapTruncations: number;
	prerenderNavsSkipped: number;
	activationsWithoutUrl: number;
	bootsWithoutBaseline: number;
};

export function reconstructDwell(
	events: Ev[],
	cfg: Config,
	categorize: (host: string) => Category,
): { dwells: Dwell[]; diag: DwellDiagnostics } {
	const grace = cfg.dwell.idleGraceMs;
	const silentCap = cfg.dwell.maxSilentDwellMs;
	const dwells: Dwell[] = [];
	const diag: DwellDiagnostics = {
		boots: 0,
		idleGraceTruncations: 0,
		silentCapTruncations: 0,
		prerenderNavsSkipped: 0,
		activationsWithoutUrl: 0,
		bootsWithoutBaseline: 0,
	};

	// group by boot, preserving time order
	const byBoot = new Map<string, Ev[]>();
	for (const e of events) {
		let arr = byBoot.get(e.boot_id);
		if (!arr) {
			arr = [];
			byBoot.set(e.boot_id, arr);
		}
		arr.push(e);
	}

	for (const [bootId, evs] of byBoot) {
		diag.boots++;
		let focusedWindow: number | null | undefined; // undefined = unknown yet
		const activeTab = new Map<number, number>();
		const tabUrl = new Map<number, string | null>();
		let idle: "active" | "idle" | "locked" = "active";
		let idleSince: number | null = null;
		let open: {
			start: number;
			tabId: number;
			url: string | null;
			lastEvent: number;
		} | null = null;
		let sawBaseline = false;

		const close = (at: number, truncated: Dwell["truncated"]) => {
			if (!open) return;
			const end = Math.max(open.start, at);
			if (end > open.start) {
				const host = hostOf(open.url);
				const base = {
					bootId,
					tabId: open.tabId,
					url: open.url,
					host,
					category: categorize(host),
				};
				// Split at the idle edge: before it the user was giving input,
				// after it the tab was merely in front.
				const split =
					idleSince === null
						? end
						: Math.min(Math.max(idleSince, open.start), end);
				if (split > open.start) {
					dwells.push({
						...base,
						start: open.start,
						end: split,
						truncated: split === end ? truncated : null,
						passive: false,
					});
				}
				if (end > split) {
					dwells.push({ ...base, start: split, end, truncated, passive: true });
				}
			}
			open = null;
		};

		const target = (): { tabId: number; url: string | null } | null => {
			if (idle === "locked") return null;
			if (focusedWindow === null || focusedWindow === undefined) return null;
			const tab = activeTab.get(focusedWindow);
			if (tab === undefined) return null;
			return { tabId: tab, url: tabUrl.get(tab) ?? null };
		};

		// Apply pending truncations (idle grace / silent cap) that expired
		// before `now`, then re-open on the current target if it changed.
		const reconcile = (now: number) => {
			if (open) {
				if (idleSince !== null && now > idleSince + grace) {
					close(idleSince + grace, "idle-grace");
					diag.idleGraceTruncations++;
				} else if (now - open.lastEvent > silentCap) {
					close(open.lastEvent + silentCap, "silent-cap");
					diag.silentCapTruncations++;
				}
			}
			const t = target();
			// While idle (within grace) the target is still the dwell target —
			// the grace is applied via idleSince above, not by nulling target.
			if (open && (!t || t.tabId !== open.tabId || t.url !== open.url))
				close(now, null);
			if (!open && t && !(idleSince !== null && now > idleSince + grace)) {
				open = { start: now, tabId: t.tabId, url: t.url, lastEvent: now };
			}
			if (open) open.lastEvent = now;
		};

		for (const e of evs) {
			const now = e.occurred_at_ms;
			switch (e.kind) {
				case "capture_start":
					break;
				case "capture_stop":
					reconcile(now);
					close(now, null);
					focusedWindow = null;
					break;
				case "tab_activated": {
					if (e.tab_id == null || e.window_id == null) break;
					if (!sawBaseline) sawBaseline = true;
					activeTab.set(e.window_id, e.tab_id);
					if (e.url) tabUrl.set(e.tab_id, e.url);
					else diag.activationsWithoutUrl++;
					// A user clicking a tab implies that window has focus; if we
					// don't know the focus state yet (boot baseline), adopt it.
					if (focusedWindow === undefined) focusedWindow = e.window_id;
					break;
				}
				case "window_focus": {
					if (e.window_id == null) break;
					focusedWindow = e.window_id;
					if (e.tab_id != null) {
						activeTab.set(e.window_id, e.tab_id);
						if (e.url) tabUrl.set(e.tab_id, e.url);
					}
					break;
				}
				case "window_blur":
					focusedWindow = null;
					break;
				case "idle": {
					const s = e.idle_state ?? "active";
					// Apply an expired grace BEFORE the state flips, so the close
					// lands at idleSince+grace; the reconcile after the switch
					// then re-opens (active) or leaves it closed (idle/locked).
					reconcile(now);
					idle = s;
					if (s === "active") {
						idleSince = null;
					} else if (s === "locked") {
						close(now, null);
						idleSince = null;
					} else if (idleSince === null) {
						idleSince = now;
					}
					break;
				}
				case "nav": {
					if (e.document_lifecycle === "prerender") {
						diag.prerenderNavsSkipped++;
						break;
					}
					if (e.tab_id == null) break;
					tabUrl.set(e.tab_id, e.url);
					// A brand-new tab is activated BEFORE its first nav commits
					// (tabs.get returns no url yet). Attribute that opening
					// sliver to the page that then loads instead of "(unknown)".
					if (
						open &&
						open.tabId === e.tab_id &&
						open.url === null &&
						now - open.start < 5000
					) {
						open.url = e.url;
					}
					break;
				}
			}
			reconcile(now);
		}
		// End of boot: everything after the last event is unknown time.
		const last = evs[evs.length - 1]!.occurred_at_ms;
		if (open) {
			if (idleSince !== null && last > idleSince + grace) {
				close(idleSince + grace, "idle-grace");
				diag.idleGraceTruncations++;
			} else close(last, null);
		}
		if (!sawBaseline) diag.bootsWithoutBaseline++;
	}

	dwells.sort((a, b) => a.start - b.start);
	return { dwells, diag };
}

// ---------------------------------------------------------------------------
// Sessions + stays
// ---------------------------------------------------------------------------

export function sessionize(
	dwells: Dwell[],
	navs: Ev[],
	cfg: Config,
): Session[] {
	const gap = cfg.session.gapMs;
	const sessions: Session[] = [];
	let cur: Session | null = null;
	for (const d of dwells) {
		if (!cur || d.start - cur.end > gap) {
			cur = {
				index: sessions.length,
				start: d.start,
				end: d.end,
				dwells: [],
				stays: [],
				bootIds: new Set(),
				msByCategory: {
					focus: 0,
					drift: 0,
					shopping: 0,
					newtab: 0,
					neutral: 0,
				},
				activeByCategory: {
					focus: 0,
					drift: 0,
					shopping: 0,
					newtab: 0,
					neutral: 0,
				},
				engagedMs: 0,
				activeMs: 0,
			};
			sessions.push(cur);
		}
		cur.dwells.push(d);
		cur.bootIds.add(d.bootId);
		cur.end = Math.max(cur.end, d.end);
		cur.msByCategory[d.category] += d.end - d.start;
		cur.engagedMs += d.end - d.start;
		if (!d.passive) {
			cur.activeByCategory[d.category] += d.end - d.start;
			cur.activeMs += d.end - d.start;
		}
	}

	// navs (non-prerender) indexed by tab for stay entry transitions / counts
	const navsSorted = navs
		.filter(
			(n) =>
				n.kind === "nav" &&
				n.document_lifecycle !== "prerender" &&
				n.tab_id != null,
		)
		.sort((a, b) => a.occurred_at_ms - b.occurred_at_ms);

	const bounceMs = cfg.session.bounceMs;
	for (const s of sessions) {
		// 1. raw stays: consecutive same-host dwells
		const raw: Stay[] = [];
		let stay: Stay | null = null;
		const breakMs = cfg.session.stayBreakMs;
		for (const d of s.dwells) {
			// same host continues a stay only if the user was not away (blurred,
			// idle, other window) for ≥ stayBreakMs in between — otherwise
			// coming back is a new visit.
			if (!stay || stay.host !== d.host || d.start - stay.end >= breakMs) {
				stay = {
					start: d.start,
					end: d.end,
					host: d.host,
					category: d.category,
					dwells: [d],
					entryTransition: null,
					navCount: 0,
					linkNavCount: 0,
					sessionIndex: s.index,
					ms: d.end - d.start,
					activeMs: d.passive ? 0 : d.end - d.start,
					passiveMs: d.passive ? d.end - d.start : 0,
				};
				raw.push(stay);
			} else {
				stay.dwells.push(d);
				stay.end = Math.max(stay.end, d.end);
				stay.ms += d.end - d.start;
				if (d.passive) stay.passiveMs += d.end - d.start;
				else stay.activeMs += d.end - d.start;
			}
		}
		// 2. bounce collapse: a stay shorter than bounceMs is a pass-through
		// (tab-cycling, a link that opened and was left at once), not a visit.
		// Drop it and merge the same-host neighbours it separated. Detectors
		// that WANT bounces (tab-switch flicker) read s.dwells, not stays.
		for (const st of raw) {
			if (st.ms < bounceMs) continue;
			const prev = s.stays[s.stays.length - 1];
			if (prev && prev.host === st.host && st.start - prev.end < breakMs) {
				prev.dwells.push(...st.dwells);
				prev.end = Math.max(prev.end, st.end);
				prev.ms += st.ms;
				prev.activeMs += st.activeMs;
				prev.passiveMs += st.passiveMs;
			} else {
				s.stays.push(st);
			}
		}
		// attach navs: a nav belongs to the stay whose tab set contains its tab and whose
		// [start-2s, end] window contains it (2s slack: nav commit precedes the dwell open).
		let ni = 0;
		while (
			ni < navsSorted.length &&
			navsSorted[ni]!.occurred_at_ms < s.start - 2000
		)
			ni++;
		for (const st of s.stays) {
			const tabs = new Set(st.dwells.map((d) => d.tabId));
			let j = ni;
			while (j < navsSorted.length && navsSorted[j]!.occurred_at_ms <= st.end) {
				const n = navsSorted[j]!;
				if (
					n.occurred_at_ms >= st.start - 2000 &&
					tabs.has(n.tab_id!) &&
					hostOf(n.url) === st.host
				) {
					st.navCount++;
					const t = (n.transition ?? "").split("|")[0];
					if (t === "link") st.linkNavCount++;
					if (
						st.entryTransition === null &&
						n.occurred_at_ms <= st.start + 2000
					)
						st.entryTransition = n.transition;
				}
				j++;
			}
		}
	}
	return sessions;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function fmtTime(ms: number, tz: string): string {
	return new Date(ms).toLocaleString("en-US", {
		timeZone: tz,
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}
export function fmtDay(ms: number, tz: string): string {
	return new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
}
export function fmtDur(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
	return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}

/** Is this instant inside the configured work-hours scope (local time)? */
export function inScope(ms: number, cfg: Config): boolean {
	const d = new Date(ms);
	const day = d.toLocaleDateString("en-US", {
		timeZone: cfg.timezone,
		weekday: "short",
	});
	const hour =
		Number(
			d.toLocaleString("en-US", {
				timeZone: cfg.timezone,
				hour: "2-digit",
				hour12: false,
			}),
		) % 24;
	const [from, to] = cfg.scope.hours;
	return cfg.scope.days.includes(day) && hour >= from && hour < to;
}
