# Regression: indian-bank (fcnr)

- **Baseline slabs (rates-pack-2026-05-14):** 40
- **Actual slabs (tmp/baseline-pre-reset):** 25
- **Delta:** -37%
- **Bank type:** PSB
- **Scraper type:** html_static
- **Extraction method:** llm_inline_extraction
- **Rate page URL:** https://indianbank.bank.in/departments/fcnr-b-deposits/

## Hypothesis

15-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 40 slabs** against the live page (captured into tests/golden-html/regression-cases/indian-bank.html by Phase A's HTML harvester). If it still produces 25, the extractor has reproduced the bug.
