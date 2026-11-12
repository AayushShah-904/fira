# Pre-flight for `pm-refresh-2026-q2` cohort re-run (513 banks)

> Plan ref: `~/.claude/plans/pivot-to-engine-failure-lovely-wombat.md` (2026-05-22)
>
> Goal: re-run the 513-bank pm-refresh-2026-q2 cohort with safety rails + targeted
> quick wins so the result is committable to PM. This document is the durable
> design artifact; the `.claude/plans/` file is the operator-facing version.

## Context

The engine accumulated significant improvements this session (Orch-1 / Orch-2 /
M3 OCR / FCNR-1 through FCNR-5; pack 7026 → 7434 slabs; FCNR audit clean). The
next planned cohort run is `data/cohorts/pm-refresh-2026-q2.json` (513 banks).

Before that run we need to close known per-bank gaps that would otherwise surface
as cohort failures, add operational safety that's currently missing, and set up
the quality gate with the correct baseline strategy.

### Dual-baseline strategy

Per operator (2026-05-22), the pack quality gate runs against **two** baselines:

| Baseline | File | Purpose |
|---|---|---|
| **April 16** | `pack/history/rates-pack-2026-04-16.json` | PM-published floor. The previous Claude-Code-internal-tooling run is what currently ships. New cohort MUST meet or beat this quality bar. |
| **May 14** | `pack/history/rates-pack-2026-05-14.json` | Prior pm-refresh-2026-q2 attempt (never shipped). Measures engine improvements made this session. |

April 16 is the harder bar (it's what PM expects). May 14 is the engine-efficacy
yardstick — it shows whether this session's fixes actually moved the needle.

### Acceptance for shipping to PM

`PASS` or `PASS_WITH_WARNINGS` on the April 16 gate run (PM floor met or beaten).
The May 14 gate run is documentary — `PASS_WITH_WARNINGS` is expected because the
session's engine reshapes (HDFC variants, Axis FCNR, Kotak +91) show up as
"regressions" on per-variant slab-count delta even though they're real
improvements. They are pre-seeded into `pack/quality-gate-accepts.json`.

## Approach (4 phases)

### Phase 1 — Engine quick wins

**1a. IDBI Orch-2 hint** — `idbi-bank-limited` registry already has `fd_nri_combined`
URL that serves NRE+NRO. Mirror the ICICI pattern:
```jsonc
"extraction": {
  "fd_nri_combined": { "type": "html", "fulfills_product": ["fd_nre", "fd_nro"] }
}
```
Reuses `findHintedHtmlUrl` (Orch-2). Bank-agnostic mechanism.

**1b. ICICI FCNR LLM prompt tweak** — the LLM extractor in `lib/actions/extract_html_table.js`
currently captures 2 of 6 currencies for ICICI. Add an enumeration rule to the
HARD RULES block that requires the emitted slab set to span every currency column
in the header row.

**1c. Partial-silent triage** — 5 active markers. Review each; clear stale,
retain real. `kotak-mahindra-bank-ibu` is a known variant-file-naming bug.

### Phase 2 — Operational readiness

**2a. OCR cost telemetry** — `extract_via_ocr.js` returns `cost_pages` per call.
Wire it into `lib/cost-tracker.js` so per-bank summary shows `ocr_cost_usd`
($10/1000 pages, Azure DI Layout S0). Currently invisible.

**2b. Output-dir cleanup** — `output/latest/*_attempt2.summary.json` orphans
accumulate across runs. New `scripts/cleanup-output-latest.js` prunes them and
optionally snapshots the current state to `output/runs/pre-pm-q2-<timestamp>/`.

**2c. 12-bank smoke cohort** — hand-picked banks covering each shipped fix class.
Local concurrency=3. Pass criteria:
- HDFC: 34/18/34/24 (Orch-1 + Orch-2)
- ICICI: ≥4 currencies on FCNR (after 1b)
- Axis: 324 dom + 72 NRE + 162 NRO + 53 FCNR (FCNR-2 dedup)
- Kotak: 42/41/40/28 (Orch-1)
- SBI: ≥30 FCNR slabs / 6 currencies (FCNR-3)
- Ajmer/Banswara/Barmer: 15/46/9 (M3 OCR)
- BoB: 6 FCNR slabs from OCR (FCNR-4b)
- south-indian: stays at 33 slabs / 7 currencies (FCNR-5 guard)
- Control banks: BoB-Baroda, PNB (no expected change)

### Phase 3 — Quality-gate dual-baseline

**3a. Pre-seed `pack/quality-gate-accepts.json`** with known-OK regressions vs
May 14:
- HDFC NRE 12→18, NRO 19→34 — engine fix
- Axis FCNR 12 mashed → 53 currency-tagged — engine fix
- Kotak +91 latent gains
- ICICI variant reshape
- BoB FCNR 4→6
- south-indian FCNR (no change after FCNR-4.1 revert)

These pass under `PASS_WITH_WARNINGS` instead of `BLOCK`.

**3b. Dual-gate wrapper** — `scripts/run-dual-gate.js` runs `quality-gate.js`
twice and emits side-by-side verdicts (April 16 floor / May 14 efficacy).

### Phase 4 — Cohort run + verify + ship

1. `node run-batch.js --cohort pm-refresh-2026-q2 --concurrency 3` (deliberate
   concurrency cap to avoid the timing-race that bit FCNR-4.1)
2. `node pack/build-pack.js`
3. `node scripts/run-dual-gate.js`
4. Triage: any per-bank slab drop > 20% gets investigated; legitimate engine
   reshapes get added to `quality-gate-accepts.json`
5. If April-16 verdict ≥ `PASS_WITH_WARNINGS`: copy `pack/dist/rates-pack.json`
   to `pack/history/rates-pack-<today>.json`, commit, hand to PM

## Files to modify

| File | Change | Phase |
|---|---|---|
| `data/bank-domains.json` | + IDBI `extraction.fd_nri_combined` hint | 1a |
| `lib/actions/extract_html_table.js` | Tighten LLM FCNR prompt's currency-enumeration rule | 1b |
| `output/latest/*.partial_silent.json` | Triage; clear stale | 1c |
| `lib/cost-tracker.js` | + OCR cost aggregation | 2a |
| `lib/orchestrator.js` | Drain `cost_pages` into cost-tracker | 2a |
| `scripts/cleanup-output-latest.js` | **NEW** — orphan pruner + snapshot | 2b |
| `run-batch.js` | Optional pre-run cleanup hook | 2b |
| `pack/quality-gate-accepts.json` | Pre-seed with this session's known-OK regressions | 3a |
| `scripts/run-dual-gate.js` | **NEW** — dual-baseline gate wrapper | 3b |
| `sdlc/sprints/sprint-004/implementation/cohort-pm-q2-rerun.md` | **NEW** — result tally + dual-baseline outcome | 4 |
| `pack/history/rates-pack-<today>.json` | **NEW** — cut from successful run | 4 |

## Reusable existing utilities

- `findHintedHtmlUrl` (`lib/extraction-hint.js`) — Orch-2 mechanism for IDBI
- `extractViaOcr` (`lib/actions/extract_via_ocr.js`) — emits `cost_pages`
- `tagCurrencyForeignVariant` + `textPatternMultiCurrencyGuard` (FCNR-5) — already
  integrated; no change
- `applyAccepts()` (`scripts/quality-gate.js:324-342`) — accepts mechanism ready;
  just author entries
- `pack/build-pack.js` — pack builder, no change

## Verification

| Phase | Check | Pass criteria |
|---|---|---|
| 1a | IDBI re-run | NRE + NRO files produced from `fd_nri_combined` URL |
| 1b | ICICI re-run | ≥ 4 distinct currencies on FCNR (was 2) |
| 1c | Marker review | Real markers documented in items-to-verify.md |
| 2a | OCR-using bank smoke | Summary includes `ocr_cost_usd > 0` |
| 2b | Cleanup dry-run + write | Orphans listed, then removed; snapshot present |
| 2c | 12-bank smoke | All counts ≥ expected; no FCNR null-currency |
| 3a | Gate run vs May 14 | `PASS_WITH_WARNINGS` (no unaccepted BLOCKs from known engine gains) |
| 3b | Dual-gate wrapper | Both verdicts emitted; ordering deterministic |
| 4 | Cohort run | ≥ 95% success across 513 banks |
| 4 | April-16 gate | `PASS` or `PASS_WITH_WARNINGS` (PM floor met) |
| 4 | Cost ceiling | LLM ~$5-10 + OCR ≤$1 |

## Out of scope

- **TMB LLM truncation fix** — will surface as 0-slab bank in cohort; documented
  as Cheerio improvement task, not blocking
- **Yes Bank / Federal Bank / IndusInd infrastructure blocks** — network/WAF,
  not engine
- **More `pending_vision` OCR hints** beyond Ajmer/Banswara/Barmer — operator-
  driven authoring cycle
- **DI managed-identity migration** — key-based fine for this run
- **Quality-gate baseline auto-archival** — manual `cp` works; automate later

## Risk register

| Risk | Mitigation |
|---|---|
| Background-run timing race overwrote south-indian in this session | Concurrency=3 (not 5); cleanup runs BEFORE batch starts, never during |
| OCR quota exhaustion mid-run | $10 budget alert already set; expected spend ≤ $1 worst case |
| April-16 gate fails (PM regression) | Triage per-bank; either fix or document acceptance; do NOT ship to PM if floor missed |
| Cohort takes too long | Local concurrency=3 → ETA ~3-4 hr for 513 banks (vs 80 banks/hr cloud) |
