# Regression: chennai-central-co-operative-bank-ltd (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 11
- **Actual slabs (tmp/baseline-pre-reset):** 0
- **Delta:** -100%
- **Bank type:** DCCB
- **Scraper type:** null
- **Extraction method:** llm_inline_extraction
- **Rate page URL:** null

## Hypothesis

100% drop — either the variant page failed to fetch, or the extractor returned zero slabs from a page that should have produced 11.

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 11 slabs** against the live page (captured into tests/golden-html/regression-cases/chennai-central-co-operative-bank-ltd.html by Phase A's HTML harvester). If it still produces 0, the extractor has reproduced the bug.
