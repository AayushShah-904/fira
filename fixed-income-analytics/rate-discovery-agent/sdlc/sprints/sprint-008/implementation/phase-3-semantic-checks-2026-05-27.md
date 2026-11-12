# Implementation — Phase 3: deterministic semantic checks (2026-05-27)

Design: `../design/semantic-checks.md`. Status: **complete**.

## What shipped

- **`lib/checks/structural-checks.js`** (new) — pure functions, no I/O:
  - `classifyTableType(slabs, {headerTokens, variant})` → `wrong_table_suspected` (ANOMALY). Header-authoritative when present (loan/MCLR/savings tokens without FD tokens); intrinsic fallback flags a ladder with neither a ≤90d nor a ≥365d band (guarded so unparsed-tenure co-ops don't false-fire). `headerTokens` is wired but unpopulated until Phase 1 snapshots exist.
  - `seniorPremiumPeerOutlier(slabs, {peerStats, variant})` → `senior_premium_peer_outlier` (WARN). Flags ~0/negative median senior premium where the bank_type's peers cluster at ≥+25bps — the column-swap fingerprint that hides under the gate's absolute 30bps rule. `regular` only.
  - `ladderPlausibility(slabs, {bankType, variant})` → `truncated_ladder` (ANOMALY). Below the per-`bank_type` floor (`LADDER_FLOORS`) AND missing the ≥365d band.
  - `fcnrCurrencySanity(slabs, {variant})` → `fcnr_currency_anomaly` (WARN). Unknown currency; conflicting rate for the same currency+tenure+amount-tier; single-currency sub-year ladder (FCNR only — GIFT legitimately goes sub-year).
  - `computePeerStats(banks)` and `runStructuralChecks(slabs, opts)` helpers.
- **`scripts/quality-gate.js`** — `pass3_anomalies` computes `peerStatsByType` once, then runs `runStructuralChecks` per variant and adapts each Issue into the existing `{kind:'anomaly', class, bank_code, variant, check, value, detail}` finding shape. Reuses the signed-accept flow verbatim.
- **`scripts/analysis/rate-sanity-audit.js`** — runs checks #1/#3/#4 per variant (the peer check is gate-only; needs the full-pack distribution), with a cached `bankTypeOf(slug)` reading `output/latest/<slug>_config.json`.
- **`tests/checks/structural-checks.test.js`** (new) — 22 tests: one positive + negative control per check, plus FCNR dedup-key regressions (amount-tier, null-days tenure_text, GIFT scoping).

## Calibration (the work behind the numbers)

First pass over `output/latest` flagged **276 FCNR anomalies** — almost all false positives. Two root causes fixed:
1. The dedup key ignored `deposit_range`, so legitimate amount tiers (same currency+tenure, different rate) collided → added `deposit_range` to the key. 276 → 121.
2. FCNR cards leave `tenure_min/max_days` null (tenure only in `tenure_text`), so every currency's rows collapsed to one key → fall back to normalized `tenure_text` when days are null. 121 → 37.
3. Scoped the single-currency sub-year heuristic to `fcnr` (GIFT/IBU deposits have no 1-year floor). Cleared GIFT false-fires.

The remaining **37 FCNR / 3 banks are genuine** (idfc-first ships USD "1 Yr < 15 Months" at both 4.5 and 4.0; rbl-ibu has colliding sub-tenor rates).

## Verified on the real (shipped) pack

`pass3_anomalies` over `pack/dist/rates-pack.json`:

| New check | count | class |
|---|---:|---|
| `truncated_ladder` | 13 | ANOMALY (blocking) |
| `senior_premium_peer_outlier` | 46 | WARN |
| `fcnr_currency_anomaly` | 37 | WARN |
| `wrong_table_suspected` | 0 | (intrinsic-only pre-snapshot; activates with Phase 1 headers) |

The 13 truncated-ladder ANOMALIES are real under-extractions (1-slab co-ops, 2-slab payments banks — the bhatinda class). The peer-outlier WARN list includes `city-union-bank-limited`, independently flagged in prior notes for a col-map spread. These are bug classes the gate was previously blind to.

**Consequence:** the next gate run will BLOCK on the 13 truncated-ladder ANOMALIES until the operator fixes or signs them — intended behavior.

## Tests

- `node --test tests/checks/structural-checks.test.js` → 22/22 pass.
- Full suite `node --test --test-force-exit` → **1143 pass / 1 fail / 49 skip**. The single fail is the pre-existing Playwright `challenge on default → stealth` test (memory's "1 known-fail"); no new failures, +22 tests vs the prior 1117/1.

## Incidental unblock (out of Phase-3 substance)

`npm test`'s `pretest` (`check-write-discipline.js`) was failing on **two pre-existing committed violations** in files unrelated to this phase — `scripts/bulk-author.js:981` (run-report write) and `scripts/analysis/build-gap-cohort.js:67` (tmp cohort write). Both are aggregator/report outputs the discipline check explicitly allows to exempt; added `// safe-write-exempt:` comments. `check-write-discipline.js` now clean (149 files). Noted here because it touches files outside the phase.

## Deferred / follow-on

- `wrong_table_suspected` header path activates once Phase 1 snapshots feed `headerTokens`.
- Tuning `senior_premium_peer_outlier` toward ANOMALY once the Phase 2 audit confirms its precision.
- Operator review of the 13 truncated-ladder banks (fix vs accept) before the next ship.
