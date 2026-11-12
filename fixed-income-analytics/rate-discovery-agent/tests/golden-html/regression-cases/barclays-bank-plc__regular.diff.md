# Regression: barclays-bank-plc (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 26
- **Actual slabs (tmp/baseline-pre-reset):** 5
- **Delta:** -81%
- **Bank type:** FB
- **Scraper type:** html_static
- **Extraction method:** automatic_html_static
- **Rate page URL:** https://barclays.bank.in/home/schedule-of-charges-interest-rates/

## Hypothesis

21-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 26 slabs** against the live page (captured into tests/golden-html/regression-cases/barclays-bank-plc.html by Phase A's HTML harvester). If it still produces 5, the extractor has reproduced the bug.
