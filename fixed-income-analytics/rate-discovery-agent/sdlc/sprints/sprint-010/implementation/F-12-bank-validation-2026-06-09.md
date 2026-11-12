# Sprint 010 Phase F — 12-bank validation cohort on D4

**Date:** 2026-06-09
**Execution:** `caj-bofia-rate-discovery-prod-xdxc51b`
**Image:** `4dd5382` (orchestrator-only + A2 + B DocIntel + C tenure-fix)
**Profile:** D4 dedicated
**Outcome:** ✅ Launch-blocking criteria met — infrastructure validated.

## Headline

| Metric | Value |
|---|---|
| Banks attempted | 12 |
| Succeeded | 9 |
| Failed | 3 |
| Wall time | ~24 min (19:55Z → 20:19Z) |
| Freezes / hangs | **0** |
| Infra failures | 0 |
| Receipt path / business-outcome reporting | clean |

The deploy-smoke poller's exit 1 is the normal `partial_failure` reaction (same as Sprint 009 9zulerb). Not an actual failure.

## Per-bank outcomes

| Bank | Status | Elapsed | Comment |
|---|---|---:|---|
| `state-bank-of-india` | ✓ | 177 s | orchestrator path; baseline 62 slabs |
| `bank-of-baroda` | ✓ | 286 s | orchestrator with templates |
| `hdfc-bank-limited` | ✓ | 103 s | orchestrator path; baseline 110 slabs |
| `bandhan-bank-limited` | ✓ | 458 s | orchestrator path |
| `citibank-na` | ✓ | 17 s | **previously failed (51 baseline slabs)** — now succeeds |
| `hdfc-bank-ibu` | ✓ | 2 s | registry_skip path (curated) |
| `abhyudaya-co-operative-bank-ltd-mumbai` | ✓ | 15 s | |
| `banswara-central-co-operative-bank-ltd` | ✓ | 10 s | **previously crashed in 3 s (Phase 6); DocIntel OCR now works** |
| `wai-urban-coop-bank-ltd` | ✓ | 26 s | **previously failed in 9zulerb cohort** |
| `au-small-finance-bank-limited` | ✗ | 4 s | pre-flight 3-4 s crash signature (Sprint 011) |
| `indusind-bank-ibu` | ✗ | 143 s | IBU template dispatched but extraction failed (Sprint 011) |
| `haryana-gramin-bank` | ✗ | 3 s | pre-flight crash signature (Sprint 011) |

## Significant wins verified

1. **Orchestrator-only path (A1) operational in cloud.** Every successful bank ran through orchestrator + template dispatch + (where needed) `_llm-fallback`. Zero `lib/agent.js` calls.
2. **DocIntel wiring (B) operational.** `banswara-central-co-operative-bank-ltd` (image PDF rate card) extracted in 10 s — previously crashed in 3 s pre-flight (Sprint 010 Phase 6 marked it cloud-incapable). DocIntel OCR is now working in cloud.
3. **Null-bank_type safety (A2) doesn't break anything.** All banks went through cleanly with no `bank_type required` failures.
4. **D4 profile operational.** No freezes; Bicep deploy clean.
5. **Three previously-failing banks now succeed.** `citibank-na`, `banswara-central-co-operative-bank-ltd`, `wai-urban-coop-bank-ltd` — all flagged cloud-incapable from Sprint 009 audit; all extract cleanly post-A1+A2+B+C.

## Carry-overs (Sprint 011, not launch-blocking)

1. **`au-small-finance-bank-limited` 4-second pre-flight crash.** AU SFB is templated (`pvb-multi-variant` likely) — something pre-flight is failing. Pattern matches the banswara/barmer crash class from before A2.
2. **`indusind-bank-ibu` 143-second failure with template.** The bank has a documented template (`indusind-ibu-gift-currency-3col`); needs investigation of why template extraction returned zero slabs despite running to completion.
3. **`haryana-gramin-bank` 3-second pre-flight crash.** Same pattern as AU SFB. Probably the same Sprint 011 root-cause.

## Launch-blocking criteria (operator-defined)

| # | Criterion | Status |
|---|---|---|
| 1 | Cohort completes without hang/freeze | ✅ 24 min, no freeze |
| 2 | ≥ 9/12 banks succeed | ✅ 9/12 |
| 3 | DocIntel exercised on image-PDF bank | ✅ banswara works |
| 4 | No infra failures (deploy, registry, blob) | ✅ |

**All four met. Proceeding to Phase G (513-cohort fire on D4) per operator directive.**

## Files

- `data/cohorts/sprint010-validation-12.json` — the cohort
- `logs/sprint-010/deploy-smoke-validation-12.log` — full deploy-smoke log
- `logs/sprint-010/execution-xdxc51b-receipt.json` — final execution receipt
- `logs/sprint-010/batch-xdxc51b.json` — per-bank batch results
- `sdlc/sprints/sprint-010/implementation/F-12-bank-validation-2026-06-09.md` — this doc
