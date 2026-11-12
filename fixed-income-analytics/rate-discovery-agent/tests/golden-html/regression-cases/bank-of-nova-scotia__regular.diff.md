# Regression: bank-of-nova-scotia (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 7
- **Actual slabs (tmp/baseline-pre-reset):** 1
- **Delta:** -86%
- **Bank type:** FB
- **Scraper type:** pdf
- **Extraction method:** automatic_pdf
- **Rate page URL:** https://scotiabank.com/content/dam/global/india/Interest-Rate-Schedule-of-Charges-Dec-2025.pdf

## Hypothesis

6-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 7 slabs** against the live page (captured into tests/golden-html/regression-cases/bank-of-nova-scotia.html by Phase A's HTML harvester). If it still produces 1, the extractor has reproduced the bug.
