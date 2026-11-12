# Regression: g-p-parsik-janata-sahakari-bank-ltd-thane (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 17
- **Actual slabs (tmp/baseline-pre-reset):** 10
- **Delta:** -41%
- **Bank type:** SUCB
- **Scraper type:** html_static
- **Extraction method:** automatic_html_static
- **Rate page URL:** https://gpparsik.bank.in/interest-rates.html

## Hypothesis

7-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 17 slabs** against the live page (captured into tests/golden-html/regression-cases/g-p-parsik-janata-sahakari-bank-ltd-thane.html by Phase A's HTML harvester). If it still produces 10, the extractor has reproduced the bug.
