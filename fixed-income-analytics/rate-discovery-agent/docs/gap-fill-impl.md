# Gap-Fill Implementation — Rate Discovery Agent

## Summary

This document covers the work done to achieve comprehensive rate coverage for India's 251 priority banks (excluding NSUCB/DCCB). The session spanned infrastructure improvements, batch discovery runs, and targeted fixes for stubborn banks.

### Coverage Achieved

| Category | Total | FD Rates | NRE | NRO | FCNR | GIFT | Skipped |
|----------|-------|----------|-----|-----|------|------|---------|
| PSB | 12 | **12** (100%) | 12 | 9 | 12 | — | 0 |
| PVB | 21 | **21** (100%) | 20 | 18 | 18 | — | 1 |
| SFB | 11 | **11** (100%) | 9 | 9 | 7 | — | 0 |
| PB | 6 | **6** (100%) | — | — | — | — | 0 |
| FB | 44 | **35** (80%) | 14 | 12 | 11 | — | 12 |
| IBU | 37 | **21** (57%) | — | — | — | 18 | 15 |
| RRB | 28 | **25** (89%) | — | — | — | — | 0 |
| SUCB | 52 | **50** (96%) | — | — | — | — | 4 |
| SSCB | 24 | **24** (100%) | — | — | — | — | 0 |
| NSSCB | 10 | **7** (70%) | — | — | — | — | 1 |
| LAB | 2 | **2** (100%) | — | — | — | — | 0 |
| FI | 4 | **1** (25%) | — | — | — | — | 4 |
| **Total** | **251** | **215** (86%) | **60** | **48** | **50** | **18** | **37** |

**Output files:** 421 domestic rate files, 62 NRE, 48 NRO, 50 FCNR, 18 GIFT — totaling 2,224 domestic FD rate slabs across 243 banks.

**Total API cost:** ~$55

### Banks Skipped (37)

Banks tagged with status fields in `bank-domains.json` — not processable by automated tools:

| Status | Count | Examples |
|--------|-------|---------|
| `wholesale_only` | 20 | ANZ, UBS, Barclays IBU, Deutsche IBU, JP Morgan IBU |
| `website_not_found` | 6 | QNB, Sberbank (reclassified to rates_not_published) |
| `no_retail_deposits` | 4 | NABARD, SIDBI, NHB, EXIM Bank |
| `rates_not_published` | 4 | MUFG, Maybank, Sberbank, Woori, Sonali |
| `rates_in_images` | 2 | Janalaxmi Co-op, Karimnagar DCCB |
| `site_unreachable` | 5 | Yes Bank (Akamai), AP Mahesh, Bombay Mercantile, Indian Mercantile, VTB |

---

## Infrastructure Changes

### 1. dotenv Integration

**Problem:** Node scripts couldn't read `.env` files — Azure OpenAI credentials required manual export.

**Fix:** Added `require("dotenv").config()` to all 4 entry points (`run-discovery.js`, `run-batch.js`, `run-pipeline.js`, `scripts/run-domain-discovery.js`). The domain discovery script uses an explicit path since it runs from `scripts/`.

**Files:** `run-discovery.js`, `run-batch.js`, `run-pipeline.js`, `scripts/run-domain-discovery.js`, `package.json`

### 2. CSV Parsing Fix

**Problem:** Naive `line.split(",")` broke on 826/1995 bank names containing commas inside quotes (e.g., `"Apani Sahakari Bank Ltd., Ahmedabad"`). Categories were misdetected as city names.

**Fix:** Created `scripts/utils/parse-csv.js` with quote-aware `parseCSVLine()` and shifted-column recovery (scans rightward for known category names). Used by `run-domain-discovery.js` and `guess-bank-in.js`. The existing `run-batch.js` and `run-pipeline.js` already had correct parsers.

**Files:** `scripts/utils/parse-csv.js` (new), `scripts/run-domain-discovery.js`, `scripts/guess-bank-in.js`

### 3. Gap Analysis Dashboard

**Problem:** No visibility into which banks had which products extracted, or what gaps remained.

**Fix:** Created `scripts/analyze-gaps.js` — a coverage dashboard + gap list generator.

- **Dashboard mode:** Table showing domain/FD/NRE/NRO/FCNR/GIFT coverage per category
- **List mode:** `--list missing-fd`, `--list missing-nri`, `--list manual`, `--list problems`, `--list no-config`, `--list stale` — outputs bank slugs to `output/gaps/<type>.txt`
- **Feeds into:** `run-batch.js --banks output/gaps/missing-fd.txt` for targeted batch runs
- Excludes NSUCB/DCCB by default (`--all` to include)

**Files:** `scripts/analyze-gaps.js` (new)

### 4. Targeted Batch Selection (`--banks` flag)

**Problem:** `run-batch.js` could only filter by `--category`, processing entire categories when only specific banks needed work.

**Fix:** Added `--banks <file|slugs>` flag. Accepts a file with one slug per line (from `analyze-gaps.js --list`) or comma-separated slugs inline. Works in combination with `--category`.

**Files:** `run-batch.js`

### 5. Bank Status Taxonomy

**Problem:** Banks that can't be processed (no website, wholesale-only, etc.) wasted API cost on retries.

**Fix:** Added `status` field to `bank-domains.json` entries. Both `run-batch.js` and `run-pipeline.js` skip banks with skip statuses unless `--include-skipped` is passed.

| Status | Meaning |
|--------|---------|
| `website_not_found` | Searched, no website found (retryable) |
| `no_retail_deposits` | FIs like NABARD — no deposits |
| `wholesale_only` | Corporate/institutional banking only |
| `rates_not_published` | Website exists but rates not displayed publicly |
| `rates_in_images` | Rates as JPG/PNG — needs OCR |
| `site_unreachable` | SSL cert errors, persistent 5xx, WAF blocks |

Also added `domain_source` field: `"discovered"` (auto), `"manual"` (human-verified), `"probed"` (guess-bank-in.js).

See `docs/status-taxonomy.md` for the full taxonomy and upstream BIRD schema mapping.

**Files:** `data/bank-domains.json`, `run-batch.js`, `run-pipeline.js`, `scripts/analyze-gaps.js`, `docs/status-taxonomy.md` (new)

### 6. Azure OpenAI Responses API Version Fix

**Problem:** The Responses API (used for web search in domain discovery) requires API version `2025-03-01-preview`, but the client inherited the Chat Completions version (`2024-12-01-preview`), causing 400 errors.

**Fix:** Separate env var `AZURE_OPENAI_RESPONSES_API_VERSION` with default `2025-03-01-preview`.

**Files:** `lib/azure-openai-responses.js`, `.env.example`

---

## Agent Behavior Fixes

### 7. Playwright Underuse — UA Header + Prompt Fallback

**Problem:** The agent rarely used `run_playwright`. When `fetch_url` returned HTTP 403 (WAF), the prompt said "don't retry" so the agent moved to `web_search` instead of escalating to Playwright. Only 9 Playwright calls across 76 failures.

Additionally, `fetch_url` sent Node.js's default User-Agent header, which WAFs immediately block.

**Fix (3 parts):**
1. Added Chrome User-Agent + Accept headers to `fetch_url`
2. Changed prompt from "don't retry failed fetches" to "403/empty HTML → try `run_playwright` immediately"
3. Added explicit rule: "never classify as manual until Playwright is tried"

**Impact:** HDFC Bank (19 slabs), Bank of India (16 slabs), AU SFB (12+12+12+20 slabs), Karnataka State Apex (7 slabs), and others — all previously blocked — now extract successfully.

**Files:** `lib/tools.js` (UA header), `lib/prompts/fragments.js` (prompt)

### 8. PDF Detection in fetch_url

**Problem:** When the agent fetched a PDF URL via `fetch_url`, the raw binary was sent to the model as text — 520KB of garbage consuming ~475K input tokens ($0.96 wasted on a single Axis Bank IBU call).

**Fix:** Check Content-Type header and URL extension in `fetch_url`. PDFs return a short JSON message directing the agent to use `fetch_pdf` or note the URL for later processing.

Also fixed Playwright to detect PDF URLs before `page.goto()` — previously it crashed with `"Download is starting"`.

**Files:** `lib/tools.js`, `scripts/fetch_rates_playwright.js`

### 9. fetch_pdf Tool

**Problem:** The agent had no way to extract data from PDF rate cards. Both `fetch_url` (rejects PDFs) and `run_playwright` (can't render PDFs) told the agent to "use a PDF parser" but no such tool existed.

**Fix:** Added `fetch_pdf` tool that spawns the existing `scripts/extract_rates_pdf.mjs` (uses `pdfjs-dist`). Downloads PDF from URL, extracts text, parses rate tables, returns structured JSON.

**Files:** `lib/tools.js` (tool definition + implementation)

### 10. Selective Playwright Flags

**Problem:** The agent passed all flags (`--scroll`, `--tabs`, `--accordions`, `--intercept`) to every `run_playwright` call, causing timeouts on complex pages. South Indian Bank timed out at 120s with all flags but completed in 60s with just `--accordions`.

**Fix:** Updated prompt to guide selective flag usage. Added `scraper_notes.playwright_flags` field in bank configs so the agent knows which flags to use per bank.

**Files:** `lib/prompts/fragments.js`

### 11. Accordion/Collapse Panel Extraction

**Problem:** Many banks (South Indian Bank, IndusInd) hide rate tables inside Bootstrap accordion/collapse panels. The Playwright script only extracted `<table>` elements, missing content in collapsed sections.

**Fix (3 parts):**
1. **`--accordions` flag:** Expands collapsed sections via `page.evaluate()` — clicks `.accordion-button.collapsed` elements (skipping nav/header) and force-shows all `.collapse` panels via `classList.add('show')`
2. **Div-grid extraction:** When no `<table>` elements exist, looks for div-based rate grids (`[class*='rate-row']`, `[class*='rate-grid']`, etc.)
3. **Better text parser:** Three regex patterns (tab-separated, inline percentages, single-rate) instead of one rigid pattern

**Impact:** South Indian Bank went from 0 → 14 FD + 11 NRE + 14 NRO + 35 FCNR slabs. IndusInd went from 13 FD only → 14 FD + 5 NRE + 13 NRO + 30 FCNR slabs.

**Files:** `scripts/fetch_rates_playwright.js`, `lib/tools.js` (tool definition)

### 12. Rates-Only Quality Check Fix

**Problem:** In `--rates-only` mode, the agent writes rate files but not a config (config already exists in `output/latest/`). The quality check looked for a config in the run directory, failed, triggered a Tier 2 retry which **deleted the good rate files from Tier 1**, then Tier 2 also failed. Net result: rate files were produced then destroyed.

**Fix:** Skip the two-tier quality check entirely in `rates-only` mode.

**Files:** `run-discovery.js`

### 13. Playwright Spawn Timeout Increase

**Problem:** The 90s `spawnSync` timeout was too short for pages requiring accordion expansion + table extraction (South Indian Bank). The Playwright script's internal page timeout was increased to 60s but the spawn wrapper killed it at 90s.

**Fix:** Increased spawn timeout from 90s to 120s.

**Files:** `lib/tools.js`

---

## Batch Run Results

### Discovery Runs (new banks)

| Batch | Banks | Extracted | Manual/Failed | Cost |
|-------|-------|-----------|---------------|------|
| Payments Banks | 5 | 4 | 1 (Jio PB) | ~$0.56 |
| Foreign Banks | 10+3 retry | 3 (AB, UOB, NatWest) | 7 wholesale | ~$2.10 |
| NSSCBs | 8 | 5 | 3 (site issues) | ~$0.80 |
| IBUs | 16 | 3 (HSBC, PNB, StanChart) | 13 wholesale | ~$2.50 |
| RRBs | 26 | 21 | 5 (SSL cert) | ~$3.20 |

### NRI Expansion Runs

| Batch | Banks | NRE | NRO | FCNR | Cost |
|-------|-------|-----|-----|------|------|
| PSBs | 5 (rates-only) | BoB, BoI gained NRO | — | — | ~$0.55 |
| PVBs | 11 | +6 (Karnataka, KVB, RBL, TMB, IndusInd, SIB) | +5 | +5 | ~$4.20 |
| SFBs | 10 | +5 (AU, ESAF, Jana, Ujjivan, Utkarsh) | +5 | +3 | ~$2.50 |
| FBs | 26 | +10 (Doha, Emirates, HSBC, etc.) | +8 | +6 | ~$8.50 |

### Problem Bank Retries

| Batch | Banks | Newly extracted | Cost |
|-------|-------|-----------------|------|
| WAF/CAPTCHA retry | 18 | HDFC (19), BoI (16), AU SFB (12), Karnataka Apex (7), Jalgaon (8), others | ~$3.50 |
| IndusInd targeted | 1 | 14 FD + 5 NRE + 13 NRO + 30 FCNR | ~$0.88 |
| South Indian targeted | 1 | 14 FD + 11 NRE + 14 NRO + 35 FCNR | ~$0.17 |

---

## Output Structure for Upstream Integration

All output lives in `output/latest/`. Each bank has:

```
output/latest/
├── <bank-code>_config.json      # Website, scraper type, URLs, selectors
├── <bank-code>_rates.json       # Domestic FD rates (variant: "regular")
├── <bank-code>_nre_rates.json   # NRE rates (variant: "nre")
├── <bank-code>_nro_rates.json   # NRO rates (variant: "nro")
├── <bank-code>_fcnr_rates.json  # FCNR rates (variant: "fcnr")
├── <bank-code>_gift_rates.json  # GIFT City rates (variant: "gift", IBU only)
├── <bank-code>.summary.json     # Cost, timing, model, tool call details
└── <bank-code>.log              # Agent output log
```

### Rate File Schema

```json
{
  "bank_code": "state-bank-of-india",
  "bank_name": "State Bank of India",
  "product_type": "FD",
  "variant": "regular",
  "effective_date": "2026-04-01",
  "source_url": "https://sbi.bank.in/...",
  "scraped_at": "2026-04-15T12:00:00Z",
  "extraction_confidence": "high",
  "rate_slabs": [
    {
      "tenure_text": "7 days to 45 days",
      "tenure_min_days": 7,
      "tenure_max_days": 45,
      "rate_general_pct": 3.50,
      "rate_senior_pct": 4.00,
      "rate_super_senior_pct": null,
      "deposit_range": "below_3cr"
    }
  ],
  "warnings": [],
  "errors": []
}
```

### Config File Schema

```json
{
  "bank_code": "state-bank-of-india",
  "bank_name": "State Bank of India",
  "bank_type": "PSB",
  "website": "https://sbi.bank.in",
  "scraper_type": "html_static",
  "rate_page_urls": {
    "fd": "https://sbi.bank.in/...",
    "fd_nre": "https://sbi.bank.in/...",
    "fd_nro": null,
    "fd_fcnr": "https://sbi.bank.in/..."
  },
  "selectors": { "table": "table.rate-table", "rows": "tbody tr" },
  "column_mapping": { "0": "tenure_text", "1": "rate_general_pct", "2": "rate_senior_pct" },
  "scraper_notes": { "framework": "...", "bot_protection": "..." },
  "discovery_metadata": { "discovered_at": "...", "confidence": "high" }
}
```

### bank-domains.json Schema

```json
{
  "bank-code": {
    "domain": "bank.bank.in",
    "domain_source": "discovered",
    "status": null,
    "rate_pages": { "fd": "/interest-rates", "fd_nre": null, "fd_fcnr": "/fcnr" },
    "scraper_type": "html_static",
    "parent_bank_code": null,
    "notes": "..."
  }
}
```

---

## Upstream Integration Notes

### Mapping agent output → BIRD database

| Agent field | BIRD table | BIRD column | Notes |
|-------------|-----------|-------------|-------|
| `bank_code` | `banks` | `code` | Slug — must match exactly |
| `bank_name` | `banks` | `name` | |
| `bank_type` | `banks` | `category` | Map via CLAUDE.md bank type table |
| `website` | `banks` | `website_url` | |
| `rate_page_urls.fd` | `banks` | `rate_page_url` | Primary FD page |
| `scraper_type` | `banks` | `scraper_status` | See `docs/status-taxonomy.md` for mapping |
| `rate_slabs[].rate_general_pct` | `rates` | `rate_pct` | Per-slab row |
| `rate_slabs[].rate_senior_pct` | `rates` | `rate_senior_pct` | |
| `rate_slabs[].tenure_min_days` | `rates` | `tenure_min_days` | |
| `variant` | `rates` | `variant` | `regular`, `nre`, `nro`, `fcnr`, `gift` |
| `effective_date` | `rates` | `effective_date` | |
| `scraped_at` | `rates` | `scraped_at` | |
| `status` (bank-domains.json) | `banks` | `scraper_status` | See taxonomy mapping |

### Import strategy

1. **Read `output/latest/*_config.json`** — upsert into `banks` table by `code`
2. **Read `output/latest/*_rates.json`** (all variants) — upsert into `rates` table, keyed by `(bank_code, variant, tenure_min_days, tenure_max_days)`
3. **Read `data/bank-domains.json`** — update `banks.website_url`, `banks.scraper_status` for banks with status tags
4. **Handle `extraction_confidence: "none"`** — skip import or flag for review
5. **Handle `rate_slabs: []`** — don't overwrite existing rates with empty data

### Known gaps for upstream to handle

- **Yes Bank:** Akamai WAF blocks all automated access — needs manual rate entry or Akamai bypass solution
- **3 PSBs missing NRO:** BoM, CBI, P&S Bank don't list NRO separately — NRO rates likely match domestic FD rates
- **Equitas/Suryoday SFB NRI:** JS-heavy, expand-nri failed — retry with manual URL entry
- **5 RRBs:** SSL cert issues (Assam GB, Chhattisgarh GB, Jharkhand GB) — need cert fix on bank's side
- **Co-op bank NRI:** SUCB/SSCB/NSSCB don't offer NRI products — NRI columns will be null, this is correct

---

## Files Changed (This Session)

### New Files

| File | Purpose |
|------|---------|
| `scripts/analyze-gaps.js` | Coverage dashboard + gap list generator |
| `scripts/utils/parse-csv.js` | Shared CSV parser with quote-aware field handling |
| `docs/status-taxonomy.md` | Status field taxonomy + upstream schema mapping |
| `docs/gap-fill-plan.md` | Original gap-fill plan |
| `docs/gap-fill-impl.md` | This document |

### Modified Files

| File | Changes |
|------|---------|
| `run-discovery.js` | dotenv, skip quality check in rates-only mode, warn-level summary |
| `run-batch.js` | dotenv, `--banks` flag, `--include-skipped`, status skip, const→let fix |
| `run-pipeline.js` | dotenv, `--include-skipped`, status skip check |
| `scripts/run-domain-discovery.js` | dotenv, shared CSV parser, domain_source |
| `scripts/guess-bank-in.js` | Shared CSV parser |
| `scripts/fetch_rates_playwright.js` | `--accordions` flag, div-grid extraction, better text parser, PDF detection, timeout 60s |
| `lib/tools.js` | UA header, PDF detection, `fetch_pdf` tool, `--accordions` support, spawn timeout 120s |
| `lib/prompts/fragments.js` | Playwright fallback strategy, selective flags, fetch_pdf guidance |
| `lib/azure-openai-responses.js` | Separate API version for Responses API |
| `lib/domain-cache.js` | Preserve status + domain_source on merge |
| `.env.example` | Responses API version var |
| `data/bank-domains.json` | 818 entries (was 287), status tags, manual domains, scraper notes |
