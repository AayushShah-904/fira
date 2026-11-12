# Regression: bank-of-india-ibu (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 8
- **Actual slabs (tmp/baseline-pre-reset):** 0
- **Delta:** -100%
- **Bank type:** IBU
- **Scraper type:** html_js
- **Extraction method:** automatic_html_js
- **Rate page URL:** undefined

## Hypothesis

100% drop — either the variant page failed to fetch, or the extractor returned zero slabs from a page that should have produced 8.

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 8 slabs** against the live page (captured into tests/golden-html/regression-cases/bank-of-india-ibu.html by Phase A's HTML harvester). If it still produces 0, the extractor has reproduced the bug.
