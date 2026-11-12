# Sprint 010 Phase K — Post-fix 513-cohort: expected improvement

**Date fired:** 2026-06-09
**Image:** `f46b802` (Phase J+K: empty-overwrite block + garbage-overwrite block + provenance history + tenure recompute + cloud-pull through safe-write)
**Profile:** D4 dedicated (kernel-isolation needed for cohort-scale per Sprint 009/010 evidence)
**Predecessor for comparison:** `n55y5dr` (Sprint 010 Phase G), 2026-06-08 → 2026-06-09

## Baseline state (pre-cohort)

| | Slabs | Banks (in pack) | Source |
|---|---:|---:|---|
| 2026-05-28 baseline | 8,369 | 517 | pre-Sprint-010 floor |
| n55y5dr raw cohort output | 6,965 | 578 | what destructive overwrites produced |
| Post-Phase-J recovery | 8,299 | 578 | empty-overwrite recovery (R1/R2/R4/R6) |
| **Post-Phase-K state (now)** | **8,990** | 578 | garbage-overwrite recovery + tenure fix |

## What this cohort run tests

Two distinct hypotheses:

1. **The Phase J+K safe-write rules prevent the destructive overwrites observed in n55y5dr.** Concretely: when the cohort's failure-path emits `llm_inline_extraction` with `rate_slabs:[]` (the R2 pattern that blanked 499 slabs across 36 banks), safe-write rejects → existing slabs preserved → no recovery needed.

2. **Provenance is captured end-to-end.** When safe-write rejects, the retained file gets one history entry per attempt with `attempted_at`, `attempted_source`, `attempted_extraction_method`, `attempted_slab_count`, `attempted_verdict`, `rejected_reason`, `retained_extraction_method`, `retained_scraped_at`, `retained_slab_count`.

## Expected outcome (predictions)

### What WILL improve

| Error class | n55y5dr impact | Expected this run | Mechanism |
|---|---:|---:|---|
| R1 — registry_skip blanks curated content | −911 slabs across 65 banks | **0 destruction** | safe-write Rule 2 (empty-overwrite block) |
| R2 — failure-path blanks via empty llm_inline_extraction | −499 slabs across 36 banks | **0 destruction** | Rule 2 |
| R4 — LLM/PDF re-extraction zero over non-zero | −61 slabs across 3 banks | **0 destruction** | Rule 2 |
| R6 — registry_skip with `recovered` / `single_headline_rate` | −56 slabs across 8 banks | **0 destruction** | Rule 2 |
| Garbage-extraction overwrites (chittoor / sbpp / kerala-state class) | −62 slabs across 3 banks (after pack reasonableness filter) | **0 destruction** | Rule 3 (garbage-overwrite block) |
| E3 tenure parser gaps ("Overnight", "1Y to <2Y") | ~10–20 slabs left with null tenure days | **Fixed at normalize time** | parse-tenure preset + recompute-from-text |
| E5 cloud/sync.js#pull bypassing safe-write | invisible cumulative erosion | **Closed** | pull routes config/rates/summary through safeWriteArtifact |

**Total destruction prevented:** ≈ **1,589 slabs** (R1+R2+R4+R6+garbage).

### What WON'T improve (Sprint 011 work)

| Error class | Cause | Slabs still missing |
|---|---|---:|
| E1 — IBU GIFT multi-currency truncation | template IDs declared in bank-domains.json but not registered in `lib/extractors/dispatch.js#REGISTRY` — orchestrator falls back to `_llm-fallback` which only emits USD | ~208 across 6 banks |
| E2 — FCNR variant currency truncation | same root cause as E1 (or no template_fcnr at all) | ~96 across 5 banks |
| E4 — General partial table extraction | per-bank template/LLM under-extraction (bandhan, slice, dbs, citi, etc.) | ~200 across ~10 banks |
| E6 — Cohort failure clusters (49 pre-flight + 56 short + 30 long) | orchestrator/IBU/co-op specific upstream issues | ~141 banks fail |

Note: even though these classes aren't fixed, the safe-write rules now ensure that **failures in these classes can't destroy good prior data**. The R3 banks (kotak-IBU-gift 55, hsbc-fcnr 23, etc.) restored to HEAD will get a history entry if the cohort tries to overwrite with the LLM's partial extraction — but they may still get overwritten (incoming clean, fewer slabs is not blocked). If that happens, the quality-aware recovery script restores HEAD again. **This is a known limitation; a "clean-but-significant-drop" rule is Sprint 011 candidate.**

### Pack-level expectation

| Outcome | Expected slab count | vs current (8,990) |
|---|---:|---|
| Pessimistic (R3 banks regress to LLM partials, recoverable) | 8,400–8,600 | −400 to −600 raw; +400 to +600 after recovery script |
| Baseline (R3 banks hold approximately) | **8,900–9,100** | **same or slightly better** |
| Optimistic (some banks legitimately improve) | 9,000–9,300 | +10 to +300 |

### Cohort-mechanics expectation

| Metric | n55y5dr | Expected |
|---|---:|---:|
| Banks attempted | 513 | 513 |
| Successful extractions | 372 (72.5 %) | **~370–380** (orchestrator behaviour unchanged) |
| Wall time | 6 h 25 m | **~6 h ± 30 min** (orchestrator + tier-2 LLM unchanged) |
| Freezes / hangs | 0 | **0 expected** (D4 isolation held last time at scale) |
| `_safe_write_history` entries created | 0 (didn't exist) | **~150–200** across the rejected-write set |

## Verification plan post-cohort

1. **Receipt check:** `az containerapp job execution show` — should land `state: Failed` (exit-1 partial_failure, same signal as 12-bank validation) with non-zero successes.
2. **Sync pull + pack rebuild:** `node cloud/sync.js pull` + `node pack/build-pack.js`. Expect 8,900+ slabs.
3. **Quality gate:** `node pack/quality-gate.js`. **Expect PASS** (no `global_slab_drop`, no high-conf regressions). If it still blocks, the specific banks blocking should be in R3 territory and recoverable via the quality-aware recovery script.
4. **Provenance audit:** sample a few banks I'd expect to have rejection history (e.g., banks in the 141-failure set: bank-of-ceylon, axis-bank-ibu, au-sfb-fcnr). Each should have a `_safe_write_history[]` entry showing the cohort's failed write attempt.
5. **Garbage audit:** re-run `scripts/analysis/find-garbage-extractions-2026-06-09.js`. Expect 0 garbage candidates, 0 recovery candidates.

## Provenance demo (target shape of `_safe_write_history` post-cohort)

For e.g. `output/latest/bank-of-ceylon_rates.json` (which failed in n55y5dr and got blanked, then was restored from HEAD), the new cohort run should leave a history entry:

```json
"_safe_write_history": [
  {
    "attempted_at": "2026-06-09T12:34:56.789Z",
    "attempted_source": "agent",
    "attempted_extraction_method": "llm_inline_extraction",
    "attempted_slab_count": 0,
    "attempted_verdict": "empty",
    "rejected_reason": "empty_overwrite_blocked",
    "retained_extraction_method": "automatic_html_static",
    "retained_scraped_at": "2026-05-23T09:27:43.736Z",
    "retained_slab_count": 11
  }
]
```

Operators reading the file post-cohort see exactly when the failed write happened, by which source, with what extraction_method and slab count, and what was retained.

## Sprint 011 candidates surfaced by this run (if predictions hold)

1. **Author missing template extractors** in `lib/extractors/`:
   - `ibu-gift-currency-amount-3x3` (kotak-IBU)
   - `ibu-gift-currency-2col` (punjab-national-IBU)
   - `indusind-ibu-gift-currency-3col`
   - `hsbc-fcnr-per-currency-2col`
   - `union-fcnr-multi-currency-amount-bucket`
   - `extract_rates_pdf.mjs` (indian-bank-IBU's referenced module)
2. **"clean-but-significant-drop" safe-write rule** — block writes where existing is clean with N slabs and incoming is clean with < N/2 slabs (or similar threshold). Tunable.
3. **Cohort failure cluster triage** — the 49 + 56 + 30 banks; per-sub-class fixes.
4. **R3 partial-degradation per-bank inspection** for the LLM-fallback banks (bandhan, slice, dbs, citi, etc.).

## Files

- This doc.
- `logs/sprint-010/deploy-smoke-513-d4-post-k.log` — cohort run log (in flight).
- Forthcoming: `logs/sprint-010/batch-<exec>.json`, `execution-<exec>-receipt.json`, comparison report.
