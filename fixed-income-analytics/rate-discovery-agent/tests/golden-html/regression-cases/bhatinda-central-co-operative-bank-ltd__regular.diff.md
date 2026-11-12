# Regression: bhatinda-central-co-operative-bank-ltd (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 12
- **Actual slabs (tmp/baseline-pre-reset):** 1
- **Delta:** -92%
- **Bank type:** DCCB
- **Scraper type:** html_static
- **Extraction method:** automatic_html_static
- **Rate page URL:** https://bathindaccb.bank.in/deposit-interest-rates/

## Hypothesis

11-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 12 slabs** against the live page (captured into tests/golden-html/regression-cases/bhatinda-central-co-operative-bank-ltd.html by Phase A's HTML harvester). If it still produces 1, the extractor has reproduced the bug.
