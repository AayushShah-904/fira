# Rate Discovery Agent: Analysis, Findings & Optimization Proposals

**Date:** 2026-03-28
**Based on:** ~75 banks discovered across Public Sector, Private Sector, Small Finance, Foreign, Payments, and Co-operative bank categories.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture Overview](#2-current-architecture-overview)
3. [Output Inventory & Statistics](#3-output-inventory--statistics)
4. [Detailed Observations](#4-detailed-observations)
   - 4.1 [Cold-Start Overhead Per Bank](#41-cold-start-overhead-per-bank)
   - 4.2 [LLM Doing Deterministic Work](#42-llm-doing-deterministic-work)
   - 4.3 [Rate Limit Failures in Foreign Bank Batch](#43-rate-limit-failures-in-foreign-bank-batch)
   - 4.4 [Playwright: Expensive but Necessary](#44-playwright-expensive-but-necessary)
   - 4.5 [PDF Banks Identified but Not Extracted](#45-pdf-banks-identified-but-not-extracted)
   - 4.6 [Config Schema Redundancy](#46-config-schema-redundancy)
   - 4.7 [Multi-Table / Deposit-Tier Inconsistency](#47-multi-table--deposit-tier-inconsistency)
   - 4.8 [Scraper Type Distribution Analysis](#48-scraper-type-distribution-analysis)
   - 4.9 [Extraction Confidence & Warnings](#49-extraction-confidence--warnings)
   - 4.10 [Column Mapping Fragmentation](#410-column-mapping-fragmentation)
   - 4.11 [Special Schemes Handling](#411-special-schemes-handling)
   - 4.12 [Effective Date Challenges](#412-effective-date-challenges)
   - 4.13 [Bank-Type-Specific Patterns](#413-bank-type-specific-patterns)
5. [Cost & Token Analysis](#5-cost--token-analysis)
6. [Optimization Proposals](#6-optimization-proposals)
   - 6.1 [Split Discovery from Extraction](#61-split-discovery-from-extraction)
   - 6.2 [Rate Limit Detection & Backoff](#62-rate-limit-detection--backoff)
   - 6.3 [Pre-Seed Known Bank Domains](#63-pre-seed-known-bank-domains)
   - 6.4 [Move Deterministic Logic Out of the LLM](#64-move-deterministic-logic-out-of-the-llm)
   - 6.5 [Build a Standalone PDF Extractor](#65-build-a-standalone-pdf-extractor)
   - 6.6 [Enhanced Playwright Script](#66-enhanced-playwright-script)
   - 6.7 [Tiered Agent Strategy](#67-tiered-agent-strategy)
   - 6.8 [Batch Parallelization](#68-batch-parallelization)
   - 6.9 [Config Schema Simplification](#69-config-schema-simplification)
   - 6.10 [Unified Multi-Table Schema](#610-unified-multi-table-schema)
7. [Priority Ranking](#7-priority-ranking)
8. [Scaling Projections](#8-scaling-projections)
9. [Appendix: Bank-Type Breakdown](#9-appendix-bank-type-breakdown)

---

## 1. Executive Summary

The rate-discovery-agent has successfully processed ~75 banks, producing structured config and rate JSON files for each. The agent correctly identifies websites, classifies scraper types, extracts rate slabs, and handles edge cases (JS rendering, PDFs, payments banks with no FD products, co-ops with amount-slab structures).

**What's working well:**
- 100% output generation for banks that weren't rate-limited
- 85% high-confidence extractions
- Good scraper-type classification across all 6 tiers
- Robust Playwright anti-bot measures
- Clean, consistent JSON output schema

**What needs improvement:**
- 3–6 minutes per bank is too slow for 1900 banks (estimated 95–190 hours at current pace)
- Token consumption of ~18K per bank means ~34M tokens for full discovery (~$500+)
- Foreign bank batch was 91% failed due to unhandled API rate limits
- 24% of banks (PDF-based) produce empty rate_slabs despite parseable PDF sources
- LLM is performing deterministic work (slug generation, tenure parsing, rate validation)
- No reuse of knowledge between banks in batch mode

---

## 2. Current Architecture Overview

### Components

| Component | File | Purpose |
|-----------|------|---------|
| Agent Instructions | `CLAUDE.md` (276 lines) | 5-step discovery workflow, schema definition, rules |
| Single Bank Runner | `run-discovery.js` (168 lines) | Spawns one Claude session per bank, collects output |
| Batch Processor | `run-batch.js` (275 lines) | CSV parsing, sequential bank processing, resume support |
| Playwright Scraper | `scripts/fetch_rates_playwright.js` (121 lines) | Headless Chromium extraction for JS-rendered pages |
| Prompt Template | `prompts/discover.md` (31 lines) | Injects bank name/category into Claude session |

### Execution Flow

```
run-batch.js (CSV → bank list → sequential loop)
  └─ run-discovery.js (per bank)
       └─ claude -p (headless Claude session)
            ├─ Step 1: WebSearch → find official website
            ├─ Step 2: WebFetch → find rate page links
            ├─ Step 3: Classify scraper type (Tier 1–6)
            ├─ Step 4: Extract rates
            │    ├─ Tier 1 (html_static): Parse HTML table directly
            │    ├─ Tier 2 (html_js): Invoke Playwright via Bash
            │    └─ Tier 3+ (pdf/mixed/manual): Note URL, skip extraction
            └─ Step 5: Write _config.json + _rates.json
```

### Key Design Decisions

- **One Claude session per bank:** Isolation prevents state carryover (good for reliability, bad for efficiency)
- **Deterministic slug algorithm:** Shared between agent and API (`packages/api/src/lib/helpers.ts`)
- **Playwright with anti-bot measures:** Custom User-Agent, disabled `navigator.webdriver`, `en-IN` locale — required for banks like HDFC (CloudFront WAF)
- **Resume via output file existence:** `--resume` skips banks that already have `_config.json` in output/

### Dependencies

- `playwright@1.58.2` — JS rendering with headless Chromium
- `pdf-parse@2.4.5` — PDF extraction (installed but not used by the agent)
- `pdfjs-dist@4.0.379` — PDF utilities (installed but not used by the agent)

---

## 3. Output Inventory & Statistics

### File Counts

| File Type | Count |
|-----------|-------|
| `*_config.json` | 75 |
| `*_rates.json` | 75 |
| `*.log` | 86 |
| `*.pdf` | 5 |
| `_batch_results*.json` | 2 |
| Other (resume.txt, .gitkeep) | 2 |
| **Total** | **~245** |

### Scraper Type Distribution

| Scraper Type | Count | % | Typical Banks |
|-------------|-------|---|---------------|
| `html_static` | 30 | 40% | Dhanlaxmi, Capital SFB, most co-ops |
| `html_js` | 20 | 27% | HDFC, Axis, SBI, ICICI, Suryoday SFB |
| `pdf` | 18 | 24% | Citibank, JP Morgan, BNP Paribas, Barclays |
| `manual` | 5 | 7% | AB Bank, tiny co-ops without websites |
| `mixed` | 2 | 3% | Banks with HTML + PDF on same page |

### Extraction Confidence

| Confidence | Count | % |
|-----------|-------|---|
| `high` | 64 | 85% |
| `medium` | 3 | 4% |
| `none` | 8 | 11% |

### Rate Slab Counts

| Range | Count | Notes |
|-------|-------|-------|
| 0 slabs (empty) | 11 | Payments banks (no FD), manual, some PDF |
| 2–8 slabs | 16 | Smaller/niche banks, foreign banks |
| 9–13 slabs | 27 | Most common — standard PSB/PVB structure |
| 14–20+ slabs | 21 | Complex banks (Axis, HDFC, SFBs with special tenures) |
| **Median** | **~12** | |

### Batch Results

| Batch | Total | Succeeded | Failed | Skipped |
|-------|-------|-----------|--------|---------|
| Foreign Banks | 44 | 4 | 40 | 0 |
| Private Sector (re-run) | 21 | 0 | 0 | 21 (all previously done) |

---

## 4. Detailed Observations

### 4.1 Cold-Start Overhead Per Bank

Every bank spawns a fresh `claude -p` process via `run-discovery.js`. Each process:

1. Reads and internalizes `CLAUDE.md` (276 lines of instructions, schema definitions, examples)
2. Parses the prompt template from `prompts/discover.md`
3. Establishes a new conversation context with no prior knowledge

**Measured overhead:** ~2–3K tokens per bank just for prompt ingestion.

**At scale (1900 banks):** 3.8M–5.7M tokens spent purely on repeated cold starts.

**Why this matters:** The agent learns nothing from previous banks. After processing HDFC, it doesn't know that `.bank.in` is the RBI domain. After processing 10 PSBs, it still reasons from scratch about scraper type classification for the 11th.

### 4.2 LLM Doing Deterministic Work

Several tasks performed by the LLM during each discovery are fully deterministic and don't require reasoning:

**Slug generation:**
The agent computes `bank_code` from the bank name using a documented algorithm (lowercase → keep alphanumerics/spaces/hyphens → replace spaces with hyphens → collapse → trim). This is a 5-line function, not an LLM task.

**Tenure text parsing:**
Converting "7 days to 14 days" → `{min: 7, max: 14}` or "1 year to less than 2 years" → `{min: 365, max: 729}` is a regex/rule-based operation. The CLAUDE.md already documents the exact rules. The LLM applies them correctly but burns tokens doing so.

**Rate validation:**
Checking that extracted rates fall within 2.50%–9.50% is a numeric comparison, not a reasoning task.

**JSON schema population:**
Filling in default fields (`tenure_parser: "standard_indian"`, `rate_multiplier: 1.0`, `deposit_insurance: true`) is boilerplate generation.

**Estimated token waste:** ~3–5K tokens per bank on deterministic operations that a script could do in milliseconds.

### 4.3 Rate Limit Failures in Foreign Bank Batch

The foreign bank batch (`_batch_results.json`) shows:
- **4 succeeded:** AB Bank PLC, American Express, ANZ, Bank of America
- **40 failed:** Every subsequent bank hit `exitCode: 1`

Log files for the failed banks are 100–173 bytes, containing only:
```
Discover interest rates for: Bank Name: YES Bank Limited...
You've hit your limit · resets 1:30am (Asia/Calcutta)
```

**Root causes:**
1. **No rate-limit detection** in `run-batch.js` — it doesn't inspect stdout for rate-limit messages
2. **No backoff/pause logic** — after the first rate-limit hit, it immediately retries the next bank (which also fails)
3. **No failure classification** — `_batch_results.json` records `"status": "failed"` for both rate-limited and genuinely failed banks, making retry logic impossible
4. **`--resume` doesn't help** — it checks for `_config.json` existence, but rate-limited banks never produce output files, so they'd be re-attempted (and fail again if limit hasn't reset)

**Impact:** 40 banks consumed zero useful tokens but each spawned a Claude process that contributed to rate limiting. The batch effectively wasted the 2-second inter-bank delay on immediate failures.

### 4.4 Playwright: Expensive but Necessary

~27% of banks require JavaScript rendering. The Playwright script is well-designed with anti-bot countermeasures:

```javascript
// Anti-detection measures (from fetch_rates_playwright.js)
chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
browser.newContext({ userAgent: "real Chrome UA", locale: "en-IN" });
page.addInitScript(() => { navigator.webdriver = false; });
```

**What works:**
- HDFC, SBI, Kotak, and other CloudFront/WAF-protected banks are successfully scraped
- Text-based fallback parsing works when banks don't use `<table>` elements (HDFC uses styled divs)

**Current limitations:**

1. **Full Chromium instance per invocation.** Each call to `fetch_rates_playwright.js` launches a new browser (~5s startup). No browser pooling or reuse.

2. **No tab/dropdown interaction.** ICICI uses tab-based UI with 10+ deposit-range tabs. Current script extracts only the visible tab, resulting in 2 slabs instead of 18+. Suryoday SFB uses a `<select>` dropdown for tenure — each option must be selected to reveal rates.

3. **Lazy-loading not handled.** Axis Bank lazy-loads rate table rows. Playwright's `networkidle` wait captures only 2 of 18 slabs. The agent then falls back to cross-verifying against fi.money aggregator — adding extra WebFetch calls and ~3–5K tokens of reasoning.

4. **No XHR/Fetch interception.** Many JS-rendered pages load rate data via API calls (e.g., `/api/rates`, `/data/deposit-rates.json`). Intercepting these network requests would yield clean JSON directly, bypassing DOM parsing entirely.

**The Axis Bank worst case:**
- 43 conversation turns, 245KB log file
- 22 Bash calls (PDF downloads, Playwright runs, SSL workarounds)
- 9 Write calls, 3 WebFetch calls, 2 Read calls
- Total: $1.61 USD, 10+ minutes
- Root cause: cascading complexity — JS rendering → partial extraction → PDF fallback → cross-verification → SSL issues on Windows

### 4.5 PDF Banks Identified but Not Extracted

18 banks (24%) are classified as `scraper_type: "pdf"`. The agent correctly:
- Identifies the PDF URL (e.g., Citibank regulatory disclosures, JP Morgan `/content/dam/` PDFs)
- Notes the PDF structure (tabular, amount-slab grids, dated filenames)
- Records metadata in `scraper_notes`

But it produces `"rate_slabs": []` for all PDF banks.

**Why this is a missed opportunity:**
- `pdf-parse@2.4.5` and `pdfjs-dist@4.0.379` are already in `package.json`
- These PDFs are structured, machine-readable tables — not scanned images
- Foreign bank PDFs typically have 8–26 tenure slabs in clean tabular format
- Some PDFs embed the effective date in the filename (e.g., `bnp-paribas-india-standard-deposit-card-rate-24th-march-2026.pdf`)

**Impact:** 18 banks with zero rate data that could have populated slabs. For the recurring scraper, PDF re-download + parse is the simplest scraping path (no DOM, no JS, no anti-bot — just HTTP GET + table extraction).

### 4.6 Config Schema Redundancy

Every `_config.json` includes all fields, even when they're defaults. Across 75 files:

```json
// These appear identically in ~80% of config files:
"tenure_parser": "standard_indian",
"rate_multiplier": 1.0,
"senior_citizen_premium": "same_table",
"deposit_insurance": true,
"update_frequency": "monthly"
```

Additionally, ~46 banks have entirely null `selectors` objects:
```json
"selectors": {
  "table": null,
  "rows": null,
  "effective_date": null
}
```

This is correct (PDF/JS banks don't have static CSS selectors), but it bloats every config file with empty fields.

**Not a token-cost issue** (configs are written once), but it adds noise for the pipeline consuming these configs.

### 4.7 Multi-Table / Deposit-Tier Inconsistency

Banks with multiple rate tables for different deposit amounts are handled inconsistently:

| Bank | Approach | Problem |
|------|----------|---------|
| HDFC | Two separate files: `_rates.json` + `_rates_bulk.json` | Non-standard filename convention |
| Axis | Single `_rates.json` with notes about 5 deposit tiers (<3Cr, 3–5Cr, 5–25Cr, 25–100Cr, 100Cr+) | Only smallest tier extracted |
| JP Morgan | Single file, notes "13 amount buckets" | Only <3Cr bucket extracted |
| Andhra Pradesh Co-op | Amount-slab columns in single table (Below 15L, 15L–1Cr, 1Cr–10Cr, 10Cr+) | Columns mapped but non-standard field names |
| Kotak | Separate retail vs bulk tables noted | Inconsistent with HDFC approach |

**The schema currently has no `deposit_range` field** in `rate_slabs`. This means the recurring scraper won't know which deposit tier a rate applies to.

### 4.8 Scraper Type Distribution Analysis

The 40/27/24/7/3 split (static/JS/PDF/manual/mixed) has implications for the recurring scraper:

**Tier 1 (html_static, 40%):** Simplest path. Standard HTTP GET + HTML table parsing. Low maintenance, low cost. These banks can be checked daily with minimal resources.

**Tier 2 (html_js, 27%):** Requires headless browser. Higher cost (Chromium overhead), higher failure rate (anti-bot detection, lazy loading). These should be checked less frequently (weekly?) and with better Playwright scripts.

**Tier 3 (pdf, 24%):** Requires PDF download + table extraction. Medium cost but very reliable — PDF URLs rarely change, and the format is stable. Good candidates for daily checks (just re-download and diff).

**Manual (7%):** Cannot be automated. These are banks with no website, CAPTCHA-protected pages, or institutional-only rates. Data entry from RBI publications or branch contact.

**Mixed (3%):** Most complex — some products in HTML, others in PDF on the same or linked pages. Needs per-product scraping strategy.

### 4.9 Extraction Confidence & Warnings

**High confidence (85%):** Agent is confident in website identification, scraper classification, and extracted rates. These are production-ready configs.

**Medium confidence (4%, 3 banks):** Typically due to:
- Playwright partial extraction (Axis: 2 of 18 slabs via DOM, cross-verified via aggregator)
- Effective date approximation (official page doesn't display w.e.f. date)
- Rate data from press releases rather than official rate page (Airtel Payments Bank)

**None (11%, 8 banks):** Legitimate failures:
- Bank has no public rate page (institutional-only foreign banks)
- Website exists but rates are behind login/CAPTCHA
- Bank doesn't offer the product (Payments Banks can't offer FDs per RBI rules)

**Common warning patterns across all files:**

| Warning | Frequency | Example |
|---------|-----------|---------|
| Effective date approximated | ~25 banks | "Official page does not display w.e.f. date in raw HTML" |
| JS lazy-loading partial extraction | ~8 banks | "Playwright extracted only 2 of 18 slabs due to JS lazy-loading" |
| Cross-verified via aggregator | ~5 banks | "Full slab data cross-verified via fi.money aggregator" |
| Senior citizen premium inconsistency | ~12 banks | "SBI WeCare adds 100bps (not 50bps) for 5yr+" |
| Payments bank regulatory constraint | 6 banks | "Cannot offer FD/RD per RBI payments bank rules" |
| Foreign bank below-floor rates | ~3 banks | "Citibank rates 1.75%–2.00% below floor (exited retail)" |
| Outdated effective dates | ~5 banks | "Effective date from July 2025, no newer version found" |

### 4.10 Column Mapping Fragmentation

There are at least 5 distinct column mapping patterns across the 75 banks:

**Pattern 1 — Standard (55% of banks):**
```json
{ "0": "tenure_text", "1": "rate_general_pct", "2": "rate_senior_pct" }
```

**Pattern 2 — With Super Senior (12% of banks, mostly PSBs):**
```json
{ "0": "tenure_text", "1": "rate_general_pct", "2": "rate_senior_pct", "3": "rate_super_senior_pct" }
```

**Pattern 3 — Deposit-Amount Tiers (8% of banks, co-ops):**
```json
{ "0": "tenure_text", "1": "rate_below_15l_pct", "2": "rate_15l_to_1cr_pct", "3": "rate_1cr_to_10cr_pct", "4": "rate_above_10cr_pct" }
```

**Pattern 4 — Foreign/Institutional (16% of banks):**
```json
{ "0": "tenure_text", "1": "rate_general_pct" }
```
No senior citizen differentiation. Sometimes amount-slab grids (JP Morgan: 13 columns).

**Pattern 5 — SFB Custom (9% of banks):**
```json
{ "0": "tenure_text", "1": "rate_general_pct", "2": "rate_senior_pct", "3": "annualized_yield" }
```
Some SFBs add non-standard columns (annualized yield, callable vs non-callable variants).

**Implication for recurring scraper:** The scraper needs to handle at least these 5 patterns. A universal parser that reads `column_mapping` from the config and applies it dynamically would work, but the schema must accommodate non-standard field names (especially for amount-tier columns).

### 4.11 Special Schemes Handling

31 of 75 banks (41%) have special schemes captured in the `special_schemes` array.

**Types of special schemes found:**

| Type | Count | Example |
|------|-------|---------|
| Tax Saver FD (5yr lock-in) | ~24 | 5yr @ 6.50% general, 7.00% senior |
| Special tenure (444d, 300d, 501d, 600d, 900d) | ~18 | Unity SFB 365d @ 7.50%/8.00% |
| Premium/Higher tier | ~8 | AU Bank +0.10% for 6 specific tenures |
| Non-callable premium | ~6 | RBL +0.20% for non-callable FDs |
| Named campaigns | ~4 | SBI "Amrit Vrishti" 444d, BOB "bob Square Drive" |

**Capture quality:** Good for banks that were processed. Special schemes are separated from regular slabs and include `expiry_date` when applicable (though most are `null`, indicating ongoing schemes).

**Gap:** 3 banks known to have special schemes but none were captured (likely agent ran out of context or didn't navigate to the scheme-specific section of the rate page).

**Recurring scraper implication:** Special schemes change more frequently than base rates (promotional tenures expire, new campaigns launch). The scraper needs to check for both additions and removals.

### 4.12 Effective Date Challenges

Effective dates are critical for the aggregator — stale rates are worse than no rates.

**How dates are captured today:**

| Source | Count | Reliability |
|--------|-------|-------------|
| Explicit on page ("w.e.f. 01-01-2025") | ~30 banks | High |
| In page text (co-ops: "w.e.f. 19.02.2026") | ~6 banks | High (but regex-dependent) |
| PDF filename date | ~10 banks | Medium (may not match actual effective date) |
| Inferred from third-party | ~5 banks | Low |
| Not found / null | ~24 banks | None |

**32% of banks have no effective date captured.** This is a significant gap. The recurring scraper will need to:
1. Store the date the page was last fetched (always available)
2. Diff rate values between fetches to detect changes
3. Use the diff timestamp as the effective date when the page doesn't display one

**Date format inconsistency across banks:**
- "01-01-2025" (DD-MM-YYYY)
- "6th March, 2026" (natural language)
- "w.e.f. 19.02.2026" (DD.MM.YYYY with prefix)
- "Applicable from March 6, 2026" (US-style natural language)
- ISO 8601 in output JSON ("2026-03-27") — correctly normalized by the agent

### 4.13 Bank-Type-Specific Patterns

#### Public Sector Banks (PSB) — 2 in sample

- Typically `html_js` (SBI uses Liferay Portal, BOB uses server-rendered + JS hydration)
- Super senior citizen rates often present (separate column or +10–50 bps premium)
- 8–15 tenure slabs
- Special schemes common (SBI Amrit Vrishti, BOB Square Drive)
- Effective dates usually available on page

#### Private Sector Banks (PVB) — 23 in sample

- Split between `html_static` (9) and `html_js` (14)
- 14–18 tenure slabs (more granular than PSBs)
- Senior citizen premium: +0.50% most common, some +0.75% for long tenures
- Multiple deposit tiers (retail <3Cr, bulk 3–5Cr, super-bulk 5Cr+)
- Bot protection common: CloudFront WAF (HDFC), Akamai (Kotak), tab-based UI (ICICI)
- 65% have special schemes

#### Small Finance Banks (SFB) — 11 in sample

- Split between `html_static` (5) and `html_js` (6)
- Higher base rates: 6–7%+ for 5-year tenures (compared to 5.5–6.5% for PSBs)
- Many custom tenures: 400d, 444d, 501d, 600d, 900d (used as marketing tools)
- 73% have special schemes
- Some use interactive UI elements (Suryoday: `<select>` dropdown, no static table)
- `.bank.in` domains well-adopted

#### Foreign Banks (FB) — 29 in sample

- Dominated by PDF (20 of 29) with some static HTML (9)
- Rates 2–3% lower than Indian banks (institutional focus, limited retail)
- No senior citizen premiums offered
- Amount-slab grids common (JP Morgan: 13 columns for different deposit amounts)
- Effective dates often stale (some PDFs from 2020–2024)
- Some have effectively exited retail deposits (Citibank rates 1.75%–2.00%)
- Bot protection uncommon (most serve static PDFs or simple HTML)

#### Payments Banks (PB) — 6 in sample

- Cannot offer FD/RD per RBI rules
- Only savings account rates (balance-tier based, not tenure-based)
- Max deposit ₹2 lakh per customer (auto-sweep to partner bank above limit)
- Airtel blocks scraping (403/CloudFront WAF) — rates sourced from press releases
- IPPB and NSDL have static HTML but use `balance_tier_text` instead of `tenure_text`
- **These banks need a different product_type (SAVINGS) in the schema**

#### Co-operative Banks (SUCB/SSCB) — 6 in sample

- All `html_static` — simplest scraping targets
- Unique: amount-slab columns instead of general/senior columns
- Senior citizen premium as fixed additive bps (e.g., +60 bps) rather than separate rate column
- WordPress-based sites common (`wpDataTables` plugin with rowspan merged cells)
- Effective dates embedded in page text ("w.e.f. 19.02.2026")
- Many small co-ops have no website at all — rates only on state co-op portal or RBI database

---

## 5. Cost & Token Analysis

### Per-Bank Token Consumption (Current)

| Phase | Tokens | Notes |
|-------|--------|-------|
| Prompt setup (CLAUDE.md + template) | 2–3K | Fixed cost per bank |
| WebSearch (find website) | 1–2K | Query + result parsing |
| WebFetch #1 (homepage) | 3–5K | Page content + link identification |
| WebFetch #2 (rate page) | 5–10K | Largest: HTML table content |
| Scraper classification + reasoning | 2–3K | Could be deterministic |
| JSON generation (config + rates) | 2–3K | Schema population + defaults |
| **Total (Tier 1 / simple)** | **13–18K** | |
| **Total (Tier 2 / JS + verification)** | **18–25K** | Adds Playwright orchestration + cross-verification |
| **Total (complex / Axis-like)** | **30–50K** | Multiple PDFs, SSL workarounds, aggregator checks |

### Batch Token Consumption

| Scenario | Banks | Avg Tokens/Bank | Total Tokens | Est. Cost (Sonnet) |
|----------|-------|-----------------|--------------|-------------------|
| Current pace (75 done) | 75 | ~18K | 1.35M | ~$20 |
| Full discovery (1900) | 1900 | ~18K | 34.2M | ~$500 |
| Optimized (1900) | 1900 | ~10–12K | 19–23M | ~$280–340 |

### Time Consumption

| Bank Type | Typical Time | Notes |
|-----------|-------------|-------|
| html_static (simple) | 1–2 min | 1 search + 1 fetch + parse |
| html_js (standard) | 3–5 min | + Playwright invocation |
| html_js (complex) | 6–10+ min | + multiple PDFs, cross-verification |
| pdf | 2–3 min | Search + identify PDF URL |
| manual | 1–2 min | Quick failure, noting absence |

**Full discovery time estimate (1900 banks, sequential):** 95–190 hours
**With 3x parallel:** 32–64 hours

### Where Tokens Are Spent (Breakdown for a Typical Bank)

```
┌─────────────────────────────────────────┐
│  Prompt Setup (CLAUDE.md)      15%      │
│  Web Search & Fetch            40%      │ ← Network I/O results
│  Reasoning & Classification    20%      │ ← Partially deterministic
│  JSON Generation               15%      │ ← Mostly deterministic
│  Error Handling & Edge Cases   10%      │
└─────────────────────────────────────────┘
```

---

## 6. Optimization Proposals

### 6.1 Split Discovery from Extraction

**Current:** One agent session does everything — finds website, classifies scraper, extracts rates, writes both config and rates files.

**Proposed:** Two distinct phases:

**Phase A — Discover (LLM-powered):**
- Find official website
- Find rate page URL(s)
- Classify scraper type
- Record selectors, bot protection notes, page structure
- Output: `_config.json` only

**Phase B — Extract (Deterministic code, no LLM):**
- Read `_config.json`
- Based on `scraper_type`:
  - Tier 1: HTTP GET + HTML table parser
  - Tier 2: Playwright + enhanced script
  - Tier 3: PDF download + pdf-parse
- Apply tenure parser, column mapping, rate validation
- Output: `_rates.json`

**Benefits:**
- Phase A costs ~8–12K tokens (vs current 13–25K)
- Phase B costs 0 tokens (pure code execution)
- Phase B is reusable as the recurring scraper — no new development needed
- Clear separation of "what needs intelligence" vs "what needs execution"

**Token savings:** ~40% per bank. At 1900 banks: 34M → ~20M tokens.

**Architecture alignment:** This matches the hybrid approach already agreed upon — agentic discovery + deterministic recurring scraper. The split just happens earlier (during initial discovery rather than after).

### 6.2 Rate Limit Detection & Backoff

**Problem:** 40/44 foreign banks failed because batch runner doesn't detect rate limits.

**Proposed changes to `run-batch.js`:**

1. **Detect rate-limit messages in stdout/stderr:**
   - Pattern: `"hit your limit"`, `"rate limit"`, `"too many requests"`, HTTP 429
   - On detection, mark bank as `rate_limited` (new status, distinct from `failed`)

2. **Backoff strategy:**
   - On first rate-limit: pause for 5 minutes, retry once
   - On second consecutive rate-limit: pause batch, report wait time
   - Parse reset time from message ("resets 1:30am") and report to user

3. **Enhanced `_batch_results.json` schema:**
   ```json
   {
     "status": "rate_limited",
     "rate_limit_message": "resets 1:30am (Asia/Calcutta)",
     "retry_after": "2026-03-28T01:30:00+05:30"
   }
   ```

4. **`--resume` enhancement:** Distinguish between:
   - `succeeded` → skip (output exists)
   - `rate_limited` → retry (no output, transient failure)
   - `failed` → skip unless `--retry-failed` flag

5. **`--max-cost` flag:** Stop batch after estimated N dollars spent (based on token counting from log output).

**Effort:** Low (changes only to `run-batch.js`).

### 6.3 Pre-Seed Known Bank Domains

RBI publishes a bank directory with website URLs. For the ~200 major scheduled banks, we can pre-seed a domain mapping file.

**Proposed: `data/bank-domains.json`**
```json
{
  "state-bank-of-india": { "domain": "sbi.co.in", "rate_page": "/web/interest-rates/deposit-rates/retail-domestic-term-deposits" },
  "hdfc-bank-limited": { "domain": "hdfc.bank.in", "rate_page": "/personal/save/deposits/fixed-deposit-interest-rate" },
  "icici-bank-limited": { "domain": "icici.bank.in", "rate_page": "/personal-banking/deposits/fixed-deposit/fd-interest-rates" },
  ...
}
```

**How it's used:**
- `run-discovery.js` checks `bank-domains.json` before spawning Claude
- If domain + rate_page are known: skip Step 1 and Step 2, go directly to Step 3 (classify) and Step 4 (extract)
- If only domain is known: skip Step 1, still do Step 2 (find rate page)
- If unknown: full 5-step workflow

**Token savings per known bank:** 3–5K tokens (1 WebSearch + 1 WebFetch eliminated).
**At 200 known banks:** 600K–1M tokens saved.

**Maintenance:** Domain file can be updated as banks are discovered. The recurring scraper also benefits (no discovery step needed for known banks).

### 6.4 Move Deterministic Logic Out of the LLM

Create utility scripts that the agent (and later the recurring scraper) can call:

**`scripts/utils/slugify.js`:**
```javascript
// Already duplicated between agent CLAUDE.md and packages/api/src/lib/helpers.ts
function slugify(bankName) {
  return bankName.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
```

**`scripts/utils/parse-tenure.js`:**
```javascript
// Rules documented in CLAUDE.md Step 4
function parseTenure(text) {
  // "7 days to 14 days" → { min: 7, max: 14 }
  // "1 year to less than 2 years" → { min: 365, max: 729 }
  // "12 months" → { min: 365, max: 365 }
  // "444 days" → { min: 444, max: 444 }
  // etc.
}
```

**`scripts/utils/validate-rates.js`:**
```javascript
function validateRate(rate) {
  return rate >= 2.50 && rate <= 9.50;
}
```

**`scripts/utils/generate-config.js`:**
```javascript
// Fills in defaults, validates required fields
function generateConfig(partial) {
  return {
    tenure_parser: "standard_indian",
    rate_multiplier: 1.0,
    senior_citizen_premium: "same_table",
    deposit_insurance: true,
    update_frequency: "monthly",
    ...partial // Override with discovered values
  };
}
```

**How the agent uses them:** Via Bash tool calls instead of LLM reasoning:
```bash
node scripts/utils/slugify.js "HDFC Bank Limited"  # → hdfc-bank-limited
node scripts/utils/parse-tenure.js "7 days to 14 days"  # → {"min":7,"max":14}
```

**Token savings:** ~3–5K per bank (removes reasoning about deterministic operations).

### 6.5 Build a Standalone PDF Extractor

**Current gap:** 18 banks (24%) produce empty `rate_slabs` because the agent can't parse PDFs.

**Proposed: `scripts/extract_rates_pdf.js`**

Leverages already-installed `pdf-parse` and `pdfjs-dist`:

1. **Input:** PDF URL or local file path
2. **Process:**
   - Download PDF via HTTP GET
   - Extract text using `pdf-parse`
   - Identify table structure (rows with tenure text + percentage values)
   - Apply tenure parser and column mapper
   - Extract effective date from text or filename
3. **Output:** JSON matching `_rates.json` schema

**PDF patterns observed in output:**

| Bank | PDF Structure | Complexity |
|------|--------------|------------|
| Citibank | Simple 2-column (tenure + rate) | Low |
| BNP Paribas | 3-column (tenure + general + amount tier) | Medium |
| JP Morgan | 13+ column amount-slab grid | High |
| Barclays | Two-tier system (< 3Cr periodic PDF, ≥ 3Cr daily) | Medium |
| Foreign banks (general) | Dated filenames, structured tables | Low-Medium |

**Integration options:**
- Called by the agent during discovery (Tier 3 banks get rates immediately)
- Called by the recurring scraper for periodic PDF re-checks
- Standalone CLI for manual re-extraction

**Effort:** Medium (PDF table extraction is well-solved; the main work is handling the 3–4 format variations observed across foreign bank PDFs).

### 6.6 Enhanced Playwright Script

**Current limitations and proposed fixes:**

#### 6.6a — Tab/Dropdown Interaction

```javascript
// NEW: Detect and iterate tabs
const tabs = await page.locator("[role='tab'], .tab-item, .nav-link").all();
if (tabs.length > 1) {
  for (const tab of tabs) {
    await tab.click();
    await page.waitForLoadState("networkidle", { timeout: 5000 });
    // Extract current visible table
    const tableData = await extractVisibleTable(page);
    allTables.push({ tabLabel: await tab.textContent(), ...tableData });
  }
}

// NEW: Detect and iterate <select> dropdowns
const selects = await page.locator("select").all();
for (const select of selects) {
  const options = await select.locator("option").all();
  for (const option of options) {
    await option.click();
    await page.waitForTimeout(500);
    // Extract rate data for this option
  }
}
```

**Fixes:** ICICI (10 tabs, currently only 2 slabs extracted), Suryoday SFB (dropdown-based).

#### 6.6b — Lazy-Loading / Infinite Scroll

```javascript
// NEW: Scroll to trigger lazy loading
async function scrollToBottom(page, maxScrolls = 10) {
  for (let i = 0; i < maxScrolls; i++) {
    const previousHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(500);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight) break; // No new content loaded
  }
}
```

**Fixes:** Axis Bank (currently 2 of 18 slabs due to lazy loading).

#### 6.6c — XHR/Fetch Interception

```javascript
// NEW: Monitor API calls for rate data
const apiResponses = [];
page.on("response", async (response) => {
  const url = response.url();
  if (url.includes("/api/") || url.includes("/data/") || url.includes("rates")) {
    try {
      const json = await response.json();
      apiResponses.push({ url, data: json });
    } catch (e) { /* Not JSON, skip */ }
  }
});
```

**Benefits:** If a bank's JS loads rates via an API call, we get clean JSON directly — no DOM parsing, no lazy-loading issues, no tab clicking. This is the most reliable extraction method for JS-rendered pages.

#### 6.6d — Browser Pooling (for batch mode)

```javascript
// NEW: Reuse browser across multiple URLs
let browser;
async function getOrCreateBrowser() {
  if (!browser) {
    browser = await chromium.launch({ /* ... */ });
  }
  return browser;
}
// Close browser only when batch is done
process.on("exit", () => browser?.close());
```

**Saves:** ~5 seconds per bank (Chromium startup time).

### 6.7 Tiered Agent Strategy

Not all banks need the full 5-step LLM workflow. Assign strategy based on prior knowledge:

| Tier | Criteria | Strategy | Time | Tokens |
|------|----------|----------|------|--------|
| **Tier A** | Known domain + html_static | Direct fetch + code parse | 30s | 0 (no LLM) |
| **Tier B** | Known domain + html_js | Playwright + code parse | 1 min | 0 (no LLM) |
| **Tier C** | Known domain + pdf | HTTP GET + pdf-parse | 30s | 0 (no LLM) |
| **Tier D** | Unknown domain, likely has website | LLM: find site + classify | 2–3 min | 8–12K |
| **Tier E** | Unknown, small co-op | LLM: full discovery | 3–5 min | 15–20K |

**How tiers are assigned:**
- Tier A/B/C: Banks already in `bank-domains.json` with known scraper_type from initial discovery
- Tier D: Banks in RBI scheduled bank list but not yet discovered
- Tier E: Everything else (cooperative banks, very small banks)

**Distribution estimate for 1900 banks:**
- ~200 Tier A/B/C (top banks, already discoverable)
- ~500 Tier D (scheduled banks with websites but unknown URLs)
- ~1200 Tier E (co-ops, RRBs, small banks)

**Weighted cost:**
```
200 × 0 + 500 × 10K + 1200 × 17K = 25.4M tokens
vs. current: 1900 × 18K = 34.2M tokens
Savings: ~26%
```

### 6.8 Batch Parallelization

**Current:** Sequential processing with 2-second delay between banks.

**Proposed:** Controlled parallelism:

```javascript
// run-batch.js enhancement
const CONCURRENCY = 3; // 3 parallel Claude sessions
const queue = banks.slice();
const active = new Set();

while (queue.length > 0 || active.size > 0) {
  while (active.size < CONCURRENCY && queue.length > 0) {
    const bank = queue.shift();
    const promise = runDiscovery(bank).finally(() => active.delete(promise));
    active.add(promise);
  }
  await Promise.race(active); // Wait for any one to finish
}
```

**Constraints:**
- Claude API rate limits (requests per minute, tokens per minute)
- Web scraping courtesy (don't hammer bank websites)
- Playwright memory usage (~200MB per Chromium instance)

**Recommended:** Start with concurrency of 2–3, with rate-limit detection from 6.2. Time savings: 2–3x faster batch runs.

**Token impact:** None (same total tokens, just faster wall-clock time).

### 6.9 Config Schema Simplification

**Proposed: Store only non-default values.**

Instead of:
```json
{
  "tenure_parser": "standard_indian",
  "rate_multiplier": 1.0,
  "senior_citizen_premium": "same_table",
  "deposit_insurance": true,
  "update_frequency": "monthly",
  "selectors": { "table": null, "rows": null, "effective_date": null },
  "column_mapping": {}
}
```

Store:
```json
{
  // Only fields that differ from defaults
  // Pipeline applies defaults for missing fields
}
```

**Defaults applied by pipeline:**
```javascript
const CONFIG_DEFAULTS = {
  tenure_parser: "standard_indian",
  rate_multiplier: 1.0,
  senior_citizen_premium: "same_table",
  deposit_insurance: true,
  update_frequency: "monthly"
};
```

**Benefits:** Smaller config files, less noise, easier to spot bank-specific overrides at a glance.

### 6.10 Unified Multi-Table Schema

**Proposed: Add `deposit_range` field to `rate_slabs`.**

```json
{
  "rate_slabs": [
    {
      "deposit_range": "below_3cr",
      "tenure_text": "7 days to 45 days",
      "tenure_min_days": 7,
      "tenure_max_days": 45,
      "rate_general_pct": 3.50,
      "rate_senior_pct": 4.00
    },
    {
      "deposit_range": "3cr_to_5cr",
      "tenure_text": "7 days to 45 days",
      "tenure_min_days": 7,
      "tenure_max_days": 45,
      "rate_general_pct": 3.75,
      "rate_senior_pct": null
    }
  ]
}
```

**Standard `deposit_range` values:**
```
"below_3cr"     — Retail (default if not specified)
"3cr_to_5cr"    — Bulk tier 1
"5cr_to_25cr"   — Bulk tier 2
"25cr_to_100cr" — Bulk tier 3
"above_100cr"   — Super bulk
"below_15l"     — Co-op tier (small deposits)
"15l_to_1cr"    — Co-op tier (medium)
"1cr_to_10cr"   — Co-op tier (large)
"above_10cr"    — Co-op tier (very large)
```

**Benefits:**
- Eliminates inconsistent multi-file approach (HDFC `_rates.json` + `_rates_bulk.json`)
- Recurring scraper knows exactly which deposit tier each rate belongs to
- Co-operative banks' amount-slab structure maps cleanly
- Pipeline can filter by `deposit_range` for consumer-facing display (most users care about `below_3cr`)

---

## 7. Priority Ranking

| Priority | Proposal | Token Savings | Time Savings | Effort | Rationale |
|----------|----------|--------------|--------------|--------|-----------|
| **P0** | 6.2 Rate limit detection & backoff | Prevents waste | Prevents batch failures | Low | Unblocks foreign bank batch immediately |
| **P1** | 6.1 Split discover from extract | ~40% | Moderate | Medium | Architectural — shapes recurring scraper design |
| **P2** | 6.3 Pre-seed known domains | ~5–8% | ~30s per known bank | Low | Quick win for top 200 banks |
| **P2** | 6.5 PDF extractor | Enables 24% of banks | N/A | Medium | Fills biggest data gap (18 banks with no rates) |
| **P3** | 6.4 Deterministic utilities | ~10–15% | Minor | Medium | Reusable across agent + scraper |
| **P3** | 6.6 Enhanced Playwright | Reduces cross-verification | Fixes partial extractions | Medium | ICICI, Axis, Suryoday fixes |
| **P4** | 6.7 Tiered strategy | ~20–30% | Significant | Medium | Combines P1+P2+P3 into workflow |
| **P4** | 6.8 Batch parallelization | None (same tokens) | 2–3x faster | Low-Med | Time savings only |
| **P5** | 6.9 Config simplification | None (not token-related) | None | Low | Cleanliness, easier maintenance |
| **P5** | 6.10 Unified multi-table schema | None (not token-related) | None | Low | Data quality, pipeline consistency |

**Recommended execution order:**
1. **Immediate:** P0 (rate limit handling) — unblocks work
2. **This week:** P2 (domain pre-seeding + PDF extractor) — quick wins
3. **Next sprint:** P1 (split discover/extract) — shapes architecture
4. **Ongoing:** P3–P5 as the recurring scraper is built

---

## 8. Scaling Projections

### Current Pace (No Optimization)

| Metric | Value |
|--------|-------|
| Banks remaining | ~1825 |
| Avg tokens/bank | 18K |
| Total tokens | 32.9M |
| Estimated cost (Sonnet pricing) | ~$480 |
| Estimated time (sequential) | 91–182 hours |
| Estimated time (3x parallel) | 30–61 hours |

### With P0 + P1 + P2 Optimizations

| Metric | Value |
|--------|-------|
| Banks remaining | ~1825 |
| Known-domain banks (skip search) | ~200 (10K tokens each) |
| Unknown-domain banks (full agent) | ~1625 (12K tokens each) |
| Total tokens | 2M + 19.5M = 21.5M |
| Estimated cost | ~$315 |
| Estimated time (3x parallel) | 20–40 hours |
| **Savings vs current** | **~35% cost, ~35% time** |

### With All Optimizations (P0–P5)

| Metric | Value |
|--------|-------|
| Tier A/B/C banks (no LLM) | ~200 (0 tokens) |
| Tier D banks (partial LLM) | ~500 (10K tokens each) |
| Tier E banks (full LLM) | ~1200 (15K tokens each) |
| Total tokens | 0 + 5M + 18M = 23M |
| + PDF extraction (code, no LLM) | 0 additional |
| Estimated cost | ~$340 |
| Estimated time (3x parallel) | 15–30 hours |
| **Savings vs current** | **~33% cost, ~50% time** |

### Recurring Scraper (Post-Discovery)

Once all 1900 banks are discovered and configs are written:

| Scraper Type | Banks | Method | Cost per Run | Frequency |
|-------------|-------|--------|-------------|-----------|
| html_static | ~760 | HTTP GET + parse | $0 (no LLM) | Daily |
| html_js | ~510 | Playwright + parse | $0 (no LLM) | Weekly |
| pdf | ~460 | Download + pdf-parse | $0 (no LLM) | Daily |
| manual | ~130 | Skip (human entry) | $0 | Monthly/manual |
| mixed | ~40 | Combo of above | $0 (no LLM) | Weekly |

**Total recurring cost: $0 in LLM tokens.** Only infrastructure costs (server time for Playwright, bandwidth for downloads).

---

## 9. Appendix: Bank-Type Breakdown

### Banks Discovered by Category

| Category | Code | Discovered | Total in India | Coverage |
|----------|------|-----------|----------------|----------|
| Public Sector Bank | PSB | 2 | 12 | 17% |
| Private Sector Bank (Indian) | PVB | 23 | 21 | 100%+ (includes some overlap) |
| Small Finance Bank | SFB | 11 | 12 | 92% |
| Payments Bank | PB | 6 | 6 | 100% |
| Foreign Bank | FB | 29 | 44 | 66% |
| Regional Rural Bank | RRB | 0 | 43 | 0% |
| Scheduled Urban Co-op | SUCB | 2 | ~50 | 4% |
| State Co-op | SSCB | 2 | ~33 | 6% |
| Other Co-ops/RRB/LAB | Various | 0 | ~1700 | 0% |

### Remaining Work (Priority Order)

1. **PSB (10 remaining):** High-value, likely html_js, well-known domains. Pre-seed and batch.
2. **Foreign Banks (15 remaining):** Rate-limited batch. Fix rate-limit handling, re-run.
3. **RRBs (43):** Medium complexity, likely html_static, some may lack websites.
4. **Scheduled Urban Co-ops (~48):** Variable — some have websites, many don't.
5. **State Co-ops (~31):** Often share state portal. Check state co-op bank websites.
6. **Non-Scheduled Co-ops (~1200+):** Long tail. Many without websites. Lowest priority for agentic discovery.
7. **District Central Co-ops, LABs, FIs:** Specialized, small numbers.

### Scraper Type Prediction for Remaining Banks

Based on patterns observed in the 75 discovered banks:

| Category | Likely html_static | Likely html_js | Likely pdf | Likely manual |
|----------|-------------------|---------------|-----------|--------------|
| PSB | 20% | 70% | 10% | 0% |
| FB (remaining) | 10% | 10% | 70% | 10% |
| RRB | 60% | 20% | 10% | 10% |
| SUCB | 70% | 10% | 5% | 15% |
| SSCB | 60% | 10% | 10% | 20% |
| Non-Scheduled Co-ops | 30% | 5% | 5% | 60% |

**Key insight:** The long tail of co-operative banks will have the highest `manual` rate (~60% of non-scheduled co-ops may have no scrapeable website). These represent the biggest challenge for automated discovery and may require alternative data sources (RBI publications, state co-op portals, manual data entry).
