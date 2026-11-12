# Regression: jammu-kashmir-bank-limited (fcnr)

- **Baseline slabs (rates-pack-2026-05-14):** 30
- **Actual slabs (tmp/baseline-pre-reset):** 22
- **Delta:** -27%
- **Bank type:** PVB
- **Scraper type:** html_static
- **Extraction method:** undefined
- **Rate page URL:** https://jkb.bank.in/deposits/foreign-currency-non-resident-banks-fcnr-b

## Hypothesis

8-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 30 slabs** against the live page (captured into tests/golden-html/regression-cases/jammu-kashmir-bank-limited.html by Phase A's HTML harvester). If it still produces 22, the extractor has reproduced the bug.
