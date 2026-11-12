# Sprint 009 cloud-validation-3 — cohort outcome & pack comparison

**Date:** 2026-06-06
**Execution under review:** `caj-bofia-rate-discovery-prod-9zulerb`
**Profile:** Container Apps Dedicated D4 (Option 2c)
**Cohort:** `pm-refresh-2026-q2-resume.json` — 198 banks, resume of the 513-bank `pm-refresh-2026-q2` cohort

---

## 1. Cohort run — D4 dedicated profile

### Headline

Cohort completed end-to-end with **no silent freeze** — the Dedicated-profile hypothesis is **confirmed**.

| Metric | Value |
|---|---|
| Job wall time | 07:14:43Z → 11:12:03Z = **3h 57min** |
| `replicaTimeoutSec` ceiling | 72,000 s (20h) — used ~20% of budget |
| Banks processed | **198 / 198** (zero missed) |
| Succeeded | 182 (91.9%) |
| Failed | 16 (8.1%) |
| Rate-limited / skipped | 0 / 0 |
| Business outcome | `partial_failure` (per existing definition: any failure → partial) |
| Platform-reported "Failed" | Replica exit code ≠ 0 because of bank failures; not a runtime fault |

### Comparison vs the two prior Consumption-profile runs

| Run | Profile | Banks attempted | Banks completed | Outcome | Notes |
|---|---|---:|---:|---|---|
| `5kz1vm8` | Consumption | 513 | ~314 | **silent freeze** at bank #315 | replica still "Running" indefinitely; no event-loop activity |
| `fpecv10` | Consumption (resume #1) | 199 | ~28 | **silent freeze** at bank #29 | same fault pattern |
| `9zulerb` | **Dedicated D4** | 198 | **198** | clean partial_failure | this report |

The two Consumption-profile attempts froze at the kernel layer after roughly 300-and-30 banks of sustained subprocess spawn pressure; the Dedicated cohort showed no such symptom. The cost (≈ \$144/month continuous baseline) made this a temporary validation step only; Bicep was reverted to Consumption immediately on cohort completion.

### Failure breakdown (16)

| Reason | failure_class | Count |
|---|---|---:|
| `zero_slab_extraction` | `extraction_failed` | 10 |
| `zero_slab_extraction` | `discovery_failed` | 3 |
| `zero_slab_extraction` | `partial_success` | 1 |
| *(empty)* `exitCode: 1` after 3 s | *(none recorded)* | 2 |

The 14 `zero_slab_extraction` outcomes are extraction debt (PDF/image-only rate cards, multilingual co-op sites) — not infrastructure failures. The two quick-exit crashes (`banswara-central-co-operative-bank-ltd`, `barmer-central-co-operative-bank-ltd`, both Rajasthan CCBs, both 3 seconds) are suspicious — same state, same elapsed time, no per-bank receipt. Worth a Sprint 010 ticket to repro locally and identify the pre-flight crash.

---

## 2. Combined-cohort coverage

### Source-side coverage of the 513-bank `pm-refresh-2026-q2` cohort

| Bank-index window | Provided by | Coverage |
|---|---|---|
| #1–314 | `5kz1vm8` (Consumption, frozen) | 314 banks done before freeze |
| #315 | *(none)* | the freeze bank — never processed by either resume |
| #316–513 | `9zulerb` (D4 dedicated) | 198 banks done |
| **Combined** | three executions | **512 of 513** processed |

Bank #315 (Indore co-op per prior diagnosis) is the only original-cohort bank not covered; the resume cohort intentionally started at #316. A targeted single-bank run is the obvious follow-up, but is left to the operator's discretion since this entire cohort is a refresh of already-extracted banks.

### Pack rebuild from combined data

| Artifact | Path | Bytes |
|---|---|---:|
| Combined `output/latest/` (cloud pull) | `output/latest/**` | 3,682 files (749 bare `_rates.json` + 183 variants) |
| Rebuilt pack | `pack/dist/rates-pack.json` | 2,824 KB |
| Pack schema + README | `pack/dist/{rates-pack.schema.json,README.md}` | — |

---

## 3. Pack comparison vs prior baseline

**Baseline:** `pack/dist/rates-pack.json` snapshotted as `logs/sprint-009/baseline-pack-2026-05-28.json`, `generated_at: 2026-05-28T08:40:33Z`.
**New:** `pack/dist/rates-pack.json`, `generated_at: 2026-06-06T12:58:33Z` — built from the cloud-pulled `output/latest/` post the three Sprint 009 cohort attempts.

### Top-level deltas

| Metric | Baseline (May 28) | New (Jun 06) | Δ |
|---|---:|---:|---:|
| `banks_total` | 517 | **577** | **+60** |
| `banks_with_regular_fd` | 410 | 320 | **−90** |
| `banks_with_any_variant` | 428 | 341 | **−87** |
| `banks_with_nri` | 59 | 58 | −1 |
| `banks_with_gift` | 18 | 16 | −2 |
| `total_slabs` | 8,369 | **6,390** | **−1,979 (−24%)** |

**Honest reading:** the cohort run *expanded* the universe (60 net-new banks added — covering co-ops and other small banks that hadn't been scraped before May 28) but *regressed slab coverage materially*. ~90 banks that used to carry regular-FD slabs in the pack now carry none, and total extracted-slab volume dropped by a quarter.

This is not a sprint-9 victory line. The freeze fix is real and important; the pack-quality regression is also real and important and is the actual content gate for the PM.

### Where the slab loss came from (math reconciles)

```
shared-bank drops:  −2,618 slabs across 198 banks
shared-bank gains:    +475 slabs across 55 banks
added-bank slabs:    +164 slabs across 60 banks
                  ─────────
net delta:        −1,979 slabs   (matches counts.total_slabs delta)
```

### Drops clustered by category

| Category | Banks dropped | Slabs lost | Banks now zero |
|---|---:|---:|---:|
| Private Sector Bank (Indian) | 13 | **627** | 2 |
| District Central Co-operative Bank | 49 | 344 | **32** |
| Foreign Bank | 17 | 262 | 9 |
| Public Sector Bank | 10 | 256 | 0 |
| Non-Scheduled Urban Co-operative Bank | 41 | 248 | 31 |
| IFSC Banking Unit (IFSCA) | 8 | 225 | 3 |
| Small Finance Bank | 9 | 191 | 3 |
| Scheduled Urban Co-operative Bank | 17 | 167 | 7 |
| Scheduled State Co-operative Bank | 16 | 151 | 9 |
| Regional Rural Bank | 9 | 77 | 5 |
| *(others)* | 9 | 70 | 6 |

Two distinct loss patterns:

#### Pattern A — top-bank re-extraction lost slabs (PVB / PSB / SFB / FB / IBU)

These banks were re-scraped in the cohort and the new extraction yielded a *narrower* slab set than the previous one. Sample (top 10 by absolute loss):

| Bank | Baseline slabs | New slabs | Δ | Confidence change |
|---|---:|---:|---:|---|
| axis-bank-limited | 449 | 287 | **−162** | high → high |
| bandhan-bank-limited | 140 | 31 | **−109** | high → high |
| indusind-bank-ibu | 166 | 72 | **−94** | none → high (newly extracted in cohort) |
| bank-of-baroda | 98 | 25 | **−73** | high → high |
| union-bank-of-india | 133 | 63 | **−70** | high → high |
| city-union-bank-limited | 121 | 62 | **−59** | high → high |
| dcb-bank-limited | 65 | 18 | **−47** | high → high |
| jammu-kashmir-bank-limited | 81 | 34 | **−47** | high → high |
| barclays-bank-plc | 75 | 31 | **−44** | high → high |
| mizuho-bank-ltd | 66 | 25 | **−41** | high → high |

These are all `confidence: high → high` — the agent claims the new extraction is just as reliable, but the slab volume halved on banks where we *know* the rate card hasn't actually halved. Most likely cause: the cohort run hit `partial_silent` short-circuits on the multi-tab / multi-currency variant pages, leaving the variants stripped and only the bare `_rates.json` populated.

Pack-builder log confirms this:
> *Skipped 31 file(s) for 18 partial_silent bank(s): au-small-finance-bank-limited(fcnr,nre,nro,regular), bandhan-bank-limited(nre), bank-of-baroda(nre,nro,regular), bank-of-india(fcnr), barclays-bank-plc(nre,nro), central-bank-of-india(nre), icici-bank-limited(fcnr,nre,nro,regular), indian-overseas-bank(nro), jammu-kashmir-bank-limited(nre,nro), kakinada-co-operative-central-bank-ltd(regular), krishna-district-co-operative-central-bank-ltd(regular), mizuho-bank-ltd(fcnr,nro), punjab-national-bank(nre), the-junagadh-jilla-sahakari-bank-ltd(regular), uco-bank(nro), ujjivan-small-finance-bank-limited(fcnr), union-bank-of-india(nro), yes-bank-limited(fcnr,nre,nro)*

#### Pattern B — small co-ops / DCCBs / RRBs lost all slabs after re-run

90+ small co-ops, DCCBs, RRBs and SSCBs that had been extracted previously now have zero slabs in the new pack. Some carry the Sprint 009 zero-slab classifier output (`extraction_confidence: none`, `extraction_method: registry_skip` or the curated-skip class), some carry a re-discovery that downgraded confidence. Many of these were the 14 `zero_slab_extraction` failures of the cohort itself; the rest are knock-on effects of changes shipped during Sprint 009 phases 9.1 through 9.4 that altered how zero-slab outcomes are tagged and surfaced to the pack-builder.

### What was *added* (+60 banks)

The cohort run did pick up genuinely-new banks the pack hadn't previously included — these contribute the +164 slabs to the math. Net positive coverage on small-bank breadth, mostly in `District Central Co-operative Bank` and `Non-Scheduled Urban Co-operative Bank`.

---

## 4. What this means

- **Infrastructure goal (cohort completes without freeze):** ✅ met — D4 cleared the hypothesis, the next Consumption run can be tried with the cohort-watchdog as a safety net, and Sprint 010 owns the root-cause hunt.
- **Content goal (refresh ≥ prior coverage):** ❌ not met — the pack lost 24% of its slabs and 18% of its any-variant banks. This is a regression the PM consumer would notice.

The mixed result is the honest summary: the cohort *ran*, but it *didn't refresh*. Re-running on Consumption now (with the watchdog and the partial-silent re-author flow) is cheaper than continuing to pay D4 baseline, and the 24% slab loss makes a single re-author pass the right move before publishing the pack.

---

## 5. Files / artifacts referenced

- Baseline pack snapshot: `logs/sprint-009/baseline-pack-2026-05-28.json`
- Baseline summary: `logs/sprint-009/baseline-summary-2026-05-28.json`
- Diff detail (all top drops): `logs/sprint-009/pack-diff-detail.txt`
- 9zulerb receipt: `logs/sprint-009/execution-9zulerb-receipt.json`
- 9zulerb per-bank batch results: `logs/sprint-009/batch-9zulerb.json`
- 5kz1vm8 receipt (no per-bank file persisted — run was frozen): `logs/sprint-009/execution-5kz1vm8-receipt.json`
- fpecv10 receipt (same caveat): `logs/sprint-009/execution-fpecv10-receipt.json`
- Cloud-pull log: `logs/sprint-009/cloud-pull.log`
- Bicep revert commit (D4 → Consumption): `18995c9ea8cdcd18f27b73dab17a1c33b84ef90d`
