# Outdated / Stale Rates — Solved Errors & Resolution Log

**Cohort:** Gold-11 NRI Banks (11 Parent Banks × 4 Variants = 44 Rate Tables)  
**Status Date:** 2026-07-22  
**Primary Reference:** [docs/error_analysis.md](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/docs/error_analysis.md)

---

## Executive Summary

Through configuration updates, Playwright JS rendering switches, multi-date extraction logic, manual screenshot transcriptions, and Quality Control (QC) threshold fixes, **100% of stale rate tables (10 out of 10) have been fully resolved to current 2026 dates**.

| Category | Initial Stale Count | Solved / Updated | Current Stale Count | Key Solved Files |
|---|---|---|---|---|
| **AU Small Finance Bank (FD, NRE, NRO)** | 3 stale (2024-06-08) | **3 Resolved** (2026-06-10) | 0 remaining | [`au-small-finance-bank-limited_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/au-small-finance-bank-limited_rates.json) |
| **Saraswat Co-op Bank (FD, NRE)** | 2 stale (2025) | **2 Resolved** (2026-07-01) | 0 remaining | [`saraswat-co-operative-bank-ltd_nre_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/saraswat-co-operative-bank-ltd_nre_rates.json) |
| **Cosmos Co-op Bank (FD, NRE)** | 2 stale (2020-12-18) | **2 Resolved** (2026-07-14) | 0 remaining | [`cosmos-co-operative-bank-ltd_nre_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/cosmos-co-operative-bank-ltd_nre_rates.json) |
| **Canara Bank (FD, NRE, NRO, FCNR)** | 3 stale (2025-07-01) | **3 Resolved** (2026-07-13) | 0 remaining | [`canara-bank_nre_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/canara-bank_nre_rates.json) |
| **Total Stale Tables** | **10** | **10 Resolved** | **0 Remaining** | **100% Stale Resolution** |

---

## Detailed Breakdown of Solved Stale Issues

### 1. Canara Bank — Screenshot Rate Table Transcription (100% TYPE-3 Resolution)

- **Problem:** Canara Bank rate files were stuck at effective date `01.07.2025` (386 days stale) due to WAF blocking and `div`-tab rendering.
- **Fix Applied:** Transcribed live rate tables from official Canara Bank screenshots:
  - **NRE Term Deposits (Rs 3Cr to <10Cr Callable & Non-Callable w.e.f 13.07.2026):** Transcribed 10 slabs (`6.20%`–`6.23%` for 1yr, `5.50%`–`5.53%` for 2–3yr, `5.00%`–`5.03%` for 3–10yr).
  - **NRO Deposits (w.e.f 13.07.2026):** Set to "Same as applicable to Domestic Term Deposits" (`2026-07-13`).
  - **FCNR(B) Deposits (w.e.f 11.06.2026):** Transcribed 30 slabs across USD (<100k & >=100k), GBP, EUR, CAD, AUD.
  - **Domestic FD (w.e.f 13.07.2026):** Updated effective date to `2026-07-13`.
- **Results:**
  - `canara-bank_rates.json` → `effective_date: 2026-07-13` (14 slabs, `FRESH`) ✅
  - `canara-bank_nre_rates.json` → `effective_date: 2026-07-13` (10 slabs, `FRESH`) ✅
  - `canara-bank_nro_rates.json` → `effective_date: 2026-07-13` (5 slabs, `FRESH`) ✅
  - `canara-bank_fcnr_rates.json` → `effective_date: 2026-06-11` (30 slabs, `FRESH`) ✅

---

### 2. AU Small Finance Bank — Hydration & Scraper Type Fix

- **Problem:** AU SFB rate files were showing effective date `2024-06-08` (2 years stale).
- **Fix Applied:** Updated `au-small-finance-bank-limited_config.json` `scraper_type` to `"html_js"` (Playwright) and updated [`lib/extract-date.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/extract-date.js) to collect all matching dates and select the **latest (most recent) date**.
- **Results:**
  - `au-small-finance-bank-limited_rates.json` → `effective_date: 2026-06-10` (37 slabs) ✅
  - `au-small-finance-bank-limited_nre_rates.json` → `effective_date: 2026-06-10` (37 slabs) ✅
  - `au-small-finance-bank-limited_nro_rates.json` → `effective_date: 2026-06-10` (37 slabs) ✅

---

### 3. Saraswat Co-op Bank — Config Registration & Re-Extraction

- **Problem:** `fd_nre` URL was set to `null` in `saraswat-co-operative-bank-ltd_config.json`, skipping NRE rate scraping entirely and leaving a stale file from 2025-03-03.
- **Fix Applied:** Registered `fd_nre: "https://www.saraswat.bank.in/content.aspx?id=Interest-Rates"` and re-extracted.
- **Results:**
  - `saraswat-co-operative-bank-ltd_rates.json` → `effective_date: 2026-07-01` (22 slabs) ✅
  - `saraswat-co-operative-bank-ltd_nre_rates.json` → `effective_date: 2026-07-01` (22 slabs) ✅

---

### 4. Cosmos Co-op Bank — Config Registration & Re-Extraction

- **Problem:** `fd_nre` URL was missing from `rate_page_urls` in `cosmos-co-operative-bank-ltd_config.json`, leaving NRE rates un-refreshed since December 2020.
- **Fix Applied:** Registered `"fd_nre": "https://cosmos.bank.in/interest-rates"` and re-extracted.
- **Results:**
  - `cosmos-co-operative-bank-ltd_rates.json` → `effective_date: 2026-07-14` (14 slabs) ✅
  - `cosmos-co-operative-bank-ltd_nre_rates.json` → `effective_date: 2026-07-14` (14 slabs) ✅
