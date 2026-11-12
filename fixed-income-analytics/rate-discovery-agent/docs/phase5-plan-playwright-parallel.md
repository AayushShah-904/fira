# Phase 5: Enhanced Playwright + Batch Parallelization — Plan

**Date:** 2026-03-28
**Status:** Planning
**Depends on:** Phase 1 (rate limits), Phase 4 (extraction router)

## Goal

Fix partial extractions for JS-rendered banks (ICICI tabs, Axis lazy-loading, Suryoday dropdowns) and enable concurrent batch processing for faster wall-clock time.

## Phase 5a: Playwright Enhancements

**File to modify:** `scripts/fetch_rates_playwright.js` (121 lines → ~250 lines)

### Current Limitations
- No tab interaction → ICICI gets only 2 of 18+ slabs (visible tab only)
- No lazy-load scrolling → Axis gets only 2 of 18 slabs
- No `<select>` dropdown iteration → Suryoday needs option clicking
- No XHR interception → misses clean JSON API responses
- Full Chromium launch per invocation → 5s startup overhead in batch

### Planned Changes

1. **New CLI flags** (parsed from process.argv):
   - `--scroll` — scroll to bottom before extraction (auto-detect lazy loading)
   - `--tabs` — click all tab elements and extract per-tab data
   - `--selects` — iterate `<select>` dropdown options
   - `--intercept` — monitor XHR/fetch for JSON rate data
   - `--timeout <ms>` — override 30s default page load timeout

2. **Auto-scroll** (insert before body text extraction):
   - Loop: scroll to bottom, wait 500ms, check if scrollHeight increased
   - Max 10 iterations, final 1s settle
   - Activated by `--scroll` flag or auto-detected when page height grows

3. **Tab interaction** (after scrolling, before text extraction):
   - Detect tab elements: `[role="tab"]`, `.nav-tab`, `.nav-link`, `[data-toggle="tab"]`
   - Click each tab, wait for content update, extract visible table/text
   - Collect per-tab data with label
   - Activated by `--tabs` flag

4. **Select dropdown iteration** (alongside tabs):
   - Find `<select>` elements near rate tables
   - Iterate all `<option>` values, select each, wait, extract
   - Activated by `--selects` flag

5. **XHR/Fetch interception** (before page.goto):
   - Listen for JSON responses containing rate-like data (URLs with `/api/`, `rate`, `deposit`)
   - Store intercepted responses
   - Activated by `--intercept` flag

6. **Updated JSON output** — include `tabs[]` and `intercepted_apis[]` alongside existing fields

### Integration with extract_rates.js

The extraction router (Phase 4) already calls `fetch_rates_playwright.js <url>`. It will be updated to pass additional flags based on `scraper_notes` from config:
- `has_tabs: true` → pass `--tabs`
- `has_lazy_loading: true` → pass `--scroll`
- `has_dropdowns: true` → pass `--selects`

## Phase 5b: Batch Parallelization

**File to modify:** `run-batch.js`

### Current State
- Sequential processing with `spawnSync` (lines 280-290)
- 2-second delay between banks
- One bank at a time

### Planned Changes

1. **New `--concurrency N` flag** (default 1, max 5)
2. **Convert main loop to async** with Promise pool pattern:
   - Wrap batch execution in async main()
   - Replace spawnSync with spawn + Promise wrapper
   - Maintain a pool of N active child processes
   - Wait for any one to complete before launching next
3. **Output handling for concurrency > 1**:
   - Buffer each child's output (can't use stdio: "inherit" when interleaved)
   - Print one-line status per bank on completion
   - Prefix output with bank code for clarity
4. **Rate-limit coordination**:
   - If any child hits rate limit, apply backoff to the entire pool
   - Drain active children before pausing

## Verification

- `node scripts/fetch_rates_playwright.js <icici_url> --tabs` → multiple deposit tiers
- `node scripts/fetch_rates_playwright.js <axis_url> --scroll` → all slabs load
- `node run-batch.js banks.csv --category "Public Sector Bank" --limit 4 --concurrency 2` → 2 banks simultaneously
- Rate-limit detection still works with async execution
