# Regression: punjab-national-bank (fcnr)

- **Baseline slabs (rates-pack-2026-05-14):** 30
- **Actual slabs (tmp/baseline-pre-reset):** 21
- **Delta:** -30%
- **Bank type:** PSB
- **Scraper type:** html_static
- **Extraction method:** automatic_html_static
- **Rate page URL:** https://pnb.bank.in/Interest-Rates-Deposit.html

## Hypothesis

9-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 30 slabs** against the live page (captured into tests/golden-html/regression-cases/punjab-national-bank.html by Phase A's HTML harvester). If it still produces 21, the extractor has reproduced the bug.
