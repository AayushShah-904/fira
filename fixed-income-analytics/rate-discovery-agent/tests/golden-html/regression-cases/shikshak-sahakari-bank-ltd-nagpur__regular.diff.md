# Regression: shikshak-sahakari-bank-ltd-nagpur (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 16
- **Actual slabs (tmp/baseline-pre-reset):** 8
- **Delta:** -50%
- **Bank type:** SUCB
- **Scraper type:** html_static
- **Extraction method:** automatic_html_static
- **Rate page URL:** https://shikshak.bank.in/deposits/

## Hypothesis

8-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 16 slabs** against the live page (captured into tests/golden-html/regression-cases/shikshak-sahakari-bank-ltd-nagpur.html by Phase A's HTML harvester). If it still produces 8, the extractor has reproduced the bug.
