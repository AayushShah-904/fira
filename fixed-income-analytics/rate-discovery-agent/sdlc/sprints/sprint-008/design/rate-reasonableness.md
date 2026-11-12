# Design — Phase 7: multi-reference rate-reasonableness detector

**Sprint:** 008 · **Phase:** 7 · **Status:** design → implementation · **ADR:** ADR-017

## Problem

Bounds (`[0.1,15]`), structural checks (Phase 3), and vs-baseline counts all miss a single **plausible-but-wrong** rate: a 1-year FD at 2.0% is "in bounds" but absurd against a ~6.5% repo; a bank's 1y rate jumping 300bps from its own last value is almost always an extraction error. The Sprint-008 fixes showed the dangerous errors are exactly these (wrong-column/wrong-tier/averaging) — values that look fine in isolation.

This detector flags a rate that deviates implausibly from three **independent** reference anchors. Agreement is the signal: one anchor = WARN; ≥2 = blocking ANOMALY.

## Anchors (regular variant; canonical buckets 1y/2-3y/5y)

`BUCKETS = { '1y':[365,365], '2-3y':[730,1095], '5y':[1825,1825] }` — the universally-comparable rungs. FCNR/GIFT excluded (currency-denominated; not peer/repo-comparable in v1).

1. **Peer median** — `medianRateByCategoryTenure(banks)` → `{[bank_type]:{[bucket]:{n,median,p25,p75}}}` (extends `computePeerStats`). Fire when this bank's bucket rate is `> PEER_DEVIATION_BPS` (200) from its `(bank_type,bucket)` median with stratum `n≥8`, OR outside the IQR fence `[p25-1.5·IQR, p75+1.5·IQR]`.
2. **Repo band** — from approved `data/macro-rates.json`: per-`bank_type` band `[repo - low_spread, repo + high_spread]`. Fire when the bucket rate is outside. **Inactive (INFO note, skipped) when the file is missing or `approved_by` is null** — degrades to peer+historical.
3. **Historical** — last `HISTORY_DEPTH=3` packs in `pack/history/` (by filename date); for this bank+bucket gather prior `rate_general_pct`; fire when current deviates `> HISTORICAL_DEVIATION_BPS` (150) from the nearest prior. <1 prior → skip.

## Combination & severity
Per (bank, bucket): 0 anchors → clean; 1 → WARN `rate_deviation_<peer|repo|historical>`; ≥2 → one ANOMALY `rate_reasonableness_outlier` (blocking) carrying the failed anchors + values. Reuses the signed-accept escape hatch.

## Macro metadata — operator-approved (ADR-017)
`data/macro-rates.json`: `{ repo_rate, effective_date, source_url, approved_by, approved_at, spreads_by_bank_type: { PSB:{low,high}, SFB:{low,high}, ..., default:{low,high} } }`.
- The agent **never** sets `approved_by` (no-fake-approvals). A skeleton ships with `repo_rate:null, approved_by:null` → repo anchor inactive.
- `scripts/macro/propose-repo-rate.js --repo <r> --effective <d> --source <url>` writes `data/macro-rates.proposed.json` ONLY (the researched value comes from the RBI site / a tier-2 agent; the script records, never approves).
- `bin/approve-macro-rate.js` promotes `.proposed.json` → `macro-rates.json`, stamping `approved_by`/`approved_at` (operator-run; reads the operator identity). Until then the band is inactive.

## Files
- create `lib/checks/rate-reasonableness.js` (pure): `BUCKETS`, `bucketRate(slabs,bucket)` (reuses `rateAt` logic), `medianRateByCategoryTenure`, `peerDeviation`, `repoDeviation`, `historicalDeviation`, `rateReasonableness(ctx)→issue[]`.
- modify `lib/checks/structural-checks.js` — export `median`/`quantile`/`round2`/`issue`.
- create `data/macro-rates.json` (skeleton, unapproved), `scripts/macro/propose-repo-rate.js`, `bin/approve-macro-rate.js`.
- modify `scripts/quality-gate.js` — `runGate` loads last-3 history + macro; `pass3_anomalies({newPack,baselinePack,history,macro,categoryTenureMedians})`; new `THRESHOLDS` (PEER_DEVIATION_BPS, HISTORICAL_DEVIATION_BPS, HISTORY_DEPTH).
- create `tests/checks/rate-reasonableness.test.js`.

## Reuse
`computePeerStats`/`median`/`quantile`/`round2`/`issue` (`lib/checks/structural-checks.js`), `bankMapByCode`+`THRESHOLDS`+finding shape (`scripts/quality-gate.js`), `rateAt` logic (`scripts/snapshot/backfill-golden-from-snapshots.js:34`). Baseline/history shape verified identical (`pack/history/rates-pack-2026-05-14.json`).

## Test strategy
Pure-function fixtures per anchor + ≥2 escalation + inactive-macro path + IQR fence + negative control. Gate runs green with no approved macro (repo INFO-inactive). On the real pack, the `rate_reasonableness_outlier` list should be a reviewable size (tune `PEER_DEVIATION_BPS` if noisy) and re-surface the column-mismap class.

## Out of scope
FCNR/GIFT currency reasonableness; auto-updating repo; auto-archiving ship packs into `pack/history/` (follow-on so the 3-point history fills — today it degrades gracefully).
