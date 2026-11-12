# Regression: fino-payments-bank-limited (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 1
- **Actual slabs (tmp/baseline-pre-reset):** 0
- **Delta:** -100%
- **Bank type:** PB
- **Scraper type:** html_js
- **Extraction method:** automatic_text_pattern
- **Rate page URL:** https://fino.bank.in/more/fixed-deposit

## Hypothesis

100% drop — either the variant page failed to fetch, or the extractor returned zero slabs from a page that should have produced 1.

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 1 slabs** against the live page (captured into tests/golden-html/regression-cases/fino-payments-bank-limited.html by Phase A's HTML harvester). If it still produces 0, the extractor has reproduced the bug.
