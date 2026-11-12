# Phase 4: Split Discovery from Extraction — Implementation Notes

**Date:** 2026-03-28
**Status:** Complete
**Files created:** `scripts/extract_rates.js`
**Files modified:** `run-discovery.js`, `CLAUDE.md`, `prompts/discover.md`

## Problem

The LLM agent was doing everything — finding websites, classifying scrapers, AND extracting rate numbers. The extraction part is deterministic work (fetch page → parse HTML table → map columns → write JSON) that doesn't need an LLM. This wasted ~40% of tokens on rule-based operations.

## Changes Made

### 1. `scripts/extract_rates.js` — Universal Extraction Router (new, ~280 lines)

CLI interface:
```
node scripts/extract_rates.js <bank_code>              # single bank
node scripts/extract_rates.js --all                      # all banks with configs
node scripts/extract_rates.js --scraper-type pdf         # only PDF banks
node scripts/extract_rates.js --scraper-type html_static --limit 5
```

**Routing logic by `scraper_type`:**

| Type | Method | Details |
|------|--------|---------|
| `html_static` | HTTP GET + regex HTML parser | Fetches rate page URL, parses `<table>` elements, applies column_mapping from config |
| `html_js` | Spawns `fetch_rates_playwright.js` | Passes URL, parses JSON output after `=== JSON_OUTPUT ===` |
| `pdf` | Spawns `extract_rates_pdf.mjs` | Passes PDF URL (from config rate_page_urls.fd or scraper_notes.pdf_url), parses JSON output |
| `mixed` | HTML first, then PDF | Falls back to PDF if HTML yields 0 slabs |
| `manual`/`government` | Skip | Logs and returns |

**HTML table parser** — regex-based, no external dependency:
- Extracts `<table>` → `<tr>` → `<td>`/`<th>` cells
- Strips HTML tags, decodes entities
- Applies `column_mapping` from config to map cell indices to schema fields
- Uses `parseTenure()` from Phase 2 utilities for tenure text normalization
- Uses `validateSlabs()` from Phase 2 utilities for quality checks
- Picks the table with the most valid rate slabs (handles multi-table pages)

**Effective date extraction** — regex patterns for "w.e.f.", "with effect from", "applicable from", "modified date".

**Post-processing:** validates all slabs, writes `_rates.json` with full schema (bank_code, product_type, variant, effective_date, source_url, scraped_at, extraction_confidence, rate_slabs, special_schemes, warnings, errors).

### 2. `run-discovery.js` — `--extract`/`--no-extract` Flags

Added two new flags:
- `--extract` (default) — after Claude finishes writing config, automatically run `scripts/extract_rates.js <bank_code>` to extract rates
- `--no-extract` — discovery only, write config, skip rate extraction

**Backward compatibility:** If the agent already wrote `_rates.json` with slabs (legacy behavior), the extraction step is skipped (detected by checking `slabCount > 0` on the existing file). Extraction only runs when the rates file doesn't exist or has 0 slabs.

The extraction step has a 2-minute timeout and inherits stdio for progress output.

### 3. `CLAUDE.md` — Steps 4 and 5 Restructured

**Step 4** changed from "Extract Rate Data" to "Classify & Record Extraction Metadata":
- Agent no longer extracts actual rate numbers
- Instead records: selectors, column_mapping, scraper_notes (framework, bot_protection, data_format, has_tabs, has_dropdowns, has_lazy_loading)
- Tier-specific guidance on what metadata to capture

**Step 5** changed from "Generate Output Files" (two files) to "Generate Config File" (one file):
- Only `_config.json` is written by the agent
- Note added: "You do NOT need to write a `_rates.json` file"
- Rates schema example removed from CLAUDE.md (extraction is code's responsibility)

### 4. `prompts/discover.md` — Updated

- Step 4 changed to "Record extraction metadata"
- Step 5 changed to "Write config JSON" (single file)
- Added "You do NOT need to extract actual rate numbers" instruction
- Summary template updated: removed "Rates Extracted" line, shows single file

## Testing

| Test | Command | Result |
|------|---------|--------|
| html_static | `extract_rates.js dhanlaxmi-bank-limited` | 12 slabs from live HTML fetch |
| pdf | `extract_rates.js citibank-na` | 34 slabs from remote PDF |
| pdf batch | `extract_rates.js --scraper-type pdf --limit 3` | 2/3 succeeded (AmEx broken URL) |
| Bank of America | via batch | 9 slabs from PDF |
| BBK India | via batch | 18 slabs from PDF |
| Syntax | `node -c` on all files | All OK |

## Architecture Impact

Before Phase 4:
```
Claude Agent → (discovers + extracts) → _config.json + _rates.json
Cost: ~18K tokens/bank
```

After Phase 4:
```
Claude Agent → (discovers only) → _config.json           [~10K tokens]
extract_rates.js → (deterministic) → _rates.json         [0 tokens]
```

The extraction script is also the foundation for the recurring scraper — same code path, different trigger (cron instead of discovery).
