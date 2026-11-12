# Phase 4: Split Discovery from Extraction — Plan

**Date:** 2026-03-28
**Status:** Planning
**Depends on:** Phase 2 (utilities), Phase 3 (PDF extractor, known domains)

## Goal

Separate the LLM-powered discovery (find website, classify scraper, record config) from the deterministic extraction (fetch page, parse rates, write rates JSON). This is the core architectural change that enables ~40% token savings and shapes the recurring scraper.

## Current State

- The agent (via CLAUDE.md) does everything: finds website, classifies scraper, extracts rates, writes both `_config.json` and `_rates.json`
- For html_static banks, the LLM parses HTML tables and reasons about column mapping — deterministic work
- For html_js banks, the LLM orchestrates Playwright and parses the output — could be automated
- For pdf banks, the LLM produces empty `rate_slabs` — Phase 3b now has a PDF extractor

## Files to Create

### `scripts/extract_rates.js` — Universal Extraction Router

CLI interface:
```
node scripts/extract_rates.js <bank_code>           # single bank
node scripts/extract_rates.js --all                   # all banks with configs
node scripts/extract_rates.js --scraper-type pdf      # only PDF banks
```

Flow:
1. Read `output/<bank_code>_config.json`
2. Route based on `scraper_type`:
   - `html_static` → HTTP fetch + HTML table parse using selectors from config
   - `html_js` → Call `scripts/fetch_rates_playwright.js <url>`, parse JSON output
   - `pdf` → Call `scripts/extract_rates_pdf.mjs <url>`, parse JSON output
   - `mixed` → Try HTML first, then PDF
   - `manual`/`government` → Skip with log message
3. Post-process: apply parseTenure(), validateRate()
4. Write `output/<bank_code>_rates.json`

Dependencies: Node built-in `https` for HTML fetch, child_process for Playwright/PDF invocation, Phase 2 utilities.

For `html_static` parsing: use regex-based `<table>` extraction from raw HTML. The config provides `selectors.table`, `selectors.rows`, and `column_mapping`. For the initial implementation, a simple approach:
- Fetch the rate page URL via Node `https.get`
- Find `<table>` elements in raw HTML
- Parse `<tr>` rows, extract `<td>` cell text
- Apply column_mapping to map cells to schema fields

## Files to Modify

### `run-discovery.js`
- Add `--extract` (default true) and `--no-extract` flags
- After Claude finishes and config exists, if `--extract` is active, spawn `scripts/extract_rates.js <bank_code>`
- Report extraction results in the summary line

### `CLAUDE.md`
- Step 4: Change from "Extract Rate Data" to "Classify & Record Extraction Metadata"
  - Agent still inspects the page to determine scraper_type, selectors, column_mapping
  - Agent no longer extracts actual rate numbers
  - Agent notes additional metadata: presence of tabs, dropdowns, lazy-loading, multiple tables
- Step 5: Change from writing two files to writing config only
  - Only `_config.json` is written by the agent
  - Summary says "Rates: pending extraction" instead of slab count

### `prompts/discover.md`
- Update to reflect config-only output

## Verification

- `node scripts/extract_rates.js hdfc-bank-limited` → extracts rates from existing config
- `node scripts/extract_rates.js --all` → batch extraction with summary
- `node scripts/extract_rates.js --scraper-type pdf` → only PDF banks
- `node run-discovery.js "Test" --no-extract` → only config written
- `node run-discovery.js "Test"` → both config and rates (backward compat)
