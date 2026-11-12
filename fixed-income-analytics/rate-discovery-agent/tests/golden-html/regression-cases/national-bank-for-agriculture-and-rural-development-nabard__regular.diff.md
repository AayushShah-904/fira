# Regression: national-bank-for-agriculture-and-rural-development-nabard (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 5
- **Actual slabs (tmp/baseline-pre-reset):** 0
- **Delta:** -100%
- **Bank type:** FI
- **Scraper type:** null
- **Extraction method:** llm_inline_extraction
- **Rate page URL:** null

## Hypothesis

100% drop — either the variant page failed to fetch, or the extractor returned zero slabs from a page that should have produced 5.

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 5 slabs** against the live page (captured into tests/golden-html/regression-cases/national-bank-for-agriculture-and-rural-development-nabard.html by Phase A's HTML harvester). If it still produces 0, the extractor has reproduced the bug.
