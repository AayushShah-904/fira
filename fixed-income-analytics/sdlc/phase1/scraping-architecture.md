# BIRD Scraping Architecture — Rate Discovery & Hybrid Extraction

## Overview

BIRD needs to collect fixed deposit rate data from ~1958 Indian banks. The original plan (Phase 2) envisioned a traditional scraping pipeline — Crawlee/Cheerio/Playwright with per-bank JSON configs and CSS selectors. After testing the rate-discovery-agent with real banks, we pivoted to a **hybrid approach** that uses Claude Code as the primary extraction engine, augmented by lightweight automated change detection.

---

## Why the Hybrid Approach

The rate-discovery-agent successfully extracted rates from 4 diverse banks:

| Bank | Type | Challenge | How Agent Handled It |
|------|------|-----------|---------------------|
| SBI | html_js (Liferay) | Old+new rate columns, Patron (80+) footnote, WeCare scheme | Parsed tables, found footnote with +10 bps rule |
| HDFC | html_js (AEM + CloudFront WAF) | Bot detection, no `<table>` tags, tab-separated divs | Playwright with UA spoofing, text parsing |
| Cosmos | html_static | Special tenors (123d, 16mo), variable senior premiums | Standard HTML table extraction |
| Axis | mixed (JS + PDF) | Rates in 6 separate PDFs, date-stamped URLs | Downloaded PDF, installed pdfjs-dist, parsed text |

Each bank had unique quirks. A config-driven scraper would need per-bank selectors, column mappings, and custom parsers for each quirk — plus ongoing maintenance when sites change. The agent handled all four naturally, adapting to each bank's structure without pre-written configs.

### Trade-off Summary

| Factor | Traditional Pipeline | Agent-Based (Hybrid) |
|--------|---------------------|---------------------|
| Per-bank setup | High (write configs, selectors) | Zero (agent figures it out) |
| Maintenance when sites change | Manual config updates | Zero (agent adapts) |
| Per-run cost | Near zero (HTTP requests) | ~$0.05–0.15 per bank |
| Daily run for 300 banks | Feasible but brittle | Expensive if done daily |
| **Cost with change detection** | N/A | **~$1.50–4.50/week** |

The key insight: most banks don't change rates frequently (monthly or less). Change detection is cheap (fetch + hash comparison). The agent only needs to run when a change is detected.

---

## Architecture Components

### 1. Rate Discovery Agent

**Location:** `rate-discovery-agent/`

**Purpose:** One-time discovery of each bank — find the official website, locate rate pages, classify scraper type, extract initial rates.

**How it works:**
- Claude Code session with `CLAUDE.md` as project instructions
- 5-step workflow: Find website → Locate rate pages → Classify type → Extract rates → Write output
- Uses WebSearch, WebFetch, Playwright (for JS-rendered pages), PDF parsing
- Produces two JSON files per bank: `<slug>_config.json` and `<slug>_rates.json`

**Invocation modes:**
- **Interactive:** `cd rate-discovery-agent && claude` — best for first-time discovery, allows course correction
- **Headless single:** `node run-discovery.js "Bank Name" "Category" "State"`
- **Headless batch:** `node run-batch.js banks.csv --category "Public Sector Bank" --resume`

**Output format:**

Config (`<slug>_config.json`):
```json
{
  "bank_code": "state-bank-of-india",
  "bank_name": "State Bank of India",
  "bank_type": "PSB",
  "website": "https://sbi.bank.in",
  "scraper_type": "html_js",
  "rate_page_urls": { "fd": "https://...", "savings": "https://..." },
  "selectors": { ... },
  "scraper_notes": { "framework": "Liferay", "bot_protection": "none" },
  "discovery_metadata": { "confidence": "high" }
}
```

Rates (`<slug>_rates.json`):
```json
{
  "bank_code": "state-bank-of-india",
  "product_type": "FD",
  "effective_date": "2025-12-15",
  "extraction_confidence": "high",
  "rate_slabs": [ { "tenure_text": "1 year to less than 2 years", "rate_general_pct": 6.80, ... } ],
  "special_schemes": [ { "scheme_name": "Amrit Vrishti", "tenure_days": 444, ... } ]
}
```

**Slug convention:** All components use the same slugify algorithm — lowercase, remove non-word chars, hyphens as separators. Matches the `banks.code` field in the database. Defined in `packages/api/src/lib/helpers.ts` and documented in `CLAUDE.md`.

### 2. Import Pipeline

**Location:** `packages/api/src/db/seed/import-discovery.mjs`

**Purpose:** Read agent output files and update the BIRD database.

**What it does:**
- Reads `*_config.json` files from the agent output directory
- Matches each bank to its database record by slug code
- Updates: `website_url`, `rate_page_url`, `scraper_status`, `discovery_status`, `deposit_insurance`
- If rates were extracted: creates product records, inserts rate slabs
- Reports: matched, unmatched, errors, slab counts

**Usage:**
```bash
# Import all discovery results
node packages/api/src/db/seed/import-discovery.mjs rate-discovery-agent/output/

# Import a single bank
node packages/api/src/db/seed/import-discovery.mjs rate-discovery-agent/output/state-bank-of-india_config.json
```

### 3. Change Detection (Phase 2 — planned)

**Purpose:** Lightweight daily check to detect which bank rate pages have changed, triggering agent re-extraction only when needed.

**Planned approach:**
- Simple HTTP fetch of each discovered bank's rate page URL
- Compare page hash (or content fingerprint) against last known hash
- If changed: queue the bank for agent re-extraction
- If unchanged: skip — no cost incurred

**Why this matters for cost:**
- ~300 discovered banks × daily fetch = ~300 HTTP requests/day (essentially free)
- Typical rate changes: ~30 banks/week
- Agent only runs for changed banks: ~30 × $0.10 = ~$3/week instead of 300 × 7 × $0.10 = $210/week

### 4. Re-extraction Agent (Phase 2 — planned)

**Purpose:** Stripped-down version of the discovery agent for known banks.

**Difference from discovery agent:**
- Skips Steps 1–3 (website search, page location, classification) — already known
- Takes the bank's rate page URL directly
- Extracts rates and compares with previous values
- Flags changes for review

This is simpler, faster, and cheaper than a full discovery run.

### 5. Admin Dashboard

**Location:** Web route `/admin/discovery`, API endpoint `GET /api/admin/discovery-stats`

**Purpose:** Track discovery progress across all 1958 banks.

**Shows:**
- Overall progress bar (discovered / total)
- Breakdown by discovery status (discovered, partial, not_found, pending)
- Breakdown by scraper status (active, no_website, no_rates, manual_only, pending)
- Per-category table with inline progress bars

---

## Data Flow

```
                    ONE-TIME DISCOVERY
                    ==================

  RBI Bank List (CSV, 1958 banks)
        │
        ▼
  rate-discovery-agent (Claude Code)
  ├── WebSearch → find bank website
  ├── WebFetch → locate rate pages
  ├── Playwright → handle JS-rendered pages
  ├── PDF parsing → handle PDF rate cards
  └── Output: *_config.json + *_rates.json
        │
        ▼
  import-discovery.mjs
  ├── Match bank by slug
  ├── Update banks table (website, status)
  └── Insert rate_slabs (initial seed data)
        │
        ▼
  BIRD Database (D1/SQLite)


                    ONGOING EXTRACTION (planned)
                    ============================

  Change Detector (daily cron, HTTP fetch + hash)
        │
        ├── No change → skip (free)
        │
        └── Changed → queue for re-extraction
                │
                ▼
          Re-extraction Agent (Claude Code, simplified)
          ├── Fetch known URL
          ├── Extract rates
          └── Compare with previous
                │
                ▼
          import pipeline → BIRD Database
```

---

## Batch Execution

### Running Discovery by Tier

```bash
cd rate-discovery-agent

# Tier 1: PSBs + PVBs (33 banks, nearly 100% success expected)
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Public Sector Bank"
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Private Sector Bank (Indian)"

# Tier 2: SFBs + Payments Banks (17 banks)
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Small Finance Bank"
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Payments Bank"

# Tier 3: Scheduled Co-ops + Foreign Banks + RRBs (148 banks)
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Scheduled Urban Co-operative Bank"
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Foreign Bank"
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Regional Rural Bank"

# Tier 4: NSUCBs in chunks (1392 banks, most will have no website)
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Non-Scheduled Urban Co-operative Bank" --limit 50
```

### Resume After Failures

```bash
# Re-run same command with --resume — skips banks that already have output
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Foreign Bank" --resume

# Increase timeout for banks that need more time
node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Foreign Bank" --resume --timeout 600
```

### Batch Results

Each batch produces a category-specific results file:
- `output/_batch_results_public-sector-bank.json`
- `output/_batch_results_foreign-bank.json`
- etc.

---

## Observations from Initial Discovery Runs

### Bank Website Patterns

- **PSBs:** All have websites, most use Liferay or custom portals, HTML tables common
- **Large PVBs:** Modern JS-rendered sites (React/AEM), often behind CloudFront WAF, require Playwright
- **SFBs:** Generally good websites, competitive rates (higher than PSBs/PVBs)
- **Co-operatives (SUCB):** Mixed — some have clean static HTML, many have basic or no websites
- **Foreign Banks:** Most don't offer INR deposit products to retail customers in India — high failure rate expected
- **NSUCBs/DCCBs:** Vast majority (~90%+) will have no website or no rate page

### Common Challenges

1. **Bot protection:** CloudFront WAF (HDFC, likely others) — solved with Playwright + UA spoofing + webdriver flag removal
2. **PDF rate cards:** Axis Bank has rates in PDFs, not HTML — agent can download and parse
3. **JS-rendered pages:** SBI (Liferay), HDFC (AEM) — Playwright handles these
4. **Date-stamped PDF URLs:** Axis Bank PDFs contain dates in URL (`domestic-fixed-deposits-27-march-26.pdf`) — URL changes with each rate revision
5. **Footnote-based rules:** SBI Patron (80+) rate is "+10 bps" noted below the table, not in the table itself
6. **Multiple tables per page:** Retail vs bulk deposit thresholds (SBI, HDFC, Axis all have this)

### Data Quality Notes

- Agent sometimes falls back to aggregator sources when bank's own site fails — CLAUDE.md explicitly prohibits this but the instruction needs reinforcement
- Timeout on complex banks (Axis took very long due to PDF download + pdfjs-dist install at runtime)
- Dependencies (`playwright`, `pdf-parse`) should be pre-installed, not installed during discovery runs
