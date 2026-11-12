# Phase 0.4 — Golden harvest

**Date:** 2026-05-24
**Handoff:** `../plan/phase-0-data-mining-handoff.md`
**Script:** `scripts/analysis/harvest-goldens.js`
**Outputs:**
- `tests/golden-html/<bank>.expected.json` + `<bank>.expected.meta.json` × 50
- `tests/golden-html/regression-cases/<bank>__<variant>.{actual,baseline,diff}.{json,md}` × 35 × 3 = 105 files
- `tests/golden-html/INDEX.json`

## What landed

**Top-50 golden fixtures** (50 banks by slab count, excluding regression-list banks). The `expected.json` carries:
- `slab_count` and `key_rates` at 1y/2y/3y/5y reference tenures
- `effective_date` and `source_url`
- `captured_from` provenance pointer

The `expected.meta.json` carries bank metadata (type, state, website, scraper_type, extraction_method) so the test runner can group results by template family.

**Regression cases** — 35 entries spanning 33 unique banks (some banks have multiple variant regressions). For each:
- `.actual.json` — current (broken) extraction from baseline, with full slab data and the warnings array
- `.baseline.json` — the slab count from the pre-regression pack (full slab data not available — quality-gate doesn't snapshot it)
- `.diff.md` — human-readable summary with hypothesis and Phase C extractor target

## Top-50 composition

Dominated by **IBU + FB + PVB multi-variant banks** because the slab count includes all variants summed and these banks have NRE+NRO+FCNR+GIFT in addition to regular:

| Rank | Bank | Slabs | Type |
|---|---|---:|---|
| 1 | axis-bank-limited | 324 | PVB |
| 2 | rbl-bank-ibu | 60 | IBU |
| 3 | kotak-mahindra-bank-ibu | 55 | IBU |
| 4 | emirates-nbd-bank-pjsc | 53 | FB |
| 5 | idbi-bank-ibu | 48 | IBU |

Note that `kotak-mahindra-bank-limited` itself (a regression entry — its `regular` variant dropped from 18 → 0) is NOT in the top-50; only `kotak-mahindra-bank-ibu` is. The top-50 deliberately excludes regression-list banks because they would skew the "golden" assertion (we don't want to enshrine broken slab counts as expected behavior).

## What's intentionally deferred to Phase A

**HTML capture.** Running Playwright across 80+ live bank pages now would:
- Pull in playwright + the stealth plugin into the Phase 0 analysis pass (out of scope)
- Risk WAF challenges on the foreign-bank cohort that the current `scripts/fetch_rates_playwright.js` doesn't handle gracefully
- Produce capture quality that the hardened `lib/fetch/fetch_html.js` (Phase B) will exceed

Phase A will write a companion `scripts/analysis/harvest-golden-html.js` that uses the new fetch layer to capture HTML alongside the existing `expected.json` files. The test runner (`tests/extractors/golden.test.js` from Phase D3) will skip fixture pairs without a `.html` companion until backfill.

This is deliberate: it lets Phase 0 close on the deterministic JSON artifacts that downstream phases need for design, without coupling Phase 0's completion to a fetch-layer that doesn't exist yet.

## How the regression cases close the trust loop

The pattern is:
1. Phase 0.4 captures `actual.json` (what currently extracts) and `baseline.json` (slab count it should produce).
2. Phase A's `harvest-golden-html.js` adds the live HTML to `regression-cases/<bank>.html`.
3. Phase C's per-template extractor must, when run against that HTML, produce ≥ `baseline.json.slab_count` slabs.
4. The Phase D golden test asserts this. If the extractor still produces `actual.json.slab_count`, the test fails — the extractor has reproduced the bug instead of fixing it.

This means every one of the 33 regression-list banks becomes a captured test case that the new architecture must beat. The pack `BLOCK` verdict is converted into a regression-test suite that Phase E migrations are gated on.

## Open follow-ups

- **Phase A:** write `scripts/analysis/harvest-golden-html.js` to backfill the `.html` companions.
- **Phase D3:** design `tests/extractors/golden.test.js` to run a Phase C extractor against each fixture pair and assert slab counts + key rates within tolerance (±5bps).
- **Phase E gate:** every per-bank promotion in the migration cohort must pass its golden test (if one exists for the bank) before being promoted to deterministic extraction.

## Sanity check

```
top 50 (excluding regressions): 50 banks
regression cases:               35 entries
wrote tests/golden-html/:       100 files (50 expected.json + 50 meta.json)
wrote regression-cases/:        105 files (35 × {actual, baseline, diff})
wrote INDEX.json:               1 file
```

Total: 206 fixture files. No live network calls. Pure read of `tmp/baseline-pre-reset/`.
