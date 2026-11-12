# Regression: societe-generale (regular)

- **Baseline slabs (rates-pack-2026-05-14):** 6
- **Actual slabs (tmp/baseline-pre-reset):** 0
- **Delta:** -100%
- **Bank type:** FB
- **Scraper type:** html_js
- **Extraction method:** automatic_html_js
- **Rate page URL:** https://societegenerale.asia/en/india/rates-and-charges/

## Hypothesis

100% drop — either the variant page failed to fetch, or the extractor returned zero slabs from a page that should have produced 6.

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 6 slabs** against the live page (captured into tests/golden-html/regression-cases/societe-generale.html by Phase A's HTML harvester). If it still produces 0, the extractor has reproduced the bug.
