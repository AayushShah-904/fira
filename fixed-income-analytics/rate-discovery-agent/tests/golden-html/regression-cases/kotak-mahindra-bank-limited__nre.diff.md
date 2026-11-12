# Regression: kotak-mahindra-bank-limited (nre)

- **Baseline slabs (rates-pack-2026-05-14):** 7
- **Actual slabs (tmp/baseline-pre-reset):** 0
- **Delta:** -100%
- **Bank type:** PVB
- **Scraper type:** html_static
- **Extraction method:** automatic_html_static
- **Rate page URL:** https://kotak.bank.in/en/personal-banking/nri/accounts-deposits/deposits/nre-fixed-deposit/interest-rate.html

## Hypothesis

100% drop — either the variant page failed to fetch, or the extractor returned zero slabs from a page that should have produced 7.

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 7 slabs** against the live page (captured into tests/golden-html/regression-cases/kotak-mahindra-bank-limited.html by Phase A's HTML harvester). If it still produces 0, the extractor has reproduced the bug.
