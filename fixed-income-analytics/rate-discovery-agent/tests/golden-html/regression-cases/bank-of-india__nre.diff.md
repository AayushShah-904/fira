# Regression: bank-of-india (nre)

- **Baseline slabs (rates-pack-2026-05-14):** 11
- **Actual slabs (tmp/baseline-pre-reset):** 7
- **Delta:** -36%
- **Bank type:** PSB
- **Scraper type:** html_js
- **Extraction method:** llm_inline_extraction
- **Rate page URL:** https://bankofindia.bank.in/interest-rates-on-deposit

## Hypothesis

4-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 11 slabs** against the live page (captured into tests/golden-html/regression-cases/bank-of-india.html by Phase A's HTML harvester). If it still produces 7, the extractor has reproduced the bug.
