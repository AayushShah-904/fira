# Pre-flight implementation notes — pm-refresh-2026-q2 re-run

> Design ref: [`../design/cohort-pm-q2-pre-flight.md`](../design/cohort-pm-q2-pre-flight.md)
>
> Captures what landed in Phases 0-3 of the pre-flight plan. Phase 4 (the
> 513-bank cohort run itself) gets its own document at `cohort-pm-q2-rerun.md`
> after that run completes.

## Phase summary

| Phase | What landed | Commit |
|---|---|---|
| 0 | SDLC design doc `cohort-pm-q2-pre-flight.md` | — |
| 1a | IDBI Orch-2 hint (`fd_nri_combined` fulfills fd_nre + fd_nro + fd_fcnr) | bundled |
| 1b | LLM FCNR prompt: currency-completeness HARD RULE | bundled |
| 1c | partial_silent triage: cleared 4 stale markers (citibank, kotak-ibu, mashreqbank, sonali); kept ujjivan (real); lowered citibank floors 34→17 | bundled |
| 2a | OCR cost telemetry in `lib/cost-tracker.js` (`recordOcrPages`, `ocr_cost_usd`, `ocr_pages`) + orchestrator + runner wiring + 6 unit tests | bundled |
| 2b | `scripts/cleanup-output-latest.js` — orphan pruner with optional snapshot. Pruned 622 orphans across 361 banks; snapshot at `output/runs/pre-pm-q2-2026-05-22/` | bundled |
| 2c | 12-bank smoke cohort run — verified all expected outcomes (see verification table below) | — |
| 3 | Pre-seeded `pack/quality-gate-accepts.json` with 10 known-OK regressions; `scripts/run-dual-gate.js` wrapper runs gate against April 16 + May 14 | bundled |

## Files changed

| File | Change |
|---|---|
| `sdlc/sprints/sprint-004/design/cohort-pm-q2-pre-flight.md` | NEW — design doc |
| `sdlc/sprints/sprint-004/design/README.md` | Index entry |
| `data/bank-domains.json` | + IDBI `extraction.fd_nri_combined` Orch-2 hint |
| `lib/actions/extract_html_table.js` | Added FCNR-1b currency-completeness rule to LLM HARD RULES block |
| `lib/cost-tracker.js` | `recordOcrPages(n)` method; summary now exposes `ocr_cost_usd`, `llm_cost_usd`, `ocr_pages`. Default $0.01/page (S0 tier); override via `AZURE_DI_LAYOUT_PRICE_PER_PAGE`. |
| `lib/orchestrator.js` | `ocrPagesTotal` accumulator; drains `extraction.cost_pages` from `extract_via_ocr` calls; returned in result envelope |
| `run-discovery.js` | Calls `tracker.recordOcrPages(result.ocr_pages)` so per-bank summary shows OCR spend |
| `tests/lib/cost-tracker.test.js` | NEW — 6 tests for OCR telemetry path |
| `scripts/cleanup-output-latest.js` | NEW — orphan retry file pruner with `--snapshot <label>` |
| `data/expected-slab-floors.json` | citibank-na floors 34→17 (Citi wound down India retail) |
| `data/cohorts/smoke-pm-q2-pre-flight.json` | NEW — 12-bank smoke cohort |
| `output/latest/*.partial_silent.json` | 4 cleared (citibank, kotak-ibu, mashreqbank, sonali); 1 retained (ujjivan-fcnr — real, no OCR hint yet) |
| `pack/quality-gate-accepts.json` | Pre-seeded with 10 accepts (5 rate-card shrinkage, 5 dropped-but-empty banks); 17 open real regressions documented |
| `scripts/run-dual-gate.js` | NEW — dual-baseline gate wrapper (April 16 PM floor + May 14 engine efficacy) |

## Acceptance criteria verification

| Criterion | Result |
|---|---|
| Tests still green | 813 + 6 cost-tracker = **819 pass / 1 skip / 0 fail** |
| IDBI Orch-2 hint validates | JSON parses; `findHintedHtmlUrl` resolves URL for fd_nre + fd_nro + fd_fcnr |
| Partial_silent triage | 4 stale cleared; 1 real retained; expected-slab-floors updated |
| OCR cost wiring | Smoke run on an OCR-using bank (BoB) reports `ocr_cost_usd > 0` in summary |
| Output cleanup helper | Dry-run lists 622 orphans; `--write` removes all; snapshot present at `output/runs/pre-pm-q2-2026-05-22/` |
| Dual-gate wrapper | Runs both baselines, emits side-by-side verdict; exit-code matches April-16 outcome |
| Accepts pre-seed | 10 entries; gate run against May 14 acknowledges accepts in `Summary counts` block |

## Verification commands

```bash
# Tests
node --test --test-force-exit                  # → 819 pass / 1 skip / 0 fail

# IDBI hint
node -e "const {findHintedHtmlUrl} = require('./lib/extraction-hint'); \
  const data = JSON.parse(require('fs').readFileSync('data/bank-domains.json')); \
  console.log(findHintedHtmlUrl(data['idbi-bank-limited'], 'fd_fcnr'))"

# Partial_silent markers
ls output/latest/*.partial_silent.json         # → only ujjivan-small-finance-bank-limited

# Output cleanup
node scripts/cleanup-output-latest.js          # → "No orphans to prune. Done."

# Smoke cohort
node run-batch.js --cohort smoke-pm-q2-pre-flight --concurrency 3 --path orchestrator

# Dual gate
node scripts/run-dual-gate.js
```

## Known open items (for Phase 4 triage)

These are real engine regressions (not bank-side rate-card changes); they were
NOT accepted in the gate. Each needs investigation in Phase 4 or beyond:

- **bank-of-india** (nre 11→7, nro 11→0) — orchestrator regression
- **bank-of-india-ibu** (regular 8→0) — IBU extraction
- **idbi-bank-ibu** (gift 48→0) — investigate
- **indusind-bank-ibu** (gift 24→0) — JS-render block
- **idfc-first-bank-limited** (nre 5→1, nro 13→1)
- **nabard** (5→0) — extract regression
- **tamil-nadu-grama-bank** (10→0) — RRB regression
- **ujjivan-fcnr** (5→0) — known FCNR image-PDF; partial_silent marker retained
- **chennai-central-co-operative-bank-ltd** (11→0)
- 9 banks dropped from pack — verify rate pages still up

## Out of scope for pre-flight

- Quality-gate baseline auto-archival script (manual `cp` works)
- TMB LLM truncation fix (separate Cheerio-path task)
- Yes Bank / Federal Bank / IndusInd infrastructure blocks
- DI managed-identity migration

## Phase 2c smoke cohort outcome (12 banks, completed 2026-05-22)

Smoke ran via `run-batch.js --cohort smoke-pm-q2-pre-flight --concurrency 3 --path orchestrator`. All 12 banks ran on the orchestrator path; per-variant counts met or exceeded expectations:

| Bank | dom / nre / nro / fcnr | Notes |
|---|---|---|
| hdfc-bank-limited | 34 / 18 / 34 / 24 | Exact match (Orch-1 + Orch-2) |
| icici-bank-limited | 5 / 12 / 12 / 17 | FCNR-3 fix preserved; LLM 1b prompt didn't expand currency coverage further (separate follow-up) |
| axis-bank-limited | 324 / 72 / 162 / 53 | Exact match (M2.6 PDF + FCNR-1/2 OCR; 1 OCR page) |
| kotak-mahindra-bank-limited | 42 / 41 / 40 / 61 | +33 FCNR vs expected — extra LLM extraction coverage |
| state-bank-of-india | 10 / 7 / 13 / 36 | All 6 currencies tagged (FCNR-3 sync working) |
| ajmer-central-co-operative-bank-ltd | 15 (OCR) | Expected 15 ✓ |
| banswara-central-co-operative-bank-ltd | 33 (OCR) | 46 → 33; FCNR-2c cross-page dedup correctly collapsed duplicates (not regression) |
| barmer-central-co-operative-bank-ltd | 9 (OCR) | Expected 9 ✓ |
| bank-of-bahrain-and-kuwait-bsc | 18 / 18 / 18 / 6 | FCNR-4b OCR working; regular/NRE/NRO newly extracted via orchestrator (was only regular previously) |
| south-indian-bank-limited | 29 / 42 / 28 / 33 | FCNR-5 guard preserved 33-slab 7-currency clean version (NOT overwritten by text-pattern) |
| bank-of-baroda | 34 / 30 / 34 / 25 | Control bank unchanged from expected |
| punjab-national-bank | 21 / 21 / 21 / 21 | Control bank unchanged |

OCR cost telemetry verified end-to-end: 17 OCR pages total ≈ $0.17 across the smoke cohort. Each per-bank summary shows `ocr_cost_usd` + `ocr_pages` alongside `llm_cost_usd`.

## Bugs caught + fixed during Phase 2c

The smoke exposed two latent bugs that would have invalidated the 513-bank cohort:

### Bug A — `run-batch.js` dropped `--path` flag (fix: commit `49624cc`)

`--path orchestrator` to `run-discovery.js` worked since 2026-05-16 (commit `0120175`), but `run-batch.js` never parsed or forwarded the flag. Result: every cohort invocation with `--path orchestrator` silently routed through the LLM path.

Blast radius (audited via `output/latest/*.summary.json`):
- 489 LLM-path / 15 orchestrator-path / 5 other across the 513-bank window
- The 15 orchestrator runs were all M2.6 PDF-hint auto-switches (Axis-class banks); HTML/OCR hints did NOT trigger the auto-switch
- The May 20 pm-refresh-2026-q2 cohort + the May 21 per-category cohorts all ran via LLM path (consistent with their op-guides, which did not pass `--path orchestrator`)

**Implication for the new run**: this 513-bank cohort will be the FIRST one to actually exercise orchestrator at scale. The May 14 baseline pack is LLM-path; comparing the new run against it measures both engine-path change AND new fixes (Orch-1/2/M3/FCNR-1..5) together — which is exactly what we want for the engine-efficacy delta.

### Bug B — orchestrator path always exited 1 (fix: commit `915cf7a`)

`runOrchestratorAttempt()` returns the orchestrator's result object verbatim:
```js
{ ok, bank_code, run_dir, signals, ... }
```

The exit-code site at `run-discovery.js:924` reads `finalResult.success` — undefined for orchestrator returns → `process.exit(1)` always. LLM path returns include `success: true/false`, so this only bit orchestrator runs.

Without this fix, run-batch would have reported every cohort bank as FAILED in its BATCH SUMMARY block despite successful extraction. Verified on PNB re-run: exit code now 0.

### Acknowledgement

Both bugs surfaced ONLY because the smoke cohort actually exercised `run-batch --path orchestrator` for the first time in the project's history. Phase 2c's "catch wiring-level regressions before the big run" purpose paid off — saving an estimated 2-4 hours of cohort time + miscounted results.

## Files added/modified in this phase

| File | Change | Phase |
|---|---|---|
| `run-batch.js` | Parse + forward `--path` to `run-discovery.js` | 2c (bug A) |
| `run-discovery.js` | Map orchestrator `ok` → `success` in return path | 2c (bug B) |
| `data/cohorts/smoke-pm-q2-pre-flight.json` | NEW — 12-bank smoke cohort | 2c |
| `pack/quality-gate-accepts.json` | Pre-seeded 10 accepts; 17 open regressions documented | 3a |
| `scripts/run-dual-gate.js` | NEW — April-16 + May-14 dual-gate wrapper | 3b |
| `sdlc/sprints/sprint-004/implementation/cohort-pm-q2-pre-flight.md` | This doc | — |

## Next step

Phase 4 — execute the 513-bank `pm-refresh-2026-q2` cohort with `--path orchestrator` (now correctly forwarded) and `--concurrency 3`. Document outcome in `cohort-pm-q2-rerun.md`.
