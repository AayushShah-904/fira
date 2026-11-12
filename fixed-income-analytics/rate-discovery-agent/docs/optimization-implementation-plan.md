# Rate Discovery Agent: Optimization Implementation Plan

## Context

The rate-discovery-agent has successfully processed ~75 of ~1900 Indian banks, but at 3-6 min and ~18K tokens per bank, full discovery would cost ~$500 and take 100+ hours. A detailed analysis identified 10 optimization proposals (see `rate-discovery-agent/docs/discovery-analysis-and-optimization.md`). Additionally, the foreign bank batch had 91% failure rate due to unhandled API rate limits. This plan implements all 10 proposals in 6 sequential phases, prioritized by impact and dependencies.

## Phase 1: Rate Limit Detection & Backoff

**Goal:** Unblock batch processing. Detect rate limits, classify failures, enable intelligent retry.

**Files to modify:**
- `rate-discovery-agent/run-batch.js`

**Changes:**

1. **Add rate-limit detection** (new function after CSV parsing section, ~line 100):
   - Pattern array: `/hit your limit/i`, `/rate.?limit/i`, `/too many requests/i`, `/429/`
   - `detectRateLimit(text)` function that scans log file contents after each bank completes
   - Extract reset time from message when available ("resets 1:30am")

2. **Three-status classification** (replace current success/failed/timeout):
   - After `spawnSync` returns, read `output/<bankCode>.log` (already written by run-discovery.js)
   - If log matches rate-limit pattern → `"rate_limited"` status
   - If exit 0 + config exists → `"success"`
   - If SIGTERM → `"timeout"`
   - Otherwise → `"failed"`

3. **Consecutive rate-limit backoff** in main loop:
   - Track `consecutiveRateLimits` counter
   - 1st hit: warn, increase delay to 60s
   - 2nd consecutive: pause 5 minutes, log reset time
   - 3rd consecutive: abort batch with clear message
   - Reset counter on any non-rate-limited result

4. **Enhanced `--resume` logic**:
   - Load previous `_batch_results_<category>.json` if it exists
   - `status: "success"` + config file exists → skip
   - `status: "rate_limited"` → always retry (transient failure)
   - `status: "failed"` → skip (unless new `--retry-failed` flag is passed)

5. **Expanded batch results schema**:
   ```json
   { "name": "...", "status": "rate_limited", "rate_limit_message": "resets 1:30am", "elapsed_sec": 5 }
   ```

**Verification:**
- Run `node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Foreign Bank" --limit 5`
- Confirm rate-limited banks show `"rate_limited"` in results JSON
- Run again with `--resume` — confirm rate-limited banks are retried, succeeded ones skipped

---

## Phase 2: Shared Utility Scripts

**Goal:** Extract deterministic logic into reusable CommonJS modules. Prerequisite for Phases 3-6.

**Files to create:**
- `rate-discovery-agent/scripts/utils/slugify.js`
- `rate-discovery-agent/scripts/utils/parse-tenure.js`
- `rate-discovery-agent/scripts/utils/validate-rates.js`
- `rate-discovery-agent/scripts/utils/config-defaults.js`
- `rate-discovery-agent/scripts/utils/index.js`

**Files to modify:**
- `rate-discovery-agent/run-discovery.js` — replace inline slug (lines 52-58) with `require("./scripts/utils/slugify")`
- `rate-discovery-agent/run-batch.js` — replace inline `toBankCode()` (lines 162-170)

**Details:**

1. **`slugify.js`** — Port exact algorithm from `packages/api/src/lib/helpers.ts:5-12`. Export `slugify(text)`. Also support CLI: `node scripts/utils/slugify.js "Bank Name"` → prints slug to stdout.

2. **`parse-tenure.js`** — Port logic from `packages/shared/src/constants/tenure-maps.ts:17-112`. Copy `TENURE_PRESETS`, `TENURE_UNIT_DAYS`, and `parseTenureText()` as CommonJS (the shared package is ESM TypeScript, can't be imported directly). Export `{ parseTenure, TENURE_PRESETS, TENURE_UNIT_DAYS }`. CLI mode: `node scripts/utils/parse-tenure.js "7 days to 14 days"` → `{"min_days":7,"max_days":14}`.

3. **`validate-rates.js`** — `validateRate(pct)` checks 2.50-9.50 range (up to 10.00 for senior). `validateSlabs(slabs)` checks array for completeness, flags outliers. Export `{ validateRate, validateSlabs }`.

4. **`config-defaults.js`** — `CONFIG_DEFAULTS` object with standard values (`tenure_parser: "standard_indian"`, `rate_multiplier: 1.0`, `senior_citizen_premium: "same_table"`, `deposit_insurance: true`, `update_frequency: "monthly"`, null selectors, empty scraper_notes). Export `{ CONFIG_DEFAULTS, mergeWithDefaults, stripDefaults }`.

5. **`index.js`** — Barrel re-export of all utilities.

**Verification:**
- `node scripts/utils/slugify.js "HDFC Bank Limited"` → `hdfc-bank-limited`
- `node scripts/utils/parse-tenure.js "1 year to less than 2 years"` → `{"min_days":365,"max_days":729}`
- `node run-discovery.js "Test"` still works with shared slugify import
- `node run-batch.js ... --limit 1` still works

---

## Phase 3: Pre-Seed Known Domains + PDF Extractor

**Goal:** Eliminate web search for known banks, fill data gap for 24% PDF banks.

**Depends on:** Phase 2 (utilities).

### Phase 3a: Known Bank Domains

**Files to create:**
- `rate-discovery-agent/data/bank-domains.json`
- `rate-discovery-agent/scripts/seed-domains.js` (one-time generator)

**Files to modify:**
- `rate-discovery-agent/CLAUDE.md` — add "Step 0: Check Known Domains"

**Details:**

1. **`scripts/seed-domains.js`** — Reads all existing `output/*_config.json`, extracts `bank_code`, `website`, `rate_page_urls.fd`, `scraper_type`, and writes `data/bank-domains.json`. Run once, then maintain manually.

2. **`data/bank-domains.json`** structure:
   ```json
   {
     "hdfc-bank-limited": {
       "domain": "hdfc.bank.in",
       "rate_pages": { "fd": "/personal/save/deposits/fixed-deposit-interest-rate" },
       "scraper_type": "html_js",
       "notes": "CloudFront WAF, AEM"
     }
   }
   ```

3. **CLAUDE.md** — Insert new "Step 0" before Step 1:
   - Derive bank_code, look up in `data/bank-domains.json`
   - If domain + rate_page found → skip Steps 1-2, go to Step 3
   - If only domain found → skip Step 1, do Step 2 on known domain
   - If not found → full workflow

### Phase 3b: PDF Extractor

**Files to create:**
- `rate-discovery-agent/scripts/extract_rates_pdf.js`

**Details:**

CLI: `node scripts/extract_rates_pdf.js <url_or_path> [--bank-code <code>]`

1. If URL → download via Node `https.get` to temp file
2. Read PDF with `pdf-parse` (already in package.json)
3. Split text into lines, identify table rows (lines with `\d+\.\d+\s*%`)
4. Extract tenure text + rate percentages per row
5. Apply `parseTenure()` from utils
6. Apply `validateRate()` from utils
7. Output JSON after `=== JSON_OUTPUT ===` marker (same convention as Playwright script)

Handle observed PDF patterns:
- Simple 2-col: tenure | rate (Citibank)
- 3-col: tenure | general | senior (BNP Paribas)
- Multi-col grids: tenure | rate1 | rate2 | ... (JP Morgan — extract smallest tier)

**CLAUDE.md** — Add under Tier 3 extraction:
```
Run `node scripts/extract_rates_pdf.js <pdf_url>` to extract rates from PDF files.
```

**Verification:**
- `node scripts/seed-domains.js` produces `data/bank-domains.json` with ~75 entries
- `node scripts/extract_rates_pdf.js output/citibank-na_deposit_rates.pdf` extracts rate slabs
- Run agent for a bank in `bank-domains.json` — confirm it skips web search

---

## Phase 4: Split Discovery from Extraction

**Goal:** LLM does discovery (config only), deterministic code does extraction (rates). ~40% token savings.

**Depends on:** Phase 2 (utilities), Phase 3 (PDF extractor).

**Files to create:**
- `rate-discovery-agent/scripts/extract_rates.js` — universal extraction router

**Files to modify:**
- `rate-discovery-agent/CLAUDE.md` — Steps 4-5 become config-only (no rate extraction)
- `rate-discovery-agent/run-discovery.js` — add `--extract` / `--no-extract` flags
- `rate-discovery-agent/prompts/discover.md` — update to reflect config-only output

**Details:**

### `scripts/extract_rates.js` (the deterministic extractor)

CLI: `node scripts/extract_rates.js <bank_code>` or `node scripts/extract_rates.js --all`

1. Read `output/<bank_code>_config.json`
2. Route based on `scraper_type`:
   - `html_static` → HTTP fetch + parse HTML `<table>` using selectors from config. Use regex-based table extraction (no cheerio dependency needed for simple tables)
   - `html_js` → Call `node scripts/fetch_rates_playwright.js <url>`, parse JSON output
   - `pdf` → Call `node scripts/extract_rates_pdf.js <pdf_url>`, parse JSON output
   - `mixed` → HTML first, then PDF for remaining
   - `manual`/`government` → Skip with log
3. Post-processing: apply `parseTenure()`, `validateRate()`, populate `deposit_range`
4. Write `output/<bank_code>_rates.json`

### CLAUDE.md Changes

- Step 4 becomes "Classify & Record Metadata" — no longer extracts rates. Records scraper_type, selectors, column_mapping, scraper_notes, presence of tabs/dropdowns/lazy-loading
- Step 5 becomes "Write Config File Only" — only `_config.json`, not `_rates.json`
- Summary output says "Rates: pending extraction" instead of slab count

### run-discovery.js Changes

Add flags `--extract` (default: true for backward compat) and `--no-extract`:
- After Claude finishes writing config, if `--extract` is active, run `node scripts/extract_rates.js <bank_code>`
- `--no-extract` → discovery only (useful for batch where extraction is separate)

**Verification:**
- `node run-discovery.js "Test Bank" --no-extract` → only config written
- `node scripts/extract_rates.js hdfc-bank-limited` → rates extracted from existing config
- `node scripts/extract_rates.js --all` → batch extraction for all banks with configs
- `node run-discovery.js "SBI"` (default) → still produces both files

---

## Phase 5: Enhanced Playwright + Batch Parallelization

**Goal:** Fix partial extractions (ICICI tabs, Axis lazy-loading) and enable concurrent batch processing.

**Depends on:** Phase 1 (rate limits), Phase 4 (extraction router).

### Phase 5a: Playwright Enhancements

**File to modify:** `rate-discovery-agent/scripts/fetch_rates_playwright.js`

Add ~100-150 lines of enhancements while keeping the same CLI interface:

1. **New CLI flags:** `--scroll`, `--tabs`, `--selects`, `--intercept`, `--timeout <ms>`
2. **Auto-scroll** before extraction: scroll to bottom in loop, wait for new content, max 10 iterations
3. **Tab interaction**: detect `[role="tab"]`, `.nav-tab`, `.nav-link` elements, click each, extract per-tab data
4. **`<select>` iteration**: detect dropdowns, iterate all options, extract per-option data
5. **XHR interception**: listen for JSON responses from `/api/`, `/data/`, `rate`, `deposit` URLs — capture clean JSON data when available
6. **Updated JSON output**: include `tabs[]` array and `intercepted_apis[]` alongside existing fields

### Phase 5b: Batch Parallelization

**File to modify:** `rate-discovery-agent/run-batch.js`

1. Add `--concurrency N` flag (default 1, max 5)
2. Convert from `spawnSync` loop to async `spawn` with Promise pool
3. When concurrency > 1: buffer each child's output, print one-line status per bank on completion
4. Integrate with Phase 1 rate-limit detection (if any child hits rate limit, apply backoff across all)

**Verification:**
- `node scripts/fetch_rates_playwright.js "https://www.icicibank.com/..." --tabs` → multiple tiers extracted
- `node scripts/fetch_rates_playwright.js "https://www.axisbank.com/..." --scroll` → all slabs load
- `node run-batch.js banks.csv --category "Public Sector Bank" --limit 4 --concurrency 2` → 2 banks run simultaneously

---

## Phase 6: Tiered Strategy + Schema Cleanup

**Goal:** Skip LLM entirely for known banks. Clean up config schema. Add deposit_range support.

**Depends on:** All prior phases.

### Phase 6a: Tiered Agent Strategy

**Files to modify:**
- `rate-discovery-agent/run-batch.js` — add routing logic

**Files to create:**
- `rate-discovery-agent/scripts/run-extract-only.js` — batch extraction without LLM

Routing logic in batch runner:
```
Tier A (known domain + html_static) → skip LLM, direct extract → 30s, 0 tokens
Tier B (known domain + html_js)     → skip LLM, Playwright extract → 1min, 0 tokens
Tier C (known domain + pdf)         → skip LLM, PDF extract → 30s, 0 tokens
Tier D (known domain only)          → LLM for rate page discovery → 2-3min, 8-12K tokens
Tier E (unknown)                    → full LLM discovery → 3-5min, 15-20K tokens
```

`scripts/run-extract-only.js`: batch extraction for all Tier A/B/C banks:
```
node scripts/run-extract-only.js                     # all banks with configs
node scripts/run-extract-only.js --scraper-type pdf   # only PDF banks
```

### Phase 6b: Config Schema Simplification

- Use `stripDefaults()` from Phase 2 when writing configs
- Update CLAUDE.md to note which fields are optional/have defaults
- Optional: migration script to strip defaults from existing 75 configs

### Phase 6c: Unified Multi-Table Schema

- Add `deposit_range` field to rate_slabs in CLAUDE.md schema
- Standard values: `"below_3cr"` (default), `"3cr_to_5cr"`, `"5cr_to_25cr"`, `"25cr_to_100cr"`, `"above_100cr"`, plus co-op values
- This aligns with existing `min_deposit_for_slab`/`max_deposit_for_slab` fields in `packages/shared/src/schemas/rate.ts:22-23`
- `deposit_range` is the human-readable label; numeric fields remain as precise bounds
- Migration: add `"deposit_range": "below_3cr"` to existing files, merge HDFC `_rates_bulk.json` into `_rates.json`

**Verification:**
- Run batch with tiered routing — Tier A banks complete in <30s with 0 LLM tokens
- `node scripts/run-extract-only.js --scraper-type pdf` → PDF banks now have populated rate_slabs
- Config files are smaller (defaults stripped)
- Rate files include `deposit_range` field

---

## Dependency Graph

```
Phase 1 (Rate Limits)        Phase 2 (Utilities)
      |                        /        \
      |                Phase 3a       Phase 3b
      |              (Domains)      (PDF Extract)
      |                    \         /
      |                   Phase 4
      |              (Split Disc/Ext)
      |                     |
      +---------> Phase 5 (Playwright + Parallel)
                            |
                       Phase 6
                  (Tiered + Schema)
```

Phases 1 and 2 have no dependencies and can be implemented in parallel.

---

## Key References

| File | Purpose |
|------|---------|
| `rate-discovery-agent/run-batch.js` | Batch processor — Phases 1, 5b, 6a |
| `rate-discovery-agent/run-discovery.js` | Single bank runner — Phases 2, 4 |
| `rate-discovery-agent/CLAUDE.md` | Agent instructions — Phases 3a, 4, 6b, 6c |
| `rate-discovery-agent/scripts/fetch_rates_playwright.js` | Playwright scraper — Phase 5a |
| `packages/api/src/lib/helpers.ts` | Canonical slugify() — Phase 2 reference |
| `packages/shared/src/constants/tenure-maps.ts` | Canonical parseTenureText() — Phase 2 reference |
| `packages/shared/src/schemas/rate.ts` | Rate schema with min/max_deposit_for_slab — Phase 6c reference |

## Projected Impact

| Metric | Current | After All Phases |
|--------|---------|-----------------|
| Tokens/bank (known) | 18K | 0 (no LLM) |
| Tokens/bank (unknown) | 18K | 10-12K |
| Total for 1900 banks | ~34M tokens | ~15-20M tokens |
| Time per bank | 3-6 min | 30s-3min |
| Batch failure rate (rate limits) | 91% | ~0% |
| PDF banks with data | 0% | ~90% |
| Cost estimate | ~$500 | ~$220-300 |
