# Regression: hdfc-bank-ibu (gift)

- **Baseline slabs (rates-pack-2026-05-14):** 35
- **Actual slabs (tmp/baseline-pre-reset):** 8
- **Delta:** -77%
- **Bank type:** IBU
- **Scraper type:** pdf
- **Extraction method:** llm_inline_extraction
- **Rate page URL:** https://www.hdfcgiftcity.bank.in/content/dam/hdfc-bank-offshore-sites/gc/en/home-page/pdfs/offshore-deposit-interest-rates.pdf

## Hypothesis

27-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 35 slabs** against the live page (captured into tests/golden-html/regression-cases/hdfc-bank-ibu.html by Phase A's HTML harvester). If it still produces 8, the extractor has reproduced the bug.
