# Regression: indusind-bank-ibu (gift)

- **Baseline slabs (rates-pack-2026-05-14):** 24
- **Actual slabs (tmp/baseline-pre-reset):** 0
- **Delta:** -100%
- **Bank type:** IBU
- **Scraper type:** manual
- **Extraction method:** llm_inline_extraction
- **Rate page URL:** https://indusind.bank.in/in/en/personal/rates.html#gift_city

## Hypothesis

100% drop — either the variant page failed to fetch, or the extractor returned zero slabs from a page that should have produced 24.

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 24 slabs** against the live page (captured into tests/golden-html/regression-cases/indusind-bank-ibu.html by Phase A's HTML harvester). If it still produces 0, the extractor has reproduced the bug.
