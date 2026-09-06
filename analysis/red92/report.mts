// RED-92 scratch: run dwell reconstruction + sessionization + detectors over
// the snapshot and write out/report.md for eyeballing. Throwaway code.
//   cd web && node_modules/.bin/tsx ../analysis/red92/report.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { type Flag, runAll, runAllUnscoped } from "./detectors.mts";
import {
	type Category,
	fmtDay,
	fmtDur,
	fmtTime,
	inScope,
	loadConfig,
	loadEvents,
	makeCategorizer,
	reconstructDwell,
	type Session,
	sessionize,
} from "./model.mts";

const cfg = loadConfig();
const tz = cfg.timezone;
const events = loadEvents();
const categorize = makeCategorizer(cfg);
const { dwells, diag } = reconstructDwell(events, cfg, categorize);
const sessions = sessionize(dwells, events, cfg);
const flags = runAll(sessions, cfg); // work-hours scope applied
const flagsAll = runAllUnscoped(sessions, cfg);

const CATS: Category[] = ["focus", "drift", "shopping", "newtab", "neutral"];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (a: number, b: number) =>
	b ? `${Math.round((100 * a) / b)}%` : "–";
const lines: string[] = [];
const p = (s = "") => lines.push(s);

p(`# RED-92 detector report`);
p();
p(
	`Generated ${new Date().toISOString()} over ${events.length} events (${fmtDay(events[0]!.occurred_at_ms, tz)} → ${fmtDay(events[events.length - 1]!.occurred_at_ms, tz)}). Times in ${tz}.`,
);
p();

// --- dwell diagnostics -------------------------------------------------------
const totalEngaged = sum(dwells.map((d) => d.end - d.start));
const byCat = Object.fromEntries(
	CATS.map((c) => [
		c,
		sum(dwells.filter((d) => d.category === c).map((d) => d.end - d.start)),
	]),
) as Record<Category, number>;
p(`## Dwell reconstruction`);
p();
p(`| metric | value |`);
p(`| --- | --- |`);
p(
	`| boots | ${diag.boots} (${diag.bootsWithoutBaseline} without a baseline activation) |`,
);
p(`| dwell intervals | ${dwells.length} |`);
p(
	`| engaged time (dwell total) | ${fmtDur(totalEngaged)} over ${new Set(dwells.map((d) => fmtDay(d.start, tz))).size} days |`,
);
for (const c of CATS)
	p(`| … ${c} | ${fmtDur(byCat[c])} (${pct(byCat[c], totalEngaged)}) |`);
p(
	`| idle-grace truncations (grace ${fmtDur(cfg.dwell.idleGraceMs)}) | ${diag.idleGraceTruncations} |`,
);
p(
	`| silent-cap truncations (cap ${fmtDur(cfg.dwell.maxSilentDwellMs)}) | ${diag.silentCapTruncations} |`,
);
p(`| prerender navs skipped | ${diag.prerenderNavsSkipped} |`);
p(`| activations without url | ${diag.activationsWithoutUrl} |`);
p(`| sessions (gap ${fmtDur(cfg.session.gapMs)}) | ${sessions.length} |`);
p();

// dwell length distribution
const lens = dwells.map((d) => d.end - d.start).sort((a, b) => a - b);
const q = (f: number) =>
	lens[Math.min(lens.length - 1, Math.floor(f * lens.length))]!;
p(
	`Dwell length percentiles: p50 ${fmtDur(q(0.5))} · p75 ${fmtDur(q(0.75))} · p90 ${fmtDur(q(0.9))} · p99 ${fmtDur(q(0.99))} · max ${fmtDur(lens[lens.length - 1]!)}`,
);
p();

// --- active vs passive, and scope ------------------------------------------
p(`## Active vs passive, and the work-hours scope`);
p();
p(
	`Active = input within the last 60s (before the \`idle\` edge). Passive = tab in front, no input since the edge (video playing, reading without scrolling), capped at the ${fmtDur(cfg.dwell.idleGraceMs)} grace per idle stretch. Scope = ${cfg.scope.days.join("/")} ${cfg.scope.hours[0]}:00–${cfg.scope.hours[1]}:00 ${tz}; detectors only flag inside it.`,
);
p();
const scoped = dwells.filter((d) => inScope(d.start, cfg));
const tally = (ds: typeof dwells) => {
	const t = {
		engaged: 0,
		active: 0,
		byCat: {} as Record<Category, { e: number; a: number }>,
	};
	for (const c of CATS) t.byCat[c] = { e: 0, a: 0 };
	for (const d of ds) {
		const l = d.end - d.start;
		t.engaged += l;
		t.byCat[d.category].e += l;
		if (!d.passive) {
			t.active += l;
			t.byCat[d.category].a += l;
		}
	}
	return t;
};
const tAll = tally(dwells);
const tIn = tally(scoped);
p(`| | all hours | in scope |`);
p(`| --- | --- | --- |`);
p(
	`| engaged | ${fmtDur(tAll.engaged)} | ${fmtDur(tIn.engaged)} (${pct(tIn.engaged, tAll.engaged)} of all) |`,
);
p(
	`| active share | ${pct(tAll.active, tAll.engaged)} | ${pct(tIn.active, tIn.engaged)} |`,
);
for (const c of CATS) {
	p(
		`| ${c}: engaged / active share | ${fmtDur(tAll.byCat[c].e)} / ${pct(tAll.byCat[c].a, tAll.byCat[c].e)} | ${fmtDur(tIn.byCat[c].e)} (${pct(tIn.byCat[c].e, tIn.engaged)} of scope) / ${pct(tIn.byCat[c].a, tIn.byCat[c].e)} |`,
	);
}
p();
p(`Per host (top 20 by engaged), how much of the time was passive:`);
p();
p(
	`| host | category | engaged | active | passive | passive share | in-scope engaged |`,
);
p(`| --- | --- | --- | --- | --- | --- | --- |`);
const hostAP = new Map<
	string,
	{ cat: Category; e: number; a: number; inS: number }
>();
for (const d of dwells) {
	const h = hostAP.get(d.host) ?? { cat: d.category, e: 0, a: 0, inS: 0 };
	const l = d.end - d.start;
	h.e += l;
	if (!d.passive) h.a += l;
	if (inScope(d.start, cfg)) h.inS += l;
	hostAP.set(d.host, h);
}
for (const [host, h] of [...hostAP]
	.sort((a, b) => b[1].e - a[1].e)
	.slice(0, 20)) {
	p(
		`| ${host} | ${h.cat} | ${fmtDur(h.e)} | ${fmtDur(h.a)} | ${fmtDur(h.e - h.a)} | ${pct(h.e - h.a, h.e)} | ${fmtDur(h.inS)} |`,
	);
}
p();
const inCount = countBy(flags.map((f) => f.detector));
const allCount = countBy(flagsAll.map((f) => f.detector));
p(`Flags in scope vs all hours:`);
p();
p(`| detector | in scope | all hours |`);
p(`| --- | --- | --- |`);
for (const d of [
	"quickCheckLoop",
	"tabSwitchFlicker",
	"postFrictionDrift",
	"chainSpiral",
	"returnVelocityCollapse",
	"sunkSession",
]) {
	p(`| ${d} | ${inCount[d] ?? 0} | ${allCount[d] ?? 0} |`);
}
p();
// passive time with a longer grace (video playing)
p(
	`Passive drift time at longer idle graces (active time is identical at every grace by construction):`,
);
p();
for (const g of [300000, 900000, 1800000, 3600000]) {
	const c2 = structuredClone(cfg);
	c2.dwell.idleGraceMs = g;
	const r = reconstructDwell(events, c2, categorize);
	const dr = r.dwells.filter((d) => d.category === "drift");
	const pas = sum(dr.filter((d) => d.passive).map((d) => d.end - d.start));
	const act = sum(dr.filter((d) => !d.passive).map((d) => d.end - d.start));
	// The heaviest drift host, whichever it is — no site is named in committed code.
	const topDriftHost = [...r.dwells.filter((d) => d.category === "drift")]
		.reduce(
			(acc, d) => acc.set(d.host, (acc.get(d.host) ?? 0) + (d.end - d.start)),
			new Map<string, number>(),
		)
		.entries()
		.reduce((best, e) => (e[1] > best[1] ? e : best), ["", 0] as [
			string,
			number,
		])[0];
	const yt = r.dwells.filter((d) => d.host === topDriftHost);
	const ytp = sum(yt.filter((d) => d.passive).map((d) => d.end - d.start));
	p(
		`- grace ${fmtDur(g)}: drift active ${fmtDur(act)}, passive ${fmtDur(pas)} (${pct(pas, act + pas)}); top drift host (${topDriftHost}) passive ${fmtDur(ytp)} of ${fmtDur(sum(yt.map((d) => d.end - d.start)))}`,
	);
}
p();

// --- top hosts by dwell -----------------------------------------------------
const hostMs = new Map<string, { ms: number; cat: Category; stays: number }>();
for (const s of sessions)
	for (const st of s.stays) {
		const h = hostMs.get(st.host) ?? { ms: 0, cat: st.category, stays: 0 };
		h.ms += st.ms;
		h.stays++;
		hostMs.set(st.host, h);
	}
p(`## Hosts by engaged time (top 30)`);
p();
p(
	`Review the category column — it drives every detector. Uncategorized hosts are \`neutral\`.`,
);
p();
p(`| host | category | engaged | stays | median stay |`);
p(`| --- | --- | --- | --- | --- |`);
for (const [host, h] of [...hostMs]
	.sort((a, b) => b[1].ms - a[1].ms)
	.slice(0, 30)) {
	const stays = sessions
		.flatMap((s) => s.stays)
		.filter((st) => st.host === host)
		.map((st) => st.ms)
		.sort((a, b) => a - b);
	p(
		`| ${host} | ${h.cat} | ${fmtDur(h.ms)} | ${h.stays} | ${fmtDur(stays[Math.floor(stays.length / 2)]!)} |`,
	);
}
p();

// --- per-day summary --------------------------------------------------------
p(`## Days`);
p();
p(`| day | sessions | engaged | focus | drift | shopping | flags |`);
p(`| --- | --- | --- | --- | --- | --- | --- |`);
const days = [...new Set(sessions.map((s) => fmtDay(s.start, tz)))];
for (const day of days) {
	const ss = sessions.filter((s) => fmtDay(s.start, tz) === day);
	const eng = sum(ss.map((s) => s.engagedMs));
	const cat = (c: Category) => sum(ss.map((s) => s.msByCategory[c]));
	const fl = flags.filter((f) => fmtDay(f.at, tz) === day);
	const counts = countBy(fl.map((f) => f.detector));
	p(
		`| ${day} | ${ss.length} | ${fmtDur(eng)} | ${pct(cat("focus"), eng)} | ${pct(cat("drift"), eng)} | ${pct(cat("shopping"), eng)} | ${
			Object.entries(counts)
				.map(([k, v]) => `${short(k)}×${v}`)
				.join(" ") || "–"
		} |`,
	);
}
p();

// --- flags summary ----------------------------------------------------------
p(`## Flags by detector (in scope)`);
p();
const byDet = countBy(flags.map((f) => f.detector));
p(`| detector | flags | per day |`);
p(`| --- | --- | --- |`);
for (const d of [
	"quickCheckLoop",
	"tabSwitchFlicker",
	"postFrictionDrift",
	"chainSpiral",
	"returnVelocityCollapse",
	"sunkSession",
]) {
	p(
		`| ${d} | ${byDet[d] ?? 0} | ${((byDet[d] ?? 0) / days.length).toFixed(1)} |`,
	);
}
p();

// --- threshold sweeps -------------------------------------------------------
p(`## Threshold sweeps`);
p();
p(
	`How flag counts move as the key threshold of each detector changes (everything else at config values).`,
);
p();
const sweep = <K extends keyof typeof cfg.detectors>(
	det: K,
	key: string,
	values: (number | string)[],
) => {
	const row = values.map((v) => {
		const c2 = structuredClone(cfg);
		(c2.detectors[det] as Record<string, unknown>)[key] = v;
		const n = runAll(sessions, c2).filter((f) => f.detector === det).length;
		return `${typeof v === "number" && v >= 1000 ? fmtDur(v) : v}: **${n}**`;
	});
	p(`- \`${det}.${key}\` → ${row.join(" · ")}`);
};
const sweepBool = (det: keyof typeof cfg.detectors, key: string) => {
	const row = [false, true].map((v) => {
		const c2 = structuredClone(cfg);
		(c2.detectors[det] as Record<string, unknown>)[key] = v;
		return `${v}: **${runAll(sessions, c2).filter((f) => f.detector === det).length}**`;
	});
	p(`- \`${det}.${key}\` → ${row.join(" · ")}`);
};
const sweepSession = (key: "bounceMs" | "gapMs", values: number[]) => {
	const row = values.map((v) => {
		const c2 = structuredClone(cfg);
		c2.session[key] = v;
		const ss = sessionize(dwells, events, c2);
		const fl = runAll(ss, c2);
		const by = countBy(fl.map((f) => f.detector));
		return `${fmtDur(v)}: qcl ${by.quickCheckLoop ?? 0} / pfd ${by.postFrictionDrift ?? 0} / rvc ${by.returnVelocityCollapse ?? 0} / spr ${by.chainSpiral ?? 0} (${ss.length} sessions)`;
	});
	p(`- \`session.${key}\` → ${row.join(" · ")}`);
};
sweep("quickCheckLoop", "minOpens", [2, 3, 4, 5]);
sweep("quickCheckLoop", "maxStayMs", [30000, 60000, 90000, 180000]);
sweep("quickCheckLoop", "windowMs", [600000, 1200000, 1800000, 3600000]);
sweep("tabSwitchFlicker", "minSwitches", [4, 5, 6, 8, 10]);
sweep("tabSwitchFlicker", "maxStayMs", [3000, 5000, 8000, 15000]);
sweepBool("tabSwitchFlicker", "requireDriftTab");
sweep("postFrictionDrift", "maxLagMs", [10000, 30000, 60000, 120000]);
sweep("postFrictionDrift", "minFocusStayMs", [30000, 60000, 120000, 300000]);
sweep("chainSpiral", "minLinkNavs", [4, 6, 8, 12]);
sweep("chainSpiral", "minDurationMs", [300000, 600000, 900000, 1800000]);
sweep("returnVelocityCollapse", "collapsedGapMs", [120000, 300000, 600000]);
sweep("returnVelocityCollapse", "baselineFactor", [2, 3, 4, 6]);
sweep("returnVelocityCollapse", "window", [3, 4, 6, 8]);
sweep(
	"returnVelocityCollapse",
	"minBaselineGapMs",
	[60000, 120000, 300000, 600000],
);
sweep("quickCheckLoop", "minAbsenceMs", [30000, 60000, 120000, 300000]);
sweepSession("bounceMs", [0, 2000, 3000, 5000, 10000]);
sweep("sunkSession", "minDriftShare", [0.4, 0.5, 0.6, 0.75]);
sweep("sunkSession", "minDriftMs", [900000, 1800000, 2700000, 3600000]);
p();
// idle grace sensitivity on engaged time
p(`Idle grace vs engaged time (how much dwell the grace adds back):`);
p();
for (const g of [0, 120000, 300000, 600000, 1200000]) {
	const c2 = structuredClone(cfg);
	c2.dwell.idleGraceMs = g;
	const r = reconstructDwell(events, c2, categorize);
	const t = sum(r.dwells.map((d) => d.end - d.start));
	const dr = sum(
		r.dwells.filter((d) => d.category === "drift").map((d) => d.end - d.start),
	);
	p(
		`- grace ${fmtDur(g)}: engaged ${fmtDur(t)}, drift ${fmtDur(dr)} (${pct(dr, t)})`,
	);
}
p();

// --- sessions ---------------------------------------------------------------
p(`## Sessions`);
p();
p(
	`One line per session, then its flags. Host timeline collapses stays shorter than 30s.`,
);
p();
for (const s of sessions) {
	const fl = flags.filter((f) => f.sessionIndex === s.index);
	p(
		`### S${s.index} · ${fmtTime(s.start, tz)} → ${fmtTime(s.end, tz)} · engaged ${fmtDur(s.engagedMs)} · focus ${pct(s.msByCategory.focus, s.engagedMs)} · drift ${pct(s.msByCategory.drift, s.engagedMs)} · shopping ${pct(s.msByCategory.shopping, s.engagedMs)} · ${s.stays.length} stays · ${s.bootIds.size} boot(s)`,
	);
	p();
	p(`timeline: ${timeline(s)}`);
	p();
	if (fl.length) {
		for (const f of fl)
			p(
				`- **${f.detector}** ${fmtTime(f.at, tz)} — ${f.summary}${f.evidence ? ` _(${f.evidence})_` : ""}`,
			);
		p();
	}
}

mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL("./out/report.md", import.meta.url), lines.join("\n"));
writeFileSync(
	new URL("./out/flags.json", import.meta.url),
	JSON.stringify(flags, null, 1),
);

// console summary
console.log(
	`events ${events.length} · dwells ${dwells.length} · engaged ${fmtDur(totalEngaged)} · sessions ${sessions.length}`,
);
console.log(
	"category:",
	Object.fromEntries(
		CATS.map((c) => [c, `${fmtDur(byCat[c])} ${pct(byCat[c], totalEngaged)}`]),
	),
);
console.log("diag:", diag);
console.log(
	"flags in scope:",
	byDet,
	"all hours:",
	countBy(flagsAll.map((f) => f.detector)),
);
console.log("wrote analysis/red92/out/report.md");

// helpers
function countBy(xs: string[]): Record<string, number> {
	const o: Record<string, number> = {};
	for (const x of xs) o[x] = (o[x] ?? 0) + 1;
	return o;
}
function short(det: string): string {
	return (
		(
			{
				quickCheckLoop: "qcl",
				tabSwitchFlicker: "flk",
				postFrictionDrift: "pfd",
				chainSpiral: "spr",
				returnVelocityCollapse: "rvc",
				sunkSession: "snk",
			} as Record<string, string>
		)[det] ?? det
	);
}
function timeline(s: Session): string {
	const parts: string[] = [];
	for (const st of s.stays) {
		const ms = st.ms;
		if (ms < 30000) continue;
		const mark =
			st.category === "drift"
				? "🔴"
				: st.category === "focus"
					? "🟢"
					: st.category === "shopping"
						? "🟠"
						: "⚪";
		parts.push(`${mark}${st.host} ${fmtDur(ms)}`);
	}
	return parts.length > 40
		? `${parts.slice(0, 40).join(" › ")} › … (+${parts.length - 40})`
		: parts.join(" › ");
}
function _flagAt(f: Flag) {
	return fmtTime(f.at, tz);
}
