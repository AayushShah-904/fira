# Phase 5: Enhanced Playwright + Batch Parallelization — Implementation Notes

**Date:** 2026-03-28
**Status:** Complete
**Files modified:** `scripts/fetch_rates_playwright.js`, `scripts/extract_rates.js`, `run-batch.js`

## Phase 5a: Playwright Enhancements

### Problem
The Playwright script only extracted what was visible on initial page load. Banks with tabs (ICICI), lazy-loaded content (Axis), or dropdowns (Suryoday) produced partial extractions (2 of 18+ slabs).

### Changes to `scripts/fetch_rates_playwright.js` (121 → ~240 lines)

**New CLI flags:**
- `--scroll` — scrolls to bottom in a loop (max 10 iterations, 500ms between), detecting when scrollHeight stops growing. Triggers lazy-loaded content.
- `--tabs` — finds tab elements (`[role="tab"]`, `.nav-tab`, `.nav-link`, `[data-toggle="tab"]`, `[data-bs-toggle="tab"]`), clicks each, waits 1s, extracts tables and rate slabs per tab. Collects results in `tabs[]` array.
- `--selects` — iterates `<select>` dropdown options (up to 3 select elements, all options each). Collects results in `selects[]` array.
- `--intercept` — monitors `page.on("response")` for JSON responses from URLs containing `/api/`, `rate`, `deposit`, `interest`. Captured in `intercepted_apis[]` array.
- `--timeout <ms>` — overrides default 30s page load timeout.

**Refactored into helper functions:**
- `extractAllTables(page)` — `page.evaluate()` to extract all `<table>` elements (was inline)
- `parseRateSlabsFromText(text)` — regex-based rate slab parser (was inline)
- Both are reused for main extraction, tab extraction, and select extraction

**Updated JSON output schema:**
```json
{
  "url": "...",
  "scraped_at": "...",
  "effective_dates": [...],
  "tables": [...],
  "rate_slabs": [...],
  "tabs": [{ "label": "Below 3 Cr", "tables": [...], "rate_slabs": [...] }],
  "selects": [{ "select_index": 0, "option": "1 Year", "value": "1y", "rate_slabs": [...] }],
  "intercepted_apis": [{ "url": "...", "data": {...} }]
}
```
`tabs`, `selects`, `intercepted_apis` are only present when corresponding flags are used and data is found.

### Integration with extract_rates.js

Updated the `extractHtmlJs()` function to pass flags based on `scraper_notes` from config:
- `has_tabs: true` → `--tabs`
- `has_lazy_loading: true` → `--scroll`
- `has_dropdowns: true` → `--selects`

Timeout increased from 60s to 120s to accommodate tab iteration time.

## Phase 5b: Batch Parallelization

### Problem
Batch processing was purely sequential (`spawnSync`). For 1900 banks at 3-6 min each, that's 95-190 hours wall clock.

### Changes to `run-batch.js`

**New `--concurrency N` flag** (default 1, max 5).

**Architecture:** The main loop was refactored into shared helper functions + two execution paths:

1. **Helper functions** (shared by both paths):
   - `checkResume(bank, bankCode, index, total)` — resume/skip logic extracted from the loop
   - `runBankSync(bank, ...)` — wraps `spawnSync` with timing, returns result object
   - `runBankAsync(bank, ...)` — wraps `spawn` with Promise, buffers output, returns result object
   - `classifyResult(bank, bankCode, exitCode, signal, elapsed)` — reads log file, detects rate limits, classifies status (shared by sync/async)
   - `applyBackoff(result)` — consecutive rate-limit tracking + backoff escalation
   - `writeSummary()` — prints stats and saves batch results JSON

2. **Sequential path** (`concurrency <= 1`): Uses `runBankSync` + `spawnSync` with `stdio: "inherit"` (preserves live output with spinner). Identical behavior to before Phase 5.

3. **Parallel path** (`concurrency > 1`):
   - First pass: check all banks against resume logic, build work queue
   - Promise pool: maintains up to N active `runBankAsync` calls
   - `spawn` with `stdio: ["ignore", "pipe", "pipe"]` — buffers output per child
   - On completion: prints one-line summary (last line of stdout)
   - Rate-limit backoff applies across all concurrent children
   - Delay between launches (not between completions)
   - Calls `writeSummary()` via `.then()` callback

**Async output handling:** When concurrency > 1, child processes can't share `stdio: "inherit"` (interleaved output). Instead:
- stdout/stderr are piped and buffered per child
- On completion, only the last line of stdout is printed (the `✓ elapsed | type | slabs | website` summary line from `run-discovery.js`)
- Full output is still written to the per-bank `.log` file by `run-discovery.js` itself

### Design Decisions

1. **Two code paths instead of converting everything to async:** The sequential path preserves `stdio: "inherit"` for interactive use (you see the spinner, live progress). Converting to async would lose this. The parallel path uses buffered output which is appropriate for concurrent execution.

2. **Max concurrency 5:** Higher values would overwhelm the Claude API rate limiter. The `applyBackoff` function coordinates across all children — if any hits a rate limit, the backoff applies globally.

3. **Delay between launches (not completions):** In parallel mode, delay is applied between starting new children, not between completions. This provides a steady drip of requests rather than bursts.

## Testing

- `node -c run-batch.js` — Syntax OK
- `node -c scripts/fetch_rates_playwright.js` — Syntax OK
- `node run-batch.js` — Shows `--concurrency` in usage
- Playwright flags verified via CLI argument parsing (functional test requires live bank website)
