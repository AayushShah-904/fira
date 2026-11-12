# Regression: akola-district-central-co-operative-bank-ltd (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 10
- **Actual slabs (tmp/baseline-pre-reset):** 8
- **Delta:** -20%
- **Bank type:** DCCB
- **Scraper type:** html_static
- **Extraction method:** llm_inline_extraction
- **Rate page URL:** https://akolawashimdcc.bank.in/interest-rate-on-deposits.php

## Hypothesis

2-slab drop — likely partial extraction (column-mapping bug, table-picker selecting wrong table, or wait-condition firing before all rows render).

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 10 slabs** against the live page (captured into tests/golden-html/regression-cases/akola-district-central-co-operative-bank-ltd.html by Phase A's HTML harvester). If it still produces 8, the extractor has reproduced the bug.
