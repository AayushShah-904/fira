# Design — Phase 3: deterministic semantic checks

**Sprint:** 008 · **Phase:** 3 (ship first; independent of the snapshot substrate)
**Status:** design → implementation
**Solves:** the Sprint-007 bug classes that pass bounds + vs-baseline gates because their numbers are *plausible*.

## Problem recap

The gate and the sanity audit catch absurd numbers (out-of-band), inverted tenure, and big slab-count regressions vs a baseline. They do **not** catch:

| Bug class (Sprint-007 incident) | Why it slips through today |
|---|---|
| Loan/savings table read as FD (kerala-state, bank-of-ceylon) | Loan rates land inside the [0.1,15] FD band |
| senior/general column swap under 30bps (17 "senior-gap" banks) | `senior_below_general` only BLOCKs when gap > `SENIOR_FLOOR_GAP_BPS=30`; a swap where senior≈general or only slightly off is invisible |
| Truncated ladder (bhatinda 11→1) | Only caught as a vs-baseline regression; a fresh bank with a short ladder and no baseline is invisible |
| Collapsed/mislabeled FCNR currencies (pnb, hsbc, bandhan) | Only `missing_currency` is checked; one currency stamped on a whole INR ladder passes |

## Approach

One pure-function module, **`lib/checks/structural-checks.js`** (no I/O, CJS, fully unit-testable), consumed by BOTH existing surfaces so logic never forks:

- `scripts/analysis/rate-sanity-audit.js` — per-bank loop over `output/latest` (pre-pack triage).
- `scripts/quality-gate.js#pass3_anomalies` — per-variant loop over the built pack (ship gate).

Each function takes a variant's full slab array (+ light context) and returns `Issue[]` where `Issue = { check, severity, detail, value? }`. `severity ∈ {ANOMALY, WARN, INFO}` maps directly onto the gate's existing `class`. The two call sites adapt the `Issue` into their own finding shape:

- gate finding: `{ kind:'anomaly', class: severity, bank_code, variant, check, value, detail }` (verbatim existing shape).
- audit issue: `{ k: check, t: <variant>, ...value }` (verbatim existing shape).

### Functions

**1. `classifyTableType(slabs, { headerTokens, variant })` → Issue|null** (`check:'wrong_table_suspected'`, ANOMALY)
- Signal A — tenure-pattern signature: a real FD ladder spans short→long (≥1 slab ≤ 90d AND ≥1 slab ≥ 365d) and is broadly monotone in tenure. A loan/MCLR/savings table lacks the short end or has a flat/degenerate tenure structure.
- Signal B — header tokens (when a snapshot/header is available): presence of `loan|advance|mclr|base rate|lending|overdraft|savings account` with absence of `fixed deposit|term deposit|fd |recurring`. Header tokens are optional; when absent, fall back to Signal A only.
- Fire only when BOTH available signals agree (avoid false positives on odd-but-valid FD tables). For regular/nre/nro/fcnr/gift alike.

**2. `seniorPremiumPeerOutlier(slabs, { peerStats, variant })` → Issue|null** (`check:'senior_premium_peer_outlier'`, WARN)
- Only for variants that *should* carry a senior premium: `regular` (nre/nro/fcnr/gift carry no senior premium → skip).
- Compute this bank's median `senior − general` premium over slabs where both are numbers.
- `peerStats` = per-`bank_type` distribution of that median premium across the pack: `{ p25, median, p75, n }`.
- Flag when peers clearly expect a premium (`peerStats.median ≥ 0.25` and `peerStats.n ≥ 8`) but this bank's premium is `≤ 0` (near-zero/negative) — the column-swap fingerprint that hides under the 30bps absolute rule. WARN-only until tuned (could be a genuine no-premium bank).

**3. `ladderPlausibility(slabs, { bankType, variant })` → Issue|null** (`check:'truncated_ladder'`, ANOMALY)
- Expected minimum band count per `bankType`/variant from a small table (PSB/PVB ≥ 6, SFB ≥ 5, co-op ≥ 4, foreign/IBU lower). A variant with `slabs.length` below the floor AND missing the long end (no slab ≥ 365d) is a likely truncation.
- Also flag a large interior tenure gap: e.g. a slab ending ≤ 400d followed by the next starting ≥ 1095d with nothing between, when the bank has < 3 slabs total (the bhatinda fingerprint). Conservative to avoid penalizing banks that genuinely publish few buckets.

**4. `fcnrCurrencySanity(slabs)` → Issue[]** (`check:'fcnr_currency_anomaly'`, WARN)
- Only for `fcnr`/`gift`. Beyond the gate's existing `missing_currency`:
  - currency ∉ known FCNR set (`USD,GBP,EUR,JPY,CAD,AUD,SGD,CHF,HKD,NZD,SEK,AED,DKK`) → flag.
  - same `(currency, tenure_min, tenure_max)` appearing twice with **different** rates → flag (collapsed/duplicated currency sections).
  - a single currency stamped across an implausibly long domestic-looking ladder (≥ 10 slabs, all same currency, with sub-365d tenures) → flag the pnb/hsbc "INR table stamped USD" fingerprint.

### Peer-stats computation (gate side)

`quality-gate.js` computes `peerStatsByType` once before `pass3_anomalies`: iterate all banks, bucket each bank's regular-variant median senior premium by `bank.bank_type`, then reduce to `{p25, median, p75, n}` per type. Passed into the per-variant evaluation. The audit side has no full-pack peer view, so it skips check #2 (or computes a coarse global premium) — check #2 is gate-only by design; #1/#3/#4 run on both.

### Severity & gate integration

| check | class | rationale |
|---|---|---|
| `wrong_table_suspected` | ANOMALY (BLOCK) | shipping loan rates as FD is the worst failure |
| `truncated_ladder` | ANOMALY (BLOCK) | lost data; high-value catch |
| `senior_premium_peer_outlier` | WARN | heuristic; tune before blocking |
| `fcnr_currency_anomaly` | WARN | heuristic; some are legit |

All four reuse the existing signed-accept escape hatch (`findingMatchesAccept`/`applyAccepts` + `bin/approve-accept.js`) — no new gate plumbing. WARN-class findings are visible in the report but never BLOCK, matching the existing `_minor` pattern.

## Files

- **create** `lib/checks/structural-checks.js` — the four functions + `KNOWN_FCNR_CURRENCIES`, `LADDER_FLOORS`, `computePeerStats(banks)` helper.
- **modify** `scripts/quality-gate.js` — compute `peerStatsByType`; in `pass3_anomalies` per-variant, call the four functions and push adapted findings; add the four `check` names to any report grouping.
- **modify** `scripts/analysis/rate-sanity-audit.js` — call #1/#3/#4 per variant, push adapted issues into the existing `issues[]`.
- **create** `tests/checks/structural-checks.test.js` — crafted fixtures: a loan table, a senior-swap bank vs peer stats, a truncated ladder, an INR-stamped-USD FCNR; plus negative controls (valid FD ladder, genuine no-premium bank, legit multi-currency FCNR) to assert no false positives.

## Test strategy

`node --test tests/checks/structural-checks.test.js` (joins `npm test`). Plus a guard test that runs `rate-sanity-audit.js` issue-kind counts on current `output/latest` and snapshots them, so a future logic change that suddenly flags hundreds of banks is caught. After wiring, `npm run build-pack && npm run quality-gate` must still classify the current pack without new *unaccepted* BLOCKs beyond the genuinely-suspicious banks (operator reviews those).

## Out of scope

- Auto-correcting flagged banks (Sprint 008 measures + flags; correction is follow-on).
- Header-token classification when no snapshot exists (degrades to tenure-pattern only until Phase 1 lands; the `headerTokens` arg is wired now, populated later).
