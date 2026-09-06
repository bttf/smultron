# RED-92 — Retroactive categorization: method and verdicts

Status: **calibration pass done; host-category review and session eyeballing still with Adnan** (the "do the flags match how it actually felt?" step can only be done by the person who lived the sessions). This document plus `config.json` are the durable outputs of RED-92; the scripts here are throwaway and may be deleted once RED-93 has ported the detectors.

> **Privacy boundary.** `bttf/smultron` is a public repository, so this file deliberately contains **no measurements taken from the actual browsing data** — no host hours, dates, timestamps, drift shares or flag counts. Those live in `FINDINGS_DATA.md` and `FINDINGS_SUMMARIZED.md`, which are local-only (excluded via `.git/info/exclude`), alongside `data/` and `out/`. What is committed here is the machinery and the conclusions about the machinery: how dwell is reconstructed, what each detector means, which knob controls it, and whether it earned its place in RED-93.

## 1. What the collection window gave us

One paired Chrome profile, 24 consecutive days of `smultron.browse_events`, capture semantics (SPEC §13) frozen throughout — m22's `0013_keep-fragments` migration only recomputed the derived `url_normalized`, never the captured payload, so the dataset is uniform end to end. Health check passed: every multi-hour gap is either overnight or bracketed by `idle`/`locked` edges under the same `bootId`, which is real absence rather than a dropped outbox.

## 2. Dwell reconstruction (how "time on tab" is derived)

Per `bootId`, a state machine replays the raw edges and emits **dwell intervals** — the stretches where one tab is the active tab of the focused window and the user is non-idle:

- `tab_activated` sets the window's active tab (and, on a boot's first activation, adopts that window as focused — the baseline). `window_focus` / `window_blur` set and clear the focused window. A non-prerender `nav` updates the tab's URL; if that tab is the current target, the interval closes and a new one opens on the new URL.
- `idle` → `locked` closes immediately. `idle` → `idle` starts an **idle grace**: the interval stays open for `dwell.idleGraceMs` (5 min), then is cut at exactly `idleSince + grace`. Returning to `active` inside the grace costs nothing. Rationale: Chrome's idle signal is input-based (60 s without keyboard or mouse), so reading or watching without touching the machine reads as idle almost immediately. Measured sensitivity is low — the category shares barely move between a zero grace and a 20 min one — so **the grace does not bias the detectors**. Numbers in `FINDINGS_DATA.md` §2.
- **Hard boundaries**: an interval never crosses a `bootId`; the last event of a boot closes everything, because a browser quit leaves no shutdown edge in MV3. A 2 h silent cap exists as a safety net and never fired.
- **New-tab attribution**: a `tab_activated` with no URL is almost always a brand-new tab activated before its first commit (`tabs.get` has no URL yet), not an enrichment failure — nearly all such tabs receive a `nav` moments later in the same boot. The opening sliver (< 5 s) is attributed to the page that then loads. Residual unattributable dwell is negligible.
- **Prerender**: navs carrying `documentLifecycle=prerender` (Google Search speculation rules) are skipped. Known blind spot: clicking *into* a prerendered result fires no second `onCommitted`, so that visit reads as continued search-engine dwell until the next edge. It affects the search engine's own numbers only, and that host is `neutral`.

### Stays and bounces

Consecutive dwells on the same host merge into a **stay**, but only while the user was not away (blurred, idle, in another window) for ≥ `session.stayBreakMs` (60 s) in between — coming back after a minute in the terminal is a new visit, not a continuation.

**A stay's duration is the sum of its dwells, never its wall-clock span.** The first pass used the span and materially inflated every long-lived work tab, because time spent in an editor or terminal between two visits to the same tab was counted as time on that tab. This is the single most important correction in the analysis: it shortened focus-host totals, collapsed the apparent length of long focus runs, and cut the rabbit-hole detector's hits by most of their count. Category *shares* were always dwell-based and did not change.

A stay shorter than `session.bounceMs` (3 s) is a **bounce** — a pass-through while cycling tabs, or a link opened and abandoned — and is dropped, merging the same-host neighbours it separated. This one rule removed most of the false quick-check hits, which were sub-second "opens". The tab-switch-flicker detector deliberately reads raw dwells instead of stays, since flicker *is* bounces.

### Sessions

A session breaks when engaged time is absent for > `session.gapMs` (30 min), regardless of `bootId` — a quick browser restart is not a new sitting.

## 3. Two policy decisions (2026-09-06)

**Work-hours scope.** Evenings and weekends are recreation, and drift there is not a problem to be solved. `config.json → scope` is Mon–Fri 08:00–18:00 local; **detectors only flag inside it**, while the model still runs over everything so the report can show both views. This roughly thirds the flag volume and materially improves the focus/drift split, because the heaviest drift hours sit outside the window entirely. RED-93's toast layer must stay silent outside the scope, though capture continues.

**Active vs passive.** Chrome's `idle` edge fires after 60 s without input, so every dwell is split at that edge into **active** (input within the last minute) and **passive** (tab in front, hands off — video playing, or reading without scrolling). Passive time per idle stretch is bounded by the grace; active time is identical at any grace by construction.

The measured result is the interesting part, and it contradicted the obvious assumption. Interaction-driven feeds (X, Instagram) are essentially never passive, as expected. **Video-shaped sites split in two**: a long-form streaming service behaved like genuine lean-back video (roughly half its time passive), while the big video site was overwhelmingly *active* — input at least once a minute for the large majority of its time. That site is being browsed, not watched, so a naive "exempt video from drift" rule would have been wrong.

**Limitation, and the follow-up it implies**: 60 s of no input is a coarse proxy for "media is playing". The `tabs` permission already held exposes `tab.audible`; capturing `tabs.onUpdated` audible transitions as a new `audible` event kind would make playback explicit and let detectors treat "audible + passive" as its own category rather than as drift. Small SPEC §13 addition, now permissible since RED-91 closed. Ticketed as a follow-up before RED-93.

## 4. Host categories

Categories drive every detector. The lists live in `config.json → hosts` and match by exact host or parent domain (`gist.github.com` → `github.com`); `localhost*` is focus; anything unlisted is `neutral` and invisible to the detectors.

Four categories are in use: `focus`, `drift`, `shopping`, `newtab`. `shopping` is kept separate from `drift` because deliberate errands (a car, groceries) are not the same behaviour as a feed, and it only feeds the post-friction detector. **This list is the main thing needing Adnan's review** — see §7.

## 5. Detectors — definitions and verdicts

All thresholds live in `config.json → detectors`; `out/report.md` (local) carries the threshold sweeps and the per-session evidence behind each verdict. Firing rates are in `FINDINGS_DATA.md` §4.

### quickCheckLoop — "3rd Twitter open in 20 min"
**Definition**: within a session, the same drift host is *opened* ≥ `minOpens` (3) times inside `windowMs` (20 min), every one of those stays shorter than `maxStayMs` (90 s). An *open* means a stay entered after ≥ `minAbsenceMs` (60 s) away from that host — a genuine return, not a bounce back from a ten-second detour. Fires once per burst, on the Nth open.
**Verdict**: **the cleanest of the six.** Every sampled burst reads exactly like the intended behaviour, and it survives the scope filter well. `minAbsenceMs` is the sharpest knob; without it the detector mostly reports tab-cycling. Ship it as yellow at 3 opens, red at 4.

### postFrictionDrift — "hit a snag, opened Twitch"
**Definition**: a focus stay of ≥ `minFocusStayMs` (2 min) followed within `maxLagMs` (30 s) by a drift or shopping stay the user initiated themselves — entry transition `typed`, `auto_bookmark` (bookmarks bar), `generated`, `keyword`, `start_page`, or no nav at all (a switch to an already-open drift tab). A `link` out of the focus page does not count.
**Verdict**: **real, and the one with the clearest story for a toast** ("you just left N minutes of GitHub for Twitch"). The lag threshold is irrelevant in practice — the switch is always immediate — so the focus-stay floor is the only knob that matters. Ship it as yellow at the 2 min floor, red at 5 min. Consider also requiring the drift stay to last ≥ 10 s, so a five-second peek doesn't toast.

### chainSpiral — the rabbit hole
**Definition**: one drift stay with ≥ `minLinkNavs` (8) link-navigations inside the host and ≥ `minDurationMs` (15 min) of engaged time.
**Verdict**: **real, but an evening behaviour — essentially absent from work hours**, and much rarer than the first pass suggested once stays were measured in engaged time rather than wall-clock span. Duration is the binding knob; link count barely matters. For RED-93 v1 it can be a 10 min yellow only. Note a spiral is only detectable ten-odd minutes in, so it must be emitted mid-stay, not at stay end.

### returnVelocityCollapse — drift returns accelerating
**Definition**: consecutive drift stays merge into *excursions*; gaps are the non-drift time between them. Fires once per session when the median of the last `window` (4) gaps drops below `collapsedGapMs` (5 min), while the session's earlier gaps had a median ≥ `minBaselineGapMs` (2 min) and ≥ `baselineFactor` (3) × the recent median.
**Verdict**: **plausible, and it has a real signature — the mid-morning unravelling** — but it overlaps quickCheckLoop, since both fire on the same bursts seen at different zoom levels. Keep it as a session-level escalation rather than a first-line toast, with `minBaselineGapMs` raised to 5 min. `collapsedGapMs` is inert: collapsed medians are always far below any sane value for it.

### tabSwitchFlicker — nervous switching
**Definition**: ≥ `minSwitches` (6) tab switches within `windowMs` (60 s) across ≥ `minDistinctTabs` (2) tabs, each landing dwell < `maxStayMs` (8 s), and — with `requireDriftTab` — at least one landing on a drift tab. Reads raw dwells, not stays.
**Verdict**: **the weakest of the six: mostly tab hygiene, not attention loss.** Without the drift requirement the bulk of hits are comparison shopping (many tabs of the same store) or simply hunting for a tab; with it, plenty of remaining hits are legitimate cross-referencing during an incident. Reasonable to **drop from RED-93 v1**; if kept, raise to 8 switches and yellow only.

### sunkSession — the session is gone
**Definition**: at session end, drift dwell ≥ `minDriftShare` (60%) of engaged time and ≥ `minDriftMs` (45 min).
**Verdict**: **real but retrospective** — by the time it can fire, the sitting is over. It never triggers inside work hours, which is the honest result of the scope decision rather than a flaw. Best use is **as the session grade** (the RED-94 popup placeholder): show live drift share and colour it at the softer 50% / 30 min bar, instead of emitting a toast.

## 6. Recommended starting point for RED-93

`config.json` as committed is the recommendation. Tiering for the toast layer:

| detector | yellow | red |
| --- | --- | --- |
| quickCheckLoop | 3 opens / 20 min / < 90 s / 60 s absence | 4 opens |
| postFrictionDrift | focus ≥ 2 min → user-initiated drift | focus ≥ 5 min |
| returnVelocityCollapse | baseline ≥ 5 min, ×3, window 4 | — |
| chainSpiral | 8 links & ≥ 10 min | ≥ 15 min |
| sunkSession | 50% & 30 min (grade colour, not a toast) | 60% & 45 min |
| tabSwitchFlicker | 8 / 60 s / < 8 s + drift tab | — (or drop) |

At these thresholds the expected volume inside the Mon–Fri 08–18 scope is a **small single-digit number of toasts per workday**, clustered late morning and mid-afternoon — workable for a neutral, informational tone. Exact rates in `FINDINGS_DATA.md` §5.

**Realtime feasibility**: every detector is causal, none look ahead. Dwell is the same state machine over live events; stays need only the previous stay; quickCheckLoop needs per-host open timestamps within its window; postFrictionDrift needs the previous stay plus the entry transition; chainSpiral needs the current stay's link count and start; returnVelocityCollapse needs the session's excursion gaps; sunkSession needs session totals. Nothing needs the server — the service worker can run all six from the buffer it already fills.

## 7. Open with Adnan (the eyeball pass)

Settled 2026-09-06: work-hours scope, and the idle/passive question answered by measurement rather than assumption. Still open:

1. **Host categories** (§4) — the one input that changes every downstream number. Review `config.json → hosts` and move anything miscategorised, in particular any news or reference site currently sitting in `neutral` that was really procrastination, and whether `shopping` should count as drift *during work hours*.
2. **Eyeball a few flagged work-hours sessions** against memory, using the local `out/report.md`. Candidate sessions are listed in `FINDINGS_DATA.md` §7.
3. **tabSwitchFlicker: keep or drop?**
4. **Scope edges**: is 18:00 the right cut, and are Saturdays ever work?

## 8. Follow-ups noted while doing this

- **Retention** — decided 2026-09-06: raw events kept 14 days, weekly report cards kept indefinitely. See SPEC §13 "Retention and report cards" and the Linear issue.
- **`audible` capture** (§3) — record `tabs.onUpdated` audible transitions so playback is explicit rather than inferred from input silence. Wanted before RED-93.
- `/api/sync`'s `dateAddedMs` carries the year-10000 bound hazard that `/api/browse-events` already fixed.
- The `chrome.history.search` backfill is moot — drop it.
