# Pack quality gate — design

## Context

Sprint 004's PM-refresh-2026-Q2 collection produced ~507 bank attempts, ~311 effective successes, and a long tail of partial / drift / extraction-quality issues. Before this pack ships to PM, we need a systematic check that the new pack is *not worse* than the last delivery — and that anomalies (extraction errors, schema violations, suspicious values) are flagged for operator review *before* publish.

What exists today:
- `scripts/compare-pack.js` does a useful but limited diff (banks added/dropped, top 20 slab gainers/losers, simple markdown output). It does not detect regressions per-variant, intra-pack anomalies, or gate the publish.
- `lib/tier-router.js#checkQuality` does per-bank drift at *extraction* time vs. operator floors. It does not look at the assembled pack.
- `pack/build-pack.js` produces the pack from `output/latest/` but has no validation step.
- `pack/publish.js` uploads to Azure Blob unconditionally if invoked.
- `pack/history/` (new this session) is the version ledger — we now have `rates-pack-2026-04-16.json` and `rates-pack-2026-05-14.json` tracked.

Intended outcome: a single `scripts/quality-gate.js` script that compares a new pack against a baseline (the most recent `pack/history/*.json`), classifies every observation into REGRESSION / ANOMALY / GAIN / STABLE, emits a Markdown + JSON report, and exits non-zero on REGRESSIONs unless they've been explicitly accepted by the operator. The build → quality-gate → publish flow gets documented here and the existing operator runbook updated.

## Decisions locked in (operator-confirmed)

1. **Gate strictness**: BLOCK on unaccepted regressions or anomalies (exit code 1). Operator must remedy or add to `quality-gate-accepts.json` with a reason.
2. **Design-doc location**: this file (`sdlc/sprints/sprint-004/design/pack-quality-gate.md`).
3. **When gate runs**: build-time only. After `pack/build-pack.js`, before `pack/publish.js`. No pre-commit hook on `pack/history/` additions.

## Files modified or added

| File | New / Modified | Purpose |
|---|---|---|
| `scripts/quality-gate.js` | NEW | CLI: load new + baseline pack, classify every observation, emit report, set exit code |
| `pack/quality-gate-accepts.json` | NEW | Persistent allowlist of operator-approved regressions / anomalies, keyed by since-pack-version |
| `pack/build-pack.js` | unchanged | Still produces `pack/dist/rates-pack.json` exactly as today |
| `scripts/compare-pack.js` | unchanged | Reused via its exported `totalsByBank()` helper |
| `pack/publish.js` | unchanged (operator-gated) | Operator chooses when to run; quality-gate is the gate, not auto-block |
| `tests/scripts/quality-gate.test.js` | NEW | Synthetic packs covering the classification matrix |
| `sdlc/sprints/sprint-004/implementation/pm-refresh-2026-q2-op-guide.md` | MODIFIED | New "Step 5.5 — Run quality gate" section between build and publish |
| `package.json` | MODIFIED | New `quality-gate` npm script |

## Detection algorithm

The gate runs in three passes over the new pack + baseline pack.

### Pass 1 — Bank-set diff (between packs)

- `added` = new banks not in baseline → emit as GAIN (with their slab profile)
- `dropped` = baseline banks not in new → emit as REGRESSION (unless a marker file `output/latest/<slug>.partial_silent.json` is present from the new build — that's a controlled exclusion produced by `pack/build-pack.js#findPartialSilent`, emit as INFO)

### Pass 2 — Per-bank variant comparison (banks present in both)

For each `bank_code` × `variant ∈ {regular, nre, nro, fcnr, gift}`:

```
actual   = new_pack slab count for this bank+variant   (0 if variant absent)
baseline = baseline_pack slab count for this bank+variant
delta    = (actual - baseline) / max(baseline, 1)
```

Classification (thresholds in a constants block, all configurable via CLI flags):

| Condition | Class | Default action |
|---|---|---|
| variant present in baseline, absent in new | REGRESSION | block (variant lost) |
| `delta ≤ -0.2` (>20% slab drop) | REGRESSION | block |
| `-0.2 < delta < -0.05` | WARN | log, don't block |
| `-0.05 ≤ delta ≤ 0.05` | STABLE | log at debug only |
| `0.05 < delta < 2.0` (between +5% and +200%) | GAIN | log |
| `delta ≥ 5.0` (>500% growth) | ANOMALY_GAIN | block (suspect parse error inflating slabs) |
| variant absent in baseline, present in new | NEW_VARIANT | GAIN, log |

Re-use: borrow the threshold ratio convention from `lib/tier-router.js#mergeExpected` (it uses 0.8 = 1−0.2 the same direction).

### Pass 3 — Intra-pack anomaly scan (new pack only)

Schema-level checks across `pack.banks[].products.fd[variant].slabs[]`:

| Check | Class | Notes |
|---|---|---|
| `rate_general_pct` outside `[0.1, 15.0]` | ANOMALY | India FD rates outside this band are almost certainly extraction errors |
| `rate_senior_pct < rate_general_pct` (where both non-null) | ANOMALY | Senior rates are universally ≥ general in India; reverse = parse swap |
| `rate_super_senior_pct < rate_senior_pct` (where both non-null) | ANOMALY | Same logic for super-senior |
| `tenure_min_days ≥ tenure_max_days` (both non-null) | ANOMALY | Inverted range |
| `tenure_min_days < 1` or `tenure_max_days > 3700` | ANOMALY | Outside any real FD tenure range (1 day to ~10 years) |
| `fcnr` or `gift` slab missing `currency` field | ANOMALY | Schema violation — these variants must specify currency |
| `bank_code` appears multiple times in `banks[]` | ANOMALY | Duplicate bank entry (build bug) |
| `effective_date` older than 6 months from `pack.generated_at` | WARN | Stale rates — bank may have updated since extraction |
| `extraction_confidence ∈ {none, low}` | INFO | Already-known concern; surface for visibility |

## Report output

Two artifacts written to `pack/dist/`:

1. **`quality-report.md`** — operator-readable, structured as:
   ```
   # Pack quality gate — <new pack date> vs <baseline pack date>

   ## Verdict: BLOCK | PASS_WITH_WARNINGS | PASS

   ## Summary counts
   - REGRESSIONS: N (block) | accepted: M
   - ANOMALIES:   N (block) | accepted: M
   - WARNINGS:    N
   - GAINS:       N
   - STABLE:      N

   ## Regressions
   <table: bank_code | variant | baseline | new | delta | accepted? | reason>

   ## Anomalies
   <table: location | check | value | accepted? | reason>

   ## Gains (top 30)
   ## Net deltas (banks_total, total_slabs, with_nri, with_gift, per-category)
   ```

2. **`quality-report.json`** — machine-readable. Same content, used for CI and operator scripting.

## Acceptance workflow

`pack/quality-gate-accepts.json` shape:

```json
{
  "since_pack": "2026-05-14",
  "accepted_regressions": [
    {
      "bank_code": "kotak-mahindra-bank-limited",
      "variant": "fcnr",
      "reason": "Kotak legitimately reduced FCNR tenures from 30 → 17 per RBI directive 2026-Q2",
      "approved_by": "samirajoshi",
      "approved_at": "2026-05-21",
      "until_pack": null
    }
  ],
  "accepted_anomalies": []
}
```

CLI behavior:

```
node scripts/quality-gate.js <new-pack> <baseline-pack> [--accepts <file>]

Exit codes:
  0  PASS (no unaccepted regressions or block-class anomalies)
  1  BLOCK (one or more unaccepted regressions or anomalies)
  2  ERROR (input file missing / unreadable)
```

Default `--accepts` path is `pack/quality-gate-accepts.json` if not specified.

## Reusing existing code

- `scripts/compare-pack.js#totalsByBank(pack)` — extracts per-bank per-variant counts; quality-gate imports it directly rather than duplicating
- `lib/orchestrator.js#expectedVariantsForBank(bankType, bankCode)` — knows which variants a bank type is expected to have; used to scope variant-disappearance checks (don't flag a co-op for losing nro because co-ops don't produce nro)
- `pack/dist/rates-pack.schema.json` — quality-gate validates new pack against this schema as a sanity step (JSON Schema draft 2020-12)

## Phases / implementation rungs

| Phase | Deliverable |
|---|---|
| M1 | Core compare engine (Passes 1 + 2) + Markdown report, no anomaly scan yet, no accepts file |
| M2 | Add intra-pack anomaly scan (Pass 3), JSON report alongside Markdown |
| M3 | Acceptance allowlist (`quality-gate-accepts.json`) + CLI flag + exit codes |
| M4 | SDLC integration: this design doc committed, op-guide updated, npm script added |
| M5 | (Future, sprint-005) CI integration: publish.js short-circuits if quality-gate exit ≠ 0 |

M1–M4 are the immediate sprint-004 work. M5 is sprint-005 fodder.

## Verification

Once implemented, validate end-to-end on real packs:

1. **Smoke** — run gate on `pack/history/rates-pack-2026-04-16.json` (new) vs `pack/history/rates-pack-2026-04-16.json` (baseline = same). Expect verdict `PASS`, all stable, zero regressions.

2. **Known-good diff** — run gate on `pack/history/rates-pack-2026-05-14.json` (new) vs `pack/history/rates-pack-2026-04-16.json` (baseline). Expect verdict `PASS` with ~31 GAINs (the new DCCBs onboarded), zero regressions.

3. **Real check** — after `node pack/build-pack.js` produces the new PM-refresh-2026-Q2 pack, run gate vs `pack/history/rates-pack-2026-05-14.json`. Read the report; investigate any REGRESSIONS / ANOMALIES; either remedy or add to `quality-gate-accepts.json` with reasons.

4. **Test suite**: `node --test tests/scripts/quality-gate.test.js` covers:
   - synthetic identical packs → PASS, 0 of everything
   - synthetic with dropped bank → REGRESSION
   - synthetic with -25% slab on one variant → REGRESSION
   - synthetic with rate_general_pct = 60 → ANOMALY
   - synthetic with senior < general → ANOMALY
   - accept file masks a regression → PASS

5. **Full suite stays green**: `node --test --test-force-exit` continues to pass (current state: 610 pass / 1 pre-existing skip).
