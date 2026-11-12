# Regression: bandhan-bank-limited (fcnr)

- **Baseline slabs (rates-pack-2026-05-14):** 24
- **Actual slabs (tmp/baseline-pre-reset):** 19
- **Delta:** -21%
- **Bank type:** PVB
- **Scraper type:** html_static
- **Extraction method:** automatic_html_static
- **Rate page URL:** https://bandhan.bank.in/rates-charges

## Hypothesis

5-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 24 slabs** against the live page (captured into tests/golden-html/regression-cases/bandhan-bank-limited.html by Phase A's HTML harvester). If it still produces 19, the extractor has reproduced the bug.
