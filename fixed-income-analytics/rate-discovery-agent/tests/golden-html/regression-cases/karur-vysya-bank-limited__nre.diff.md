# Regression: karur-vysya-bank-limited (nre)

- **Baseline slabs (rates-pack-2026-05-14):** 10
- **Actual slabs (tmp/baseline-pre-reset):** 7
- **Delta:** -30%
- **Bank type:** PVB
- **Scraper type:** html_static
- **Extraction method:** automatic_text_pattern
- **Rate page URL:** https://kvb.bank.in/nri/products/deposits/nre-deposits/

## Hypothesis

3-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 10 slabs** against the live page (captured into tests/golden-html/regression-cases/karur-vysya-bank-limited.html by Phase A's HTML harvester). If it still produces 7, the extractor has reproduced the bug.
