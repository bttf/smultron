# RED-92 scratch analysis

Throwaway analysis for [RED-92](https://linear.app/redpinesoftware/issue/RED-92/retroactive-categorization-against-real-data): sessionize the collected browse events, derive dwell, run the six candidate detectors, tune thresholds. Per the ticket this is NOT production code and builds no abstractions — the durable artifacts are **`config.json`** (tuned detector config + host categories) and **`FINDINGS.md`**. RED-93 ports the detectors into the extension service worker; this directory can be deleted afterwards.

**`bttf/smultron` is a public repo.** Nothing derived from the actual browsing data is committed: `data/`, `out/`, `FINDINGS_DATA.md` and `FINDINGS_SUMMARIZED.md` are all excluded (the first two via `.gitignore`, the two documents via `.git/info/exclude`, which is per-clone and not itself committed). Committed files carry the method and the tuned config only. If you add a document with real numbers in it, exclude it before you `git add`.

Not part of the pnpm workspace; runs with the web package's `tsx` and `postgres` driver.

```sh
# 1. snapshot prod → data/events.json (gitignored: personal browsing data)
cd web && set -a && . ./.env.local && set +a && node_modules/.bin/tsx ../analysis/red92/export.mts

# 2. reconstruct dwell, sessionize, run detectors, sweep thresholds → out/report.md + out/flags.json
cd web && node_modules/.bin/tsx ../analysis/red92/report.mts
```

| file | what |
| --- | --- |
| `export.mts` | dumps every `smultron.browse_events` row, time-ordered |
| `model.mts` | dwell state machine (SPEC §13 rule: active tab ∧ focused window ∧ non-idle, never across a bootId), bounce collapse, stays, sessions |
| `detectors.mts` | quickCheckLoop · tabSwitchFlicker · postFrictionDrift · chainSpiral · returnVelocityCollapse · sunkSession |
| `report.mts` | writes `out/report.md`: diagnostics, host table, per-day table, flag counts, threshold sweeps, one section per session with timeline + flags |
| `config.json` | every threshold, the host→category lists, and the work-hours scope — the thing RED-93 consumes |
| `FINDINGS.md` | **committed**: method, detector definitions, verdicts, recommended tiering — no measurements |
| `FINDINGS_DATA.md` | **local only**: every number measured from the real data, keyed to FINDINGS.md's sections |
| `FINDINGS_SUMMARIZED.md` | **local only**: the plain-language behavioural read, written for Adnan rather than for an implementer |

`data/` and `out/` are gitignored (they contain URLs and titles of everything browsed).
