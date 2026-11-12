# Regression: ahmedabad-mercantile-co-op-bank-ltd (nre)

- **Baseline slabs (rates-pack-2026-05-14):** 3
- **Actual slabs (tmp/baseline-pre-reset):** 0
- **Delta:** -100%
- **Bank type:** SUCB
- **Scraper type:** html_static
- **Extraction method:** automatic_html_static
- **Rate page URL:** https://amco.bank.in/n/deposit-interest-rate

## Hypothesis

100% drop — either the variant page failed to fetch, or the extractor returned zero slabs from a page that should have produced 3.

## Phase C extractor target

When the Phase C extractor for this bank's template is authored, it must produce **≥ 3 slabs** against the live page (captured into tests/golden-html/regression-cases/ahmedabad-mercantile-co-op-bank-ltd.html by Phase A's HTML harvester). If it still produces 0, the extractor has reproduced the bug.
