# Sprint 010 Phase I — Post-cohort analysis (513-cohort n55y5dr)

**Date:** 2026-06-09
**Execution:** `caj-bofia-rate-discovery-prod-n55y5dr`
**Cohort:** `pm-refresh-2026-q2.json` (513 banks)
**Image:** `4dd5382` (orchestrator-only + A2 + B DocIntel + C tenure-fix)
**Profile during run:** D4 dedicated (now drained — Phase H complete)

## Headline

**First 500+ bank run to complete in a single execution.**

| Metric | Value |
|---|---|
| Banks attempted | 513 |
| Succeeded | **372 (72.5 %)** |
| Failed | 141 (27.5 %) |
| Wall time | 6 h 25 m (20:24Z → 02:49Z next day) |
| Throughput | ~80 banks/hour |
| Freezes / hangs | **0** |
| Infra failures (deploy, registry, blob) | 0 |
| Cohort outcome | `partial_failure` (same exit-1 signal as 12-bank validation — not infra) |

Compare to baseline-run history:
- Sprint 009 5kz1vm8: froze at ~314 banks on Consumption
- Sprint 009 fpecv10: froze at ~28 banks on Consumption (different cluster)
- Sprint 009 9zulerb: 198 banks on D4, completed in 3h57m (200-bank cohort, partial)
- **Sprint 010 n55y5dr: 513 banks on D4, completed in 6h25m, no freeze** ← first single-run completion

The kernel-isolation hypothesis (D4 Dedicated profile) holds at full cohort scale.

## Success rate by category

| Category | Total | Success | Rate |
|---|---:|---:|---:|
| Public Sector Bank | 12 | 11 | 92 % |
| Private Sector Bank (Indian) | 21 | 18 | 86 % |
| Scheduled State Co-operative Bank | 24 | 21 | 88 % |
| Scheduled Urban Co-operative Bank | 52 | 42 | 81 % |
| Small Finance Bank | 11 | 8 | 73 % |
| Foreign Bank | 44 | 32 | 73 % |
| Non-Scheduled Urban Co-operative Bank | 132 | 95 | 72 % |
| District Central Co-operative Bank | 130 | 90 | 69 % |
| Regional Rural Bank | 28 | 19 | 68 % |
| IFSC Banking Unit (IFSCA) | 37 | 23 | 62 % |
| Payments Bank | 6 | 3 | 50 % |
| Non-Scheduled State Co-operative Bank | 10 | 4 | 40 % |
| Financial Institution | 4 | 4 | 100 % |
| Local Area Bank | 2 | 2 | 100 % |

## Failure breakdown (141 total)

By elapsed time — distinguishes pre-flight crash from real-but-failed extraction:

| Bucket | Count | Interpretation |
|---|---:|---|
| <5 s (pre-flight crash) | 49 | Crash before any fetch — registry/config-load issue or fast hard error |
| 5–120 s (short) | 56 | Fetch attempted, failed quickly (WAF block, no rate page found, template miss) |
| 120–300 s (mid) | 6 | Some fetch + parse work then failed |
| ≥ 5 min (long) | 30 | Tried hard — template ran but extracted zero slabs |

Pre-flight crashes (<5s) by category:

| Category | Count |
|---|---:|
| Non-Scheduled Urban Co-operative Bank | 15 |
| IFSC Banking Unit (IFSCA) | 8 |
| District Central Co-operative Bank | 8 |
| Foreign Bank | 5 |
| Regional Rural Bank | 4 |
| Non-Scheduled State Co-operative Bank | 3 |
| Small Finance Bank | 2 |
| Payments Bank | 2 |
| Private Sector Bank (Indian) | 1 |
| Scheduled Urban Co-operative Bank | 1 |

The 8 IBU pre-flight crashes (axis-bank-ibu, bank-of-india-ibu, canara-bank-ibu, …) reproduce the Phase F1 indusind-bank-ibu pattern — IBUs have curated `registry_skip` paths that hit a hard path in some cases. **Sprint 011 root-cause hunt.**

The 49 pre-flight crashes overall are the high-leverage Sprint 011 target — fixing one class likely fixes the whole bucket.

## Pack rebuild (post-cohort)

```
Banks: 578 | regular FD: 335 | any variant: 355 | slabs: 6965
```

vs. baseline (2026-05-28):

| | Baseline | New | Delta |
|---|---:|---:|---:|
| Banks (in pack) | 517 | 578 | +61 |
| Slabs (total) | 8 369 | 6 965 | **−1 404 (−16.8 %)** |

Both quality gates **BLOCK**:

### Gate 1 — `pack/quality-gate.js` (Sprint 010 Phase 1, slab-count)

```
BLOCK — reasons: global_slab_drop, high_confidence_bank_regression
  global slab delta: -16.78 % (threshold: -10 %)
  96 HIGH-confidence bank(s) regressed > 50 %
```

### Gate 2 — `scripts/quality-gate.js` (Sprint 008 Phase 7, structural + reasonableness)

```
Verdict: BLOCK
Summary: 153 regressions, 81 anomalies, 345 warnings, 133 gains, 7 new_variants
Findings by class: REGRESSION=153 GAIN=133 stale_effective_date=95
                   senior_below_general_minor=77 fcnr_currency_anomaly=60
                   senior_below_general=53 senior_premium_peer_outlier=47 …
```

Reports written to `logs/sprint-010/quality-report.{md,json}`.

### Why both gates block — three distinct causes

1. **Banks that failed in this cohort lost their slabs.** Many of the 153 regressions
   correspond to the 141 cohort failures (e.g., `bank-of-ceylon regular 11→0` — Foreign
   Bank pre-flight crash; `axis-bank-ibu gift 24→0` — IBU pre-flight crash;
   `au-small-finance-bank-limited fcnr 25→0` — SFB pre-flight crash). The post-cohort
   pack-rebuild empties `_rates.json` for these. **Not a regression in the extractor —
   a regression in coverage caused by the pre-flight bucket.**

2. **Partial_silent pattern still occurring on successful runs.** `axis-bank-limited
   regular 162→0` — bank reports `success`, but the regular variant `_rates.json`
   contains `rate_slabs: []` with warning `discovery_status=curated:manual_pdf_transcription
   ... Re-run with --rates-only mode`. The NRE/NRO/FCNR variants did extract (72/162/53
   slabs). **Measurement methodology issue:** the gate compares the regular variant only
   — actual cross-variant coverage for Axis is healthy at ~305 slabs.

3. **Genuine extraction degradation** on a small set (bandhan, barclays, bank-of-india)
   — same pattern flagged in Sprint 009 9zulerb close-out. Sprint 011 partial_silent
   root-cause work.

## What this cohort definitively proves

| Claim | Evidence |
|---|---|
| Orchestrator-only path works in cloud at scale | 372 of 513 banks succeeded through orchestrator + template dispatch (zero `lib/agent.js` calls — module deleted in A1) |
| Azure Document Intelligence wiring works | banswara-central-co-operative-bank-ltd succeeded (was pre-flight crash in Phase 6 of Sprint 010 prior); image-PDF OCR fallback live |
| D4 kernel-isolation eliminates the cohort-runtime freeze at full scale | 6h25m clean run; both prior Consumption attempts (5kz1vm8 + fpecv10) froze well below 513 |
| Null-bank_type safety harness (A2) doesn't break anything | All 372 successes had categories derived from cohort or 'UNKNOWN' sentinel — no failures attributable to A2 |
| Cloud cost is bounded — D4 baseline drained | Phase H two-step revert completed: job → Consumption (3c1d600), env drains d4-jobs (c47f7f7). Baseline billing stops with last deploy |

## What this cohort does NOT prove (deferred to Sprint 011 candidate list)

1. **Pre-flight crash root cause (49 banks).** Cluster spans IBUs, FBs, RRBs, co-ops —
   may be one shared root cause (cohort-row missing field, slug normalization), may be
   3–4 distinct ones. Phase 6 of original Sprint 010 plan (banswara/barmer) addressed
   one slice; the rest is open.
2. **Partial_silent root cause** for the 3 banks where orchestrator returns success but
   variant slab counts crash to ~0 (axis regular, bandhan regular/nre/nro, barclays
   regular/fcnr). Original Sprint 010 Phase 5 was time-boxed for this; deprioritized
   in favor of A1–F when operator authorized A1+A2+B+C+D+F+G+H+I.
3. **The 30 "long failures" (>5min, template ran)** are likely the partial_silent
   cousins — template completed but zero rows extracted. Worth one diff against
   the 372 successes by template_id.
4. **Pack publish.** Both gates BLOCK; per `feedback_no_fake_approvals`, the
   `--accept-regression` decision sits with operator.

## Pending operator decisions (post-Sprint-010)

| # | Question | Files for context |
|---|---|---|
| 1 | Accept-regression and publish the 6,965-slab pack, with a note that the drop is dominated by 141 cohort failures + known partial_silent? | `pack/dist/QUALITY-GATE.json` after `pack/quality-gate.js --accept-regression "..."` |
| 2 | Block publish and carry the failing-bank fixes to Sprint 011 first? | `sdlc/sprints/sprint-010/retrospection/retro.md` (draft) |
| 3 | Mark the 49 pre-flight-crash banks `cloud_capability.capable=false` before next cohort so the splitter routes them local? | `scripts/registry/mark-capability.js` (per Sprint 010 plan Phase 2) |
| 4 | Sprint 010 close approval | Retro draft — operator approval required per `feedback_sprint_close_consent` |

## Files produced this phase

- `logs/sprint-010/execution-n55y5dr-receipt.json` — final receipt
- `logs/sprint-010/batch-n55y5dr.json` — per-bank batch results
- `logs/sprint-010/deploy-h-step1.log`, `logs/sprint-010/deploy-h-step2.log` — H revert deploys
- `logs/sprint-010/quality-report.{md,json}` — Sprint 008 Phase 7 gate output (BLOCK)
- `pack/dist/rates-pack.json` — rebuilt pack (NOT published; both gates blocked)
