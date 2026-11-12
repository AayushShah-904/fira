# Regression: cosmos-co-operative-bank-ltd (nre)

- **Baseline slabs (rates-pack-2026-05-14):** 8
- **Actual slabs (tmp/baseline-pre-reset):** 6
- **Delta:** -25%
- **Bank type:** SUCB
- **Scraper type:** html_static
- **Extraction method:** undefined
- **Rate page URL:** https://cosmos.bank.in/interest-rates

## Hypothesis

2-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 8 slabs** against the live page (captured into tests/golden-html/regression-cases/cosmos-co-operative-bank-ltd.html by Phase A's HTML harvester). If it still produces 6, the extractor has reproduced the bug.
