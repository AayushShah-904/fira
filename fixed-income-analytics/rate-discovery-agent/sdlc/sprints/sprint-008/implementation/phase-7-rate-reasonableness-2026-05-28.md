# Implementation — Phase 7: multi-reference rate-reasonableness detector (2026-05-28)

Design: `../design/rate-reasonableness.md`. ADR: ADR-017. Status: **complete; repo anchor inactive pending operator approval of the macro rate.**

## What shipped

- **`lib/checks/rate-reasonableness.js`** (new, pure) — `BUCKETS` (1y/2-3y/5y), `bucketRate` (retail/max-tier rate covering a bucket — avoids the bulk-tier trap from the cat-3 fix), `medianRateByCategoryTenure`, and the three anchors `peerDeviation` / `repoDeviation` / `historicalDeviation`, combined by `rateReasonableness` (0→[], 1→WARN, ≥2→one blocking ANOMALY `rate_reasonableness_outlier`). Reuses `median`/`quantile`/`round2`/`issue` (now exported from `structural-checks.js`).
- **`data/macro-rates.json`** — operator-approved macro skeleton (`repo_rate:null`, `approved_by:null` → repo anchor inactive) + `spreads_by_bank_type` bands.
- **`scripts/macro/propose-repo-rate.js`** — records a researched repo value into `data/macro-rates.proposed.json` only; never writes the approved file or sets `approved_by` (self-tested).
- **`bin/approve-macro-rate.js`** — operator-only promotion (requires `--yes` + the operator key present); the sole path that activates the repo anchor.
- **`scripts/quality-gate.js`** — `runGate` loads the last-`HISTORY_DEPTH=3` `pack/history/` snapshots + `data/macro-rates.json`; `pass3_anomalies({newPack,baselinePack,history,macro})` precomputes `medianRateByCategoryTenure`, and per bank (regular variant, each bucket) runs `rateReasonableness` against peer median + repo band + the bank's prior-pack rates. New `THRESHOLDS`: `PEER_DEVIATION_BPS=200`, `HISTORICAL_DEVIATION_BPS=150`, `HISTORY_DEPTH=3`. Emits a one-time `repo_anchor_inactive` INFO when the macro is unapproved.
- **`tests/checks/rate-reasonableness.test.js`** (9) + helper exports.

## Verified on the real pack

`pass3_anomalies` over `pack/dist/rates-pack.json` (history: 2 snapshots — 2026-04-16, 2026-05-14; macro unapproved):

| check | count | class |
|---|---:|---|
| `rate_reasonableness_outlier` | 1 | ANOMALY (blocking) |
| `rate_deviation_peer` | 42 | WARN |
| `rate_deviation_historical` | 6 | WARN |
| `repo_anchor_inactive` | 1 | INFO |

**The blocking ANOMALY is a genuine catch: `slice-small-finance-bank` 1y at 13.78%** — within the loose `[0.1,15]` bounds but absurd for an SFB 1y (failed peer + historical). Exactly the plausible-but-wrong class the prior checks missed. The 42 peer WARNs are a reviewable triage list (mostly foreign banks, whose FB category has wide rate variance — candidates for a per-bank-type tolerance tune).

## Tests / discipline
- `node --test tests/checks/rate-reasonableness.test.js` → 9/9; `tests/scripts/quality-gate.test.js` → 22/22.
- `check-write-discipline` clean (159). `npm test` → green (1 known playwright fail / 44 skip).
- `propose-repo-rate.js` self-test: writes only the proposal, leaves the approved file inactive.

## Operator action to activate the repo anchor
1. Research the current RBI repo rate (RBI site / tier-2). 2. `node scripts/macro/propose-repo-rate.js --repo <r> --effective <d> --source <url>`. 3. Review `data/macro-rates.proposed.json`. 4. `node bin/approve-macro-rate.js --yes`. Until then peer + historical anchors run; repo is INFO-inactive.

## Follow-ons
- Tune `PEER_DEVIATION_BPS` / per-bank_type tolerance for the high-variance FB category (42 WARNs).
- Review the slice-SFB 13.78% blocking finding (fix or sign-accept).
- Auto-archive ship packs into `pack/history/` so the historical anchor reaches the full 3-point depth.
- FCNR/GIFT currency-aware reasonableness (out of scope v1).
