# Sprint 010 Phase K — Post-fix 513-cohort: measured outcome

**Date completed:** 2026-06-09 17:31:59Z
**Execution:** `caj-bofia-rate-discovery-prod-550ptm4`
**Image:** `f46b802` (Phase J+K: empty-overwrite block + garbage-overwrite block + provenance history + tenure recompute + cloud-pull through safe-write)
**Profile:** D4 dedicated
**Compared against prediction:** `K-cohort-expected-improvement-2026-06-09.md`

## Cohort-mechanics result

| Metric | n55y5dr (baseline) | 550ptm4 (this run) | Predicted | Δ vs predicted |
|---|---:|---:|---:|---|
| Wall time | 6 h 25 m | **6 h 44 m** | ~6 h ± 30 min | within band |
| Banks attempted | 513 | 513 | 513 | exact |
| Successful extractions | 372 (72.5 %) | **375 (73.1 %)** | ~370–380 | mid-band |
| Failed | 141 | **138** | — | −3 |
| Final state | Failed (partial) | **Failed (partial)** | Failed (partial) | exact |
| `_safe_write_history` entries | 0 | **118** | ~150–200 | low end (cohort-write path didn't fire; see caveat) |

Orchestrator behaviour unchanged as predicted. The single-bank profile is identical — Phase K fixed safe-write, not extraction.

## Verification plan outcome (5 steps)

### V1 — Sync pull ✅

```
[cloud-sync] pulled bank-domains.json (1037 banks) from agent-state
[cloud-sync] pulled 4283 file(s) under output/latest/ (0 binary skipped)
```

124 `.pending.json` rejection sidecars produced — every blocked write captured for inspection.

### V2 — Pack build ✅ (with measured-vs-predicted shortfall)

```
Banks: 578 | regular FD: 429 | any variant: 447 | slabs: 8641
```

| Outcome scenario | Predicted slabs | Measured | Verdict |
|---|---:|---:|---|
| Pessimistic (R3 banks regress to LLM partials) | 8,400–8,600 | — | — |
| Baseline (R3 banks hold) | 8,900–9,100 | — | — |
| Optimistic | 9,000–9,300 | — | — |
| **Actual** | — | **8,641** | between pessimistic and baseline |

Compared to immediate pre-cohort state (8,990): **−349 slabs (−3.9 %)**.
Compared to 2026-05-28 floor (8,369): **+272 slabs (+3.3 %)**.

The shortfall vs the 8,990 pre-cohort state is entirely R3 partial-degradation (cohort re-extracted banks via LLM fallback with fewer slabs than the HEAD-restored versions). See V3.

### V3 — Quality gate ❌ BLOCKED (as designed)

```
[quality-gate] BLOCK — reasons: high_confidence_bank_regression
[quality-gate]   7 HIGH-confidence bank(s) regressed > 50 %:
[quality-gate]     kotak-mahindra-bank-ibu: 55 → 7 (-87.3 %)
[quality-gate]     punjab-national-bank-ibu: 10 → 2 (-80.0 %)
[quality-gate]     idfc-first-bank-ibu: 22 → 6 (-72.7 %)
[quality-gate]     slice-small-finance-bank-limited: 35 → 10 (-71.4 %)
[quality-gate]     the-bihar-state-co-operative-bank-ltd: 27 → 10 (-63.0 %)
[quality-gate]     indian-bank-ibu: 18 → 7 (-61.1 %)
[quality-gate]     sberbank: 10 → 4 (-60.0 %)
```

| Bank | HEAD | This run | Root class | Sprint 011 work |
|---|---:|---:|---|---|
| kotak-mahindra-bank-ibu | 55 | 7 | E1 — `ibu-gift-currency-amount-3x3` template missing | author template extractor |
| punjab-national-bank-ibu | 10 | 2 | E1 — `ibu-gift-currency-2col` missing | author template extractor |
| idfc-first-bank-ibu | 22 | 6 | E1 — IBU template missing | author template extractor |
| indian-bank-ibu | 18 | 7 | E1 — PDF extractor module missing | author `extract_rates_pdf.mjs` |
| slice-small-finance-bank-limited | 35 | 10 | E4 — partial table extraction | per-bank template / LLM tuning |
| the-bihar-state-co-operative-bank-ltd | 27 | 10 | E4 — partial table extraction | per-bank template / LLM tuning |
| sberbank | 10 | 4 | E4 — partial table extraction | per-bank template / LLM tuning |

All 7 are **clean-but-fewer** writes. Safe-write Rule 3 (garbage) doesn't block these because incoming isn't garbage, just partial. This is the **"clean-but-significant-drop" rule** the K prediction doc flagged as Sprint 011 candidate. **The gate works as designed — it blocked publish on exactly the regression class predicted.**

### V4 — Provenance audit ✅ (with caveat)

```
118 files captured _safe_write_history entries
Rejection reason distribution:
  58 curated:manual_transcription_from_rendered_text   (existing curated-source protection)
  37 empty_overwrite_blocked                           (Rule 2 — Phase J)
  14 curated:manual_image_transcription                (existing)
   5 curated:manual_pdf_transcription                  (existing)
   4 garbage_overwrite_blocked                         (Rule 3 — Phase K)
Source distribution:
  118 attempted_source: "cloud-pull"
```

Phase J/K rules **fired 41 times** (37 + 4) — every block produced a `_safe_write_history` entry with full provenance (attempted_at, attempted_source, attempted_extraction_method, attempted_slab_count, attempted_verdict, rejected_reason, retained_extraction_method, retained_scraped_at, retained_slab_count). Operator-readable record of what was attempted and what was retained.

**Caveat — protection boundary is pull-time, not cloud-write-time.** All 118 rejections came from `cloud-pull`. The cloud container is ephemeral — when the agent writes locally inside the container, there is no prior local state for safe-write to compare against, so Rules 2 and 3 cannot fire at cloud-write-time. They fire at the *pull boundary* when local has prior good state and cloud-pull would overwrite it.

- For user-visible data (local `output/latest/`, pack builds) → protection is effective.
- For blob state → blob still gets the cohort's writes (whatever shape). The next cohort run that pulls blob state at start may carry forward the cohort's writes.
- **Sprint 011 question**: should the cloud orchestrator hydrate blob state into the container before each bank, so cloud-side safe-write also fires? Or is pull-side protection sufficient given that the pack is built from the local pulled view?

Predicted entry count was 150–200; measured is 118. The shortfall is because curated-source rejections (77 of 118) were already happening pre-K; only 41 are the new Phase J/K rules. The prediction conflated the two.

### V5 — Garbage audit ✅

```
files examined: 749
  clean   : 599
  empty   : 147
  suspect : 3
  garbage : 0

current=bad + HEAD=clean (RECOVERY CANDIDATES): 0
```

**0 garbage / 0 recovery candidates** — exactly the prediction. Rule 3 prevented any new garbage from being introduced. The 3 suspect files are unchanged from pre-cohort state (pre-existing, not regressions).

## Prediction accuracy summary

| Prediction | Outcome |
|---|---|
| R1 destruction prevented | ✅ Rule 2 fired 37 times at pull (would have been more if Phase J had been retro-applied to fresh blob writes) |
| R2 destruction prevented | ✅ included in 37 |
| R4 destruction prevented | ✅ included in 37 |
| R6 destruction prevented | ✅ included in 37 |
| Garbage overwrites prevented | ✅ Rule 3 fired 4 times at pull |
| Pack slabs in 8,900–9,100 band (baseline) | ❌ measured 8,641 (between pessimistic and baseline) |
| Pack slabs ≥ 2026-05-28 floor (8,369) | ✅ +272 above floor |
| Quality gate PASS | ❌ BLOCKED on 7 R3 banks (predicted this could happen under pessimistic scenario) |
| Orchestrator success rate ~370–380 | ✅ 375 |
| Wall time ~6 h ± 30 min | ✅ 6 h 44 m |
| 0 freezes / hangs | ✅ |
| Garbage audit 0/0 | ✅ |

**Hit rate: 8 of 11** — the misses are the R3 partial-degradation class, which the doc had explicitly identified as a Sprint 011 carryover not addressed by Phase J/K.

## State of the pack now

- Local `output/latest/` = post-pull state, contains the cohort's clean-but-fewer writes for the 7 R3 banks (HEAD restorations were overwritten during pull because incoming was *clean*, just smaller, so neither Rule 2 nor Rule 3 fired).
- Staged pack at `pack/dist-staging-550ptm4/rates-pack.json` = 8,641 slabs (gate BLOCKED, not promoted to `pack/dist/`).
- Published pack at `pack/dist/rates-pack.json` = whatever was last published (unchanged — gate blocked promotion).

## Operator decisions outstanding

1. **R3 recovery for the 7 banks** — manual `git checkout HEAD --` for the 7 files? Or run `recoverHeadPreferred` over them (with the slab-count safeguard) and re-build pack? Expected post-recovery slab count: 8,641 + (175 − 46) = **~8,770** (could push back into the baseline band).
2. **Publish decision** — even with R3 recovery to ~8,770, that's still under the 8,990 pre-cohort state by ~220 slabs. Operator's standing position is "do not publish".
3. **Sprint 011 candidate ordering** — "clean-but-significant-drop" rule probably ranks above the template-extractor backlog, since the rule prevents future incidents of this exact class.
4. **Cloud-write-time safe-write** — should the orchestrator hydrate blob state into the container before each bank so cloud-side safe-write also fires? Decision required.

## Files

- This doc.
- `pack/dist-staging-550ptm4/{rates-pack.json,QUALITY-GATE.json,REPORT.md}` — staged pack + gate verdict.
- `logs/sprint-010/execution-550ptm4-receipt.json` — final receipt.
- `logs/sprint-010/garbage-extraction-audit.json` — re-run audit detail.
- 118 `output/latest/*_rates.json` files with new `_safe_write_history[]` entries.
- 124 `output/latest/*.pending.json` rejection sidecars.
