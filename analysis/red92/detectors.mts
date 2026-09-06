// RED-92 scratch: the six candidate detectors from the draft taxonomy, each
// reading its thresholds from config.json. Output is a flat list of flags
// for eyeballing against remembered behaviour. Throwaway code.
import {
	type Category,
	type Config,
	type Ev,
	inScope,
	type Session,
	type Stay,
} from "./model.mts";

export type Flag = {
	detector:
		| "quickCheckLoop"
		| "tabSwitchFlicker"
		| "postFrictionDrift"
		| "chainSpiral"
		| "returnVelocityCollapse"
		| "sunkSession";
	at: number;
	sessionIndex: number;
	summary: string;
	evidence?: string;
};

const inCats = (cats: readonly string[], c: Category) => cats.includes(c);

/**
 * Quick-check loop: the same drift host is entered ≥ minOpens times within
 * windowMs, and every one of those stays is short (< maxStayMs). "3rd Twitter
 * open in 20 min." One flag per host per window burst (fires on the Nth open).
 */
export function quickCheckLoop(sessions: Session[], cfg: Config): Flag[] {
	const c = cfg.detectors.quickCheckLoop;
	const flags: Flag[] = [];
	for (const s of sessions) {
		// An "open" is a stay on the host after ≥ minAbsenceMs away from it
		// (a return, not a bounce back after a quick detour). Short opens only.
		const lastSeen = new Map<string, number>();
		const byHost = new Map<string, Stay[]>();
		for (const st of s.stays) {
			const away = st.start - (lastSeen.get(st.host) ?? -Infinity);
			lastSeen.set(st.host, st.end);
			if (!inCats(c.categories, st.category)) continue;
			if (away < c.minAbsenceMs) continue;
			if (st.ms >= c.maxStayMs) continue;
			let arr = byHost.get(st.host);
			if (!arr) {
				arr = [];
				byHost.set(st.host, arr);
			}
			arr.push(st);
		}
		for (const [host, stays] of byHost) {
			let lastFlagged = -1;
			for (let i = 0; i < stays.length; i++) {
				const windowStart = stays[i]!.start - c.windowMs;
				let j = i;
				while (j > 0 && stays[j - 1]!.start >= windowStart) j--;
				const n = i - j + 1;
				if (n >= c.minOpens && j > lastFlagged) {
					lastFlagged = i;
					flags.push({
						detector: "quickCheckLoop",
						at: stays[i]!.start,
						sessionIndex: s.index,
						summary: `${ordinal(n)} ${host} open in ${Math.round(c.windowMs / 60000)} min, all under ${Math.round(c.maxStayMs / 1000)}s`,
						evidence: stays
							.slice(j, i + 1)
							.map((st) => `${fmtHM(st.start, cfg)} ${fmtS(st.ms)}`)
							.join(", "),
					});
				}
			}
		}
	}
	return flags;
}

/**
 * Tab-switch flicker: ≥ minSwitches tab activations across ≥ minDistinctTabs
 * tabs within windowMs, each resulting dwell shorter than maxStayMs.
 */
export function tabSwitchFlicker(sessions: Session[], cfg: Config): Flag[] {
	const c = cfg.detectors.tabSwitchFlicker;
	const flags: Flag[] = [];
	for (const s of sessions) {
		// consecutive dwells with a tab change = a switch; use dwell starts
		const switches: {
			at: number;
			tabId: number;
			len: number;
			host: string;
			category: Category;
		}[] = [];
		for (let i = 1; i < s.dwells.length; i++) {
			const d = s.dwells[i]!;
			const prev = s.dwells[i - 1]!;
			if (d.tabId !== prev.tabId && d.start - prev.end < 2000) {
				switches.push({
					at: d.start,
					tabId: d.tabId,
					len: d.end - d.start,
					host: d.host,
					category: d.category,
				});
			}
		}
		let lastFlaggedEnd = -1;
		for (let i = 0; i < switches.length; i++) {
			const windowStart = switches[i]!.at - c.windowMs;
			let j = i;
			while (j > 0 && switches[j - 1]!.at >= windowStart) j--;
			const run = switches.slice(j, i + 1);
			if (run.length < c.minSwitches) continue;
			if (!run.every((r) => r.len < c.maxStayMs)) continue;
			if (new Set(run.map((r) => r.tabId)).size < c.minDistinctTabs) continue;
			if (
				c.requireDriftTab &&
				!run.some((r) => inCats(c.driftCategories, r.category))
			)
				continue;
			if (j <= lastFlaggedEnd) continue; // don't re-flag the same burst
			lastFlaggedEnd = i;
			const hosts = [...new Set(run.map((r) => r.host))]
				.slice(0, 4)
				.join(" ↔ ");
			flags.push({
				detector: "tabSwitchFlicker",
				at: run[0]!.at,
				sessionIndex: s.index,
				summary: `${run.length} tab switches in ${Math.round(c.windowMs / 1000)}s across ${new Set(run.map((r) => r.tabId)).size} tabs (${hosts})`,
			});
		}
	}
	return flags;
}

/**
 * Post-friction drift: a stay on a focus host of ≥ minFocusStayMs is followed
 * within maxLagMs by a drift/shopping stay that the user initiated themselves
 * (typed / auto_bookmark / generated / keyword / start_page — i.e. NOT a link
 * from the focus page). The reflexive "hit a snag, open Twitter".
 */
export function postFrictionDrift(sessions: Session[], cfg: Config): Flag[] {
	const c = cfg.detectors.postFrictionDrift;
	const flags: Flag[] = [];
	const userInitiated = new Set([
		"typed",
		"auto_bookmark",
		"generated",
		"keyword",
		"start_page",
	]);
	for (const s of sessions) {
		for (let i = 1; i < s.stays.length; i++) {
			const prev = s.stays[i - 1]!;
			const cur = s.stays[i]!;
			if (prev.category !== "focus" || prev.ms < c.minFocusStayMs) continue;
			if (!inCats(c.driftCategories, cur.category)) continue;
			if (cur.start - prev.end > c.maxLagMs) continue;
			const entry = (cur.entryTransition ?? "").split("|")[0] ?? "";
			// No entry nav at all = switched to an already-open drift tab: also user-initiated.
			const initiated =
				cur.entryTransition === null || userInitiated.has(entry);
			if (c.userInitiatedOnly && !initiated) continue;
			flags.push({
				detector: "postFrictionDrift",
				at: cur.start,
				sessionIndex: s.index,
				summary: `${fmtS(prev.ms)} on ${prev.host} → ${cur.host} (${cur.entryTransition ?? "tab switch"}), stayed ${fmtS(cur.ms)}`,
			});
		}
	}
	return flags;
}

/**
 * Chain spiral: one stay on a drift host that keeps going — ≥ minLinkNavs
 * link-navigations inside the same host and ≥ minDurationMs long. The rabbit
 * hole (YouTube → YouTube → YouTube).
 */
export function chainSpiral(sessions: Session[], cfg: Config): Flag[] {
	const c = cfg.detectors.chainSpiral;
	const flags: Flag[] = [];
	for (const s of sessions) {
		for (const st of s.stays) {
			if (!inCats(c.categories, st.category)) continue;
			if (st.linkNavCount < c.minLinkNavs) continue;
			if (st.ms < c.minDurationMs) continue;
			flags.push({
				detector: "chainSpiral",
				at: st.start,
				sessionIndex: s.index,
				summary: `${fmtS(st.ms)} on ${st.host}, ${st.linkNavCount} link navs (${st.navCount} total)`,
			});
		}
	}
	return flags;
}

/**
 * Return velocity collapse: the gaps between successive drift excursions in a
 * session shrink — the median of the last `window` gaps falls below
 * collapsedGapMs after the session's earlier gaps averaged ≥ baselineFactor×
 * that. Fires once per session, at the moment of collapse.
 */
export function returnVelocityCollapse(
	sessions: Session[],
	cfg: Config,
): Flag[] {
	const c = cfg.detectors.returnVelocityCollapse;
	const flags: Flag[] = [];
	for (const s of sessions) {
		// An excursion = a maximal run of consecutive drift stays (x.com →
		// youtube.com back-to-back is ONE excursion). Gaps are the non-drift
		// time between excursions.
		const ex: { start: number; end: number; hosts: string[] }[] = [];
		for (const st of s.stays) {
			if (!inCats(c.driftCategories, st.category)) continue;
			const last = ex[ex.length - 1];
			const prevIdx = s.stays.indexOf(st) - 1;
			const contiguous =
				last &&
				prevIdx >= 0 &&
				inCats(c.driftCategories, s.stays[prevIdx]!.category);
			if (contiguous) {
				last!.end = st.end;
				last!.hosts.push(st.host);
			} else ex.push({ start: st.start, end: st.end, hosts: [st.host] });
		}
		if (ex.length < c.window + 2) continue;
		const gaps: number[] = [];
		for (let i = 1; i < ex.length; i++)
			gaps.push(ex[i]!.start - ex[i - 1]!.end);
		for (let i = c.window; i < gaps.length; i++) {
			const recent = gaps.slice(i - c.window + 1, i + 1);
			const earlier = gaps.slice(0, i - c.window + 1);
			if (earlier.length === 0) continue;
			const recentMed = median(recent);
			const earlierMed = median(earlier);
			if (
				recentMed < c.collapsedGapMs &&
				earlierMed >= c.minBaselineGapMs &&
				earlierMed >= c.baselineFactor * Math.max(recentMed, 1)
			) {
				const hosts = [
					...new Set(ex.slice(i - c.window + 1, i + 2).flatMap((e) => e.hosts)),
				];
				flags.push({
					detector: "returnVelocityCollapse",
					at: ex[i + 1]!.start,
					sessionIndex: s.index,
					summary: `drift returns every ~${fmtS(recentMed)} (was ~${fmtS(earlierMed)}); hosts ${hosts.join(", ")}`,
				});
				break;
			}
		}
	}
	return flags;
}

/**
 * Sunk session: drift dwell is ≥ minDriftShare of the session's engaged time
 * AND ≥ minDriftMs absolute. Session-level; fires at session end.
 */
export function sunkSession(sessions: Session[], cfg: Config): Flag[] {
	const c = cfg.detectors.sunkSession;
	const flags: Flag[] = [];
	for (const s of sessions) {
		const driftMs = c.driftCategories.reduce(
			(a, k) => a + (s.msByCategory[k as Category] ?? 0),
			0,
		);
		if (s.engagedMs === 0) continue;
		const share = driftMs / s.engagedMs;
		if (share >= c.minDriftShare && driftMs >= c.minDriftMs) {
			flags.push({
				detector: "sunkSession",
				at: s.end,
				sessionIndex: s.index,
				summary: `${Math.round(share * 100)}% drift (${fmtS(driftMs)} of ${fmtS(s.engagedMs)} engaged)`,
			});
		}
	}
	return flags;
}

export function runAll(
	sessions: Session[],
	cfg: Config,
	opts: { scoped?: boolean } = {},
): Flag[] {
	const all = runAllUnscoped(sessions, cfg);
	return opts.scoped === false ? all : all.filter((f) => inScope(f.at, cfg));
}

export function runAllUnscoped(sessions: Session[], cfg: Config): Flag[] {
	return [
		...quickCheckLoop(sessions, cfg),
		...tabSwitchFlicker(sessions, cfg),
		...postFrictionDrift(sessions, cfg),
		...chainSpiral(sessions, cfg),
		...returnVelocityCollapse(sessions, cfg),
		...sunkSession(sessions, cfg),
	].sort((a, b) => a.at - b.at);
}

// helpers
function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function ordinal(n: number): string {
	const s = ["th", "st", "nd", "rd"];
	const v = n % 100;
	return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
function fmtS(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}
function fmtHM(ms: number, cfg: Config): string {
	return new Date(ms).toLocaleTimeString("en-US", {
		timeZone: cfg.timezone,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

export type { Ev };
