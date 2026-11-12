# Track A smoke-loop discipline (2026-05-18)

Operator constraint repeated 2026-05-18 — also captured in Sprint 3 L16 (`../../sprint-003/retrospection/retro.md`). The 12-bank cohort introduces 7 new banks beyond the 5 we have a Sprint 3 baseline for. Each new bank is likely to surface a new failure / anomaly class. When fixing those, **two hard rules**:

1. **Solutions must be generic.** No per-bank selectors. No bank-specific carve-outs in `bank-domains.json` beyond what's already there for cached rate-page URLs. Every fix has to answer: "does this help only this one bank, or every bank that uses this phrasing / layout / WAF behavior?" If the answer is "only this one bank", capture as a deferred follow-up; do not ship.

2. **No regression in the 5 existing-baseline banks.** SBI / HDFC / AU SFB / BOI-IBU / Abhyudaya have known per-variant slab counts from the post-A1+A2+A3 smoke (`output/runs/smoke-a123/`). Every Track A change must re-verify this baseline before merging. If a change drops any of them below baseline, either fix the regression or revert the change.

## Per-anomaly decision flow

For each new failure surfaced in the 12-bank smoke:

```
  Surfaced in N banks?
    1 bank only           → capture + defer; document repro command
    2+ banks same pattern → candidate for in-sprint generic fix

  If generic-fix candidate:
    Does the candidate fix touch shared code (parseTenure, normaliseDepositRange,
    _cheerio_tables.js, extract_html_table.js)?
      Yes → re-run the 5-bank Sprint-3-baseline smoke after the fix
            and confirm baseline holds
      No  → smaller-blast-radius change; still re-run the affected variant
            for the 5 baseline banks

  If 5-bank baseline regresses:
    Can we narrow the change to avoid the regression?
      Yes → narrow, re-run, accept
      No  → revert; capture as deferred (Sprint 5+)
```

## Baseline reference (post-A1+A2+A3, smoke-a123)

| Bank | Variant slabs (regular / nre / nro / fcnr / gift) |
|---|---|
| state-bank-of-india | 10 / 5 / 10 / 36 / — |
| hdfc-bank-limited | 19 / — / — / — / — |
| au-small-finance-bank-limited | 23 / — / — / — / — (variant variance is known transient) |
| abhyudaya-co-operative-bank-ltd-mumbai | 8 / — / — / — / — |
| bank-of-india-ibu | — / — / — / — / 64 |

Total: 175 trustworthy slabs. Any Track A change should preserve these counts (allowing for the known AU SFB variant-emission variance).

## What "generic" looks like — examples from Sprint 3

- **HDFC's 71 → 2 collapse** was diagnosed as a generic `parseTenure` gap (5 phrasings missing) + a generic `dedupSlabs` bug (text-fallback discriminator missing). Both fixes shipped without HDFC-specific config; benefit every bank using those phrasings.
- **BOI-IBU's 112 → 64** was a generic `normaliseDepositRange` to canonicalise `deposit_range` labels emitted by the per-chunk LLM. Helps any multi-tier bank.
- **SBI NRE/NRO non-FD rows** were a generic `non_fd_filter` extension covering `"Up to Rs"`, `"Above Rs"`, `"Premature withdrawal"` etc. Helps any PSB/PVB with similar footnote noise.

A4 itself follows the same shape: tier-header propagation is generic across stacked-tier bank pages (AU SFB, large PSB bulk-tier pages, IBU multi-tier currency tables). The feature flag (`RDA_TIER_AWARE_DEDUP=1`) is the no-regression guarantee through the 12-bank rung.

## What "non-generic" looks like — examples to avoid

- Adding `data/bank-domains.json` overrides like `"hdfc-bank-limited": { "selectors": { "table": ".hdfc-rates-table" } }` to fix HDFC-only.
- Hardcoded bank-code branches in `lib/actions/extract_html_table.js` (e.g., `if (bankContext.bank_code === 'sbi') { ... }`).
- Per-bank `expected_slab_count` values used as hard gates rather than soft hints.

## Action plan for the 12-bank smoke

Rung 2 (local) flow:

1. Run the 12-bank cohort with `RDA_TIER_AWARE_DEDUP` unset. Compare the 5 baseline banks against `output/runs/smoke-a123/`. Each must hold.
2. For each of the 7 new banks, record: total slabs, errors, warnings, any tier-stacked layout indicators.
3. Run again with `RDA_TIER_AWARE_DEDUP=1`. Re-compare the 5 baseline banks: still must hold.
4. Diff the new-7 results between flag-off and flag-on to confirm A4 either helps or is neutral.
5. For each anomaly surfaced, apply the decision flow above. Generic-fix candidates go into `slab-quality-anomalies-2026-05-XX.md` and ship in-sprint; per-bank carve-outs go into a deferred-to-Sprint-5 capture.

Rung 3 (cloud) flow:

6. Only after rung 2 is clean, run the same cohort via `node scripts/azops/start-cohort.js --cohort top-12 --env prod`. Per-bank blob upload (Track B / B2) verified during the run via `az storage blob list`.
7. Compare cloud rung-3 results against local rung-2: any drift indicates an environmental issue (auth, WAF, cloud-only path); treat as a Track B follow-up, not a Track A regression.

## What to write in the rung reports

For each rung's `implementation/cohort-smoke-12-{local,cloud}-2026-05-XX.md`:

- Per-bank table: variant slabs, errors, warnings, fragment uploaded (cloud only).
- Comparison to prior rung (rung 2 to baseline; rung 3 to rung 2).
- Anomaly catalog: each surfaced issue gets one row with: count of affected banks, candidate fix (or "defer"), reproduction command.
- Net verdict: rung passes / fails / passes-with-caveats.

The catalog feeds Sprint-4 sub-commits; the verdict feeds the rung-4 (50-bank) Go/No-Go decision.
