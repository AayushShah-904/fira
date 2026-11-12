# Orch-2 PVB cohort — ICICI / SBI / Kotak

> 2026-05-22 follow-up after [`./engine-fixes-orch2.md`](./engine-fixes-orch2.md).
> Goal: apply the HTML `fulfills_product` mechanism to the other large PVBs to validate that it generalises.

## Headline finding

**HDFC's multi-variant-on-one-page layout is unusual.** ICICI, SBI, and Kotak publish each variant on a dedicated URL. The `fulfills_product` mechanism only applies cleanly to one of them (ICICI), and even there the gain is correctness/clarity, not slab count.

The remaining gaps (ICICI low domestic, SBI FCNR currency-schema, Kotak — already closed) are extraction-engine problems, not `fulfills_product` gaps.

## Per-bank summary

### ICICI Bank Limited

Registry already pointed `fd_nre` and `fd_nro` to the same `/nri-banking/deposits/fixed-deposit/fd-interest-rates` URL (a combined NRI page that publishes both variants). Authored:

```jsonc
"extraction": {
  "fd_nri_combined": {
    "type": "html",
    "fulfills_product": ["fd_nre", "fd_nro"]
  }
}
```

Effect:
- Slab counts unchanged: domestic 5, NRE 12, NRO 12, FCNR 10
- Registry now explicitly declares the multi-variant page (was implicit via duplicate URLs)
- Future re-extraction can use one extraction pass per page (deduplication is now hint-driven)

Open gaps not addressed by Orch-2:
- Domestic only 5 slabs (likely tab-based SPA where the multi-table accumulator captured only one tab's content). Out of scope for Orch-2; needs Playwright tab-click depth tuning OR explicit `tab_selector` hint.

### State Bank of India

Each variant has a dedicated URL. No `fulfills_product` opportunity. Fresh slab counts: domestic 8, NRE 7, NRO 13, **FCNR 6**.

FCNR regressed from a baseline of 36 (May 14 pack) to 6 slabs. Inspection shows the 6 slabs have no `currency` field — the extractor captured one currency's column instead of fanning out across USD/GBP/EUR/JPY/CAD/AUD.

This is the known **FCNR currency-keyed-columns schema gap** already in the backlog ([`items-to-verify.md`](./items-to-verify.md) → "FCNR currency-keyed schema"). Same gap affects Axis, HDFC, Kotak FCNR variants. Out of scope for Orch-2.

### Kotak Mahindra Bank Limited

Each variant has a dedicated URL. No `fulfills_product` opportunity.

Fresh run results vs the stale April 15 baseline that was on disk:

| Variant | Pre (April 15) | Post (May 22, Orch-1 era) | Δ |
|---|---:|---:|---|
| Domestic | 18 | **42** | +24 |
| NRE | 7 | **41** | +34 |
| NRO | 18 | **40** | +22 |
| FCNR | 17 | **28** | +11 |

**Total: 60 → 151 slabs (+91)** — entirely from Orch-1's multi-table accumulator (Kotak's pages have stacked tables for different deposit tiers; the single-winner picker was dropping most of them). Orch-2 wasn't needed.

The reason this didn't show up in the Orch-1 doc's pack metrics is that the Kotak file on disk was 5 weeks old (April 15) and the Orch-1 verification only re-ran HDFC + Axis. The Kotak gains were latent in the engine — this PVB-cohort re-run is when they actually landed.

## Pack-level

| Metric | Post-Orch-2 (HDFC only) | Post-Orch-2 (PVB cohort) | Δ |
|---|---:|---:|---|
| Banks | 471 | 471 | 0 |
| Total slabs | 7026 | **7117** | +91 |
| Regressions | 33 | 34 | +1 (SBI FCNR currency drop) |
| Anomalies | 88 | 115 | +27 (Kotak variants flagged as "too-large jump" vs May 14 baseline) |
| Warnings | 189 | 189 | 0 |
| Verdict | BLOCK | BLOCK | unchanged |

The +27 anomalies aren't engine regressions — they're the quality-gate flagging Kotak's legitimate +91-slab gain as a "too large change" vs the stale baseline. The right resolution is to refresh the baseline once we're confident in current outputs (separate decision).

## What's open

1. **ICICI domestic extraction** — only 5 slabs from a JS-rendered SPA. Needs investigation: tab-click depth, or `tab_selector` hint. Not Orch-2.
2. **SBI FCNR currency-schema** — backlog item, blocks any FCNR-bearing bank from full coverage.
3. **Baseline refresh** — May 14 baseline now diverges enough from current engine output that the quality-gate's "anomaly" findings are mostly noise. Refresh decision pending operator.

## Decisions captured

- The Orch-2 `fulfills_product` mechanism stays scoped to genuine multi-variant pages (currently: HDFC, ICICI). Authoring hints for banks with dedicated per-variant URLs is unnecessary — the existing `rate_pages` map already does the right thing.
- The PVB-cohort exercise validated the mechanism (no regressions, ICICI applied cleanly) and surfaced the real next bottlenecks: extraction-engine improvements (tab depth, currency-keyed schema) rather than more `fulfills_product` hints.
