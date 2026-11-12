# Regression: united-overseas-bank-limited (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 10
- **Actual slabs (tmp/baseline-pre-reset):** 8
- **Delta:** -20%
- **Bank type:** FB
- **Scraper type:** pdf
- **Extraction method:** undefined
- **Rate page URL:** https://uob.bank.in/assets/web-resources/in/pdf/useful/interest-rates/interest-rate.pdf

## Hypothesis

2-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 10 slabs** against the live page (captured into tests/golden-html/regression-cases/united-overseas-bank-limited.html by Phase A's HTML harvester). If it still produces 8, the extractor has reproduced the bug.
