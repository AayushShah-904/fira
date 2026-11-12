# Manual Rate Fetch — Process & Bank Registry

**Scope:** All banks where automated scraping fails 100% of the time and rates must be obtained manually.  
**Last Updated:** 2026-07-22  
**Reference:** [docs/error_analysis.md](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/docs/error_analysis.md)

---

## What is a Manual Rate Fetch?

A **manual rate fetch** is the process of retrieving bank FD interest rate data by hand — through a browser, PDF download, or screenshot — when the automated scraper pipeline fails to reach or parse the bank's website.

The pipeline has 5 types of manual extraction, each captured in the `extraction_method` field of the rate JSON file:

| `extraction_method` | Description | When Used |
|---|---|---|
| `manual_browser_fetch` | Agent opens browser, reads the live HTML page, copies rate table | WAF blocks scraper but browser works |
| `manual_transcription_from_rendered_text` | Agent reads Playwright-rendered text (no table structure) and types rates | Page renders as `div/span` instead of `<table>` |
| `manual_pdf_transcription` | Agent downloads and reads a PDF rate card, transcribes data | Bank only publishes a PDF link |
| `manual_image_transcription` | Agent reads a rate image/screenshot and transcribes | Bank publishes rate as an image (jpg/png) |
| `manual_data_entry` | Human operator directly enters structured rate data into the JSON | All automation paths failed |

---

## Current Manual Fetch Coverage

As of **2026-07-22**, **125 rate files** across the system were obtained via manual methods:

| Method | File Count | % of Manual Total |
|---|---|---|
| `manual_transcription_from_rendered_text` | 83 | 66% |
| `manual_data_entry` | 19 | 15% |
| `manual_image_transcription` | 15 | 12% |
| `manual_pdf_transcription` | 7 | 6% |
| `manual_browser_fetch` | 1 | 1% |
| **Total** | **125** | **100%** |

---

## Completed Manual Rate Fetches (Gold-11 NRI Cohort)

All manual rate fetches for the Gold-11 NRI cohort have been completed and verified as `FRESH`:

### ✅ COMPLETED — Canara Bank IBU (GIFT City)

| Variant | Rate Page URL | Effective Date | Slabs | Status | Output File |
|---|---|---|---|---|---|
| GIFT | [ifscgift.canarabank.bank.in/deposit-interest-rates](https://ifscgift.canarabank.bank.in/deposit-interest-rates) | 2026-06-11 | 32 | ✅ Completed (`FRESH`) | [`canara-bank-ibu_gift_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/canara-bank-ibu_gift_rates.json) |

**How it was fetched:** Transcribed manually from official Canara Bank IBU GIFT City portal screenshot (`extraction_method: manual_image_transcription`). Contains 32 slabs across USD (<=5M & >5M), EUR, GBP with effective date `2026-06-11`.

---

### ✅ COMPLETED — Canara Bank (Domestic FD, NRE, NRO, FCNR)

| Variant | Rate Page URL | Effective Date | Slabs | Status | Output File |
|---|---|---|---|---|---|
| FD | [canarabank.bank.in/pages/deposit-interest-rates](https://canarabank.bank.in/pages/deposit-interest-rates) | 2026-03-17 | 12 | ✅ Completed (`FRESH`) | [`canara-bank_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/canara-bank_rates.json) |
| NRE | [canarabank.bank.in/pages/deposit-interest-rates](https://canarabank.bank.in/pages/deposit-interest-rates) | 2026-07-13 | 10 | ✅ Completed (`FRESH`) | [`canara-bank_nre_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/canara-bank_nre_rates.json) |
| NRO | [canarabank.bank.in/pages/deposit-interest-rates](https://canarabank.bank.in/pages/deposit-interest-rates) | 2026-07-13 | 5 | ✅ Completed (`FRESH`) | [`canara-bank_nro_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/canara-bank_nro_rates.json) |
| FCNR | [canarabank.bank.in/pages/deposit-interest-rates](https://canarabank.bank.in/pages/deposit-interest-rates) | 2026-06-11 | 30 | ✅ Completed (`FRESH`) | [`canara-bank_fcnr_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/canara-bank_fcnr_rates.json) |

**How it was fetched:** Transcribed manually from official Canara Bank rate portal screenshots (`extraction_method: manual_image_transcription`). All 4 JSON files were validated and tagged as `FRESH` by `lib/rates-qc.js`.

---

### ✅ COMPLETED — Bank of Maharashtra (FD, NRE, NRO, FCNR)

| Variant | Rate Page URL | Effective Date | Slabs | Status | Output File |
|---|---|---|---|---|---|
| FD | [bankofmaharashtra.bank.in/domestic-term-deposits](https://bankofmaharashtra.bank.in/domestic-term-deposits) | 2026-09-14 | 14 | ✅ Patched (`FRESH`) | [`bank-of-maharashtra_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/bank-of-maharashtra_rates.json) |
| NRE | [bankofmaharashtra.bank.in/nre-deposits](https://bankofmaharashtra.bank.in/nre-deposits) | 2026-09-14 | 6 | ✅ Patched (`FRESH`) | [`bank-of-maharashtra_nre_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/bank-of-maharashtra_nre_rates.json) |
| NRO | [bankofmaharashtra.bank.in/domestic-term-deposits](https://bankofmaharashtra.bank.in/domestic-term-deposits) | 2026-09-14 | 43 | ✅ Patched (`FRESH`) | [`bank-of-maharashtra_nro_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/bank-of-maharashtra_nro_rates.json) |
| FCNR | [bankofmaharashtra.bank.in/fcnr-deposits](https://bankofmaharashtra.bank.in/fcnr-deposits) | 2026-09-01 | 25 | ✅ Patched (`FRESH`) | [`bank-of-maharashtra_fcnr_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/bank-of-maharashtra_fcnr_rates.json) |

**How it was fetched:** Rates were verified to match the live portal screenshots, and the `effective_date` was bumped via manual patch on 2026-10-02 to match the new `w.e.f.` dates published by the bank (`extraction_method: manual_image_transcription`).

---

### ✅ COMPLETED — HDFC Bank (FCNR)

| Variant | Rate Page URL | Effective Date | Slabs | Status | Output File |
|---|---|---|---|---|---|
| FCNR | [hdfcbank.com/nri-banking/rates/fcnr-deposit/rates](https://www.hdfcbank.com/nri-banking/rates/fcnr-deposit/rates) | 2026-07-03 | 31 | ✅ Completed (`FRESH`) | [`hdfc-bank-limited_fcnr_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/hdfc-bank-limited_fcnr_rates.json) |

**How it was fetched:** Transcribed manually from official HDFC Bank portal screenshots (`extraction_method: manual_image_transcription`). Contains 31 currency slabs across GBP, USD, EURO, JPY, AUD, CAD, SGD with multi-effective dates (July 3, 2026 & June 22, 2026).`

---

### 🟠 NEEDED — Saraswat Co-op Bank NRO

| Variant | Rate Page URL | Effective Date on File | Status |
|---|---|---|---|
| NRO | [saraswat.bank.in/content.aspx?id=Interest-Rates](https://www.saraswat.bank.in/content.aspx?id=Interest-Rates) | FILE MISSING | ✗ No rates file |

**Why it fails:** NRO rate file has never been created. The FD/NRE rate page has been successfully scraped. The same page likely contains NRO rates in a separate section — verify and register, or manually transcribe.

**Output file to create:**
- [`output/latest/saraswat-co-operative-bank-ltd_nro_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/saraswat-co-operative-bank-ltd_nro_rates.json)

---

### ✅ COMPLETED — Cosmos Co-op Bank NRO

| Variant | Rate Page URL | Effective Date | Slabs | Status | Output File |
|---|---|---|---|---|---|
| NRO | [cosmos.bank.in/interest-rates](https://cosmos.bank.in/interest-rates) | 2026-07-22 | 13 | ✅ Completed (`FRESH`) | [`cosmos-co-operative-bank-ltd_nro_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/cosmos-co-operative-bank-ltd_nro_rates.json) |

**How it was fetched:** Transcribed manually from official Cosmos Bank NRO Deposit Interest Rates table screenshot (`extraction_method: manual_image_transcription`). Contains 13 slabs (7 days to 10 years) with effective date `2026-07-22`.

---

### ✅ COMPLETED — Saraswat Co-op Bank NRO

| Variant | Rate Page URL | Effective Date | Slabs | Status | Output File |
|---|---|---|---|---|---|
| NRO | [saraswat.bank.in/Assets/INTEREST_RATE_TD_GP_GENERAL.pdf](https://www.saraswat.bank.in/Assets/INTEREST_RATE_TD_GP_GENERAL.pdf) | 2026-06-30 | 17 | ✅ Completed (`FRESH`) | [`saraswat-co-operative-bank-ltd_nro_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/saraswat-co-operative-bank-ltd_nro_rates.json) |

**How it was fetched:** Transcribed manually from official Saraswat Bank NRO Deposit PDF rate table screenshot (`extraction_method: manual_image_transcription`). Contains 17 slabs (7 days to 10 years) with effective date `2026-06-30`.

---

### ✅ PATCHED — Yes Bank (FCNR) — Stale Date Fix (2026-10-02)

| Variant | Rate Page URL | Old Date | Correct Date | Slabs | Status | Output File |
|---|---|---|---|---|---|---|
| FCNR | [nri_interest_rates_pdf.pdf](https://yes.bank.in/sites/web/content/published/api/v1.1/assets/CONT4232E91A699245729D4F725A28ECFEA2/native/nri_interest_rates_pdf.pdf) | `2026-08-27` ❌ | `2026-09-01` ✅ | 45 | ✅ Patched | [`yes-bank-limited_fcnr_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/yes-bank-limited_fcnr_rates.json) |

**Why it was wrong:** The `lib/extract-date.js` regex escaping bug caused Tier 1/2 keywords to never match. The engine fell to Tier 5 (HTTP `Last-Modified` header) which returned `27 Aug 2026` — the date the PDF was uploaded to Yes Bank's server — instead of the `w.e.f. 1st September 2026` printed inside the PDF.

**How it was patched:** Manually transcribed from the official Yes Bank FCNR PDF screenshot. 9 currencies: USD (<1Mn), USD (>1Mn), GBP, EUR, JPY, CAD, AUD, HKD, SGD × 5 tenures.

---

### ✅ PATCHED — RBL Bank (FCNR) — Stale Date Fix (2026-10-02)

| Variant | Rate Page URL | Old Date | Correct Date | Slabs | Status | Output File |
|---|---|---|---|---|---|---|
| FCNR | [rbl.bank.in/interest-rates](https://rbl.bank.in/interest-rates) | `2026-06-12` ❌ | `2026-09-01` ✅ | 40 | ✅ Patched | [`rbl-bank-limited_fcnr_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/rbl-bank-limited_fcnr_rates.json) |

**Why it was wrong:** Same `lib/extract-date.js` regex bug. The RBL Bank website text clearly stated `w.e.f. September 01, 2026` but the broken keyword regex never matched it. The engine fell to Tier 5 which returned `12 Jun 2026` — the HTTP `Last-Modified` date of the page.

**How it was patched:** Manually transcribed from the official RBL Bank FCNR interest rate table screenshot. 8 currencies: USD, GBP, EUR, AUD, SGD, JPY, CAD, CHF × 5 tenures.

---

### ✅ PATCHED — Saraswat Co-op Bank (FCNR) — Stale Date Fix (2026-10-02)

| Variant | Rate Page URL | Old Date | Correct Date | Slabs | Status | Output File |
|---|---|---|---|---|---|---|
| FCNR | [saraswat.bank.in/content.aspx?id=Interest-Rates](https://saraswat.bank.in/content.aspx?id=Interest-Rates) | `2026-06-15` ❌ | `2026-09-04` ✅ | 5 | ✅ Patched | [`saraswat-co-operative-bank-ltd_fcnr_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/saraswat-co-operative-bank-ltd_fcnr_rates.json) |

**Why it was wrong:** The website updated to `Interest Rates on FCNR/RFC Deposits from 04.09.2026` but our UI was holding `15 Jun 2026` with stale incorrect rates (e.g. 6.00% instead of 4.25% for 3+ years). It appears the old rate file format contained duplicates.
**How it was patched:** Cleaned the JSON manually. Kept exactly 5 slabs for USD (1-2yr, 2-3yr, 3-4yr, 4-5yr, 5yr) matching the live screenshot. Updated the date to `2026-09-04`.

---

### ✅ PATCHED — Cosmos Co-op Bank (NRE, FCNR) — Stale Date & Format Fix (2026-10-02)

| Variant | Rate Page URL | Old Date | Correct Date | Slabs | Status | Output File |
|---|---|---|---|---|---|---|
| NRE | [cosmos.bank.in/interest-rates](https://cosmos.bank.in/interest-rates) | `2026-07-14` ❌ | `2026-09-15` ✅ | 8 | ✅ Patched | [`cosmos-co-operative-bank-ltd_nre_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/cosmos-co-operative-bank-ltd_nre_rates.json) |
| FCNR | [cosmos.bank.in/interest-rates](https://cosmos.bank.in/interest-rates) | `2026-07-01` ❌ | `2026-09-01` ✅ | 24 | ✅ Patched | [`cosmos-co-operative-bank-ltd_fcnr_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/cosmos-co-operative-bank-ltd_fcnr_rates.json) |

**Why it was wrong:**
- **NRE:** Stale date (`14 Jul 2026`), and it incorrectly had domestic short-term slabs (e.g., 7 days) which are illegal for NRE (must be >= 1 year). The new website explicitly shows 8 slabs starting from 1 year w.e.f `15.09.2026`.
- **FCNR:** Stale date (`01 Jul 2026`) and stale rates.
**How it was patched:**
- Rewrote the NRE file to match the 8 official retail slabs starting from 1 year. Updated date to `2026-09-15`.
- Rewrote the FCNR file to match the 4 currencies (USD, GBP, EUR, JPY) across the 5 standard tenors, plus the Premium `1 yr 1 day` tenor. Updated date to `2026-09-01`.

---

### ✅ PATCHED — IDFC First Bank (NRE, NRO) — Safeguarded against Overwrites (2026-10-03)

| Variant | Rate Page URL | Old Date | Correct Date | Slabs | Status | Output File |
|---|---|---|---|---|---|---|
| NRE | [nre-fixed-deposit](https://www.idfcfirstbank.com/nri-banking/nri-fixed-deposit/nre-fixed-deposit) | `2026-10-01` ❌ | `2026-09-01` ✅ | 12 | ✅ Patched | [`idfc-first-bank-limited_nre_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/idfc-first-bank-limited_nre_rates.json) |
| NRO | [nro-fixed-deposit](https://www.idfcfirstbank.com/nri-banking/nri-fixed-deposit/nro-fixed-deposit) | `2026-10-01` ❌ | `2026-09-01` ✅ | 12 | ✅ Patched | [`idfc-first-bank-limited_nro_rates.json`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/output/latest/idfc-first-bank-limited_nro_rates.json) |

**Why it was wrong:** The agent's automated parser could not read the widget structure of the NRE/NRO pages. It defaulted to a fallback which blindly copied the Domestic table, unintentionally carrying over `Senior Citizen` rates (which are illegal for NRI accounts) and storing an incorrect effective date.
**How it was patched:** Scrubbed all Senior Citizen rates (`rate_senior_pct: null`) from the NRE and NRO files. Updated the effective date to `2026-09-01`. The NRE and NRO URLs in `bank-domains.json` were set to `null` to physically block the agent from ever overwriting these pristine files again.

---

## How to Perform a Manual Rate Fetch

### Step 1: Open the Bank's Rate Page in a Browser

Navigate to the bank's official interest rates page. Look for:
- A table with tenure ranges in the first column (e.g. "7 Days – 14 Days").
- An effective date (usually near the top: "w.e.f.", "Applicable from", "Revised as on").

### Step 2: Identify Rate Variants Present

Most bank pages publish multiple variants on one page. Look for section headings like:
- **Domestic FD** / **Regular FD** → use for `_rates.json`
- **NRE** / **Non-Resident External** → use for `_nre_rates.json`
- **NRO** / **Non-Resident Ordinary** → use for `_nro_rates.json`
- **FCNR** / **Foreign Currency Non-Resident** → use for `_fcnr_rates.json`

### Step 3: Transcribe the Rate Slabs

For each rate slab row in the table, extract:
- `tenure_text` — the exact text as shown (e.g. `"7 days to 14 days"`)
- `tenure_min_days` — minimum tenure in days (convert months: 1 month = 30 days)
- `tenure_max_days` — maximum tenure in days
- `rate_general_pct` — general public interest rate (%)
- `rate_senior_pct` — senior citizen rate (%) or `null` if not shown
- `deposit_range` — `"below_3cr"`, `"3cr_to_10cr"`, `"above_10cr"` as applicable

### Step 4: Write the Rate File (JSON Template)

```json
{
  "bank_code": "your-bank-slug",
  "product_type": "FD",
  "variant": "regular",
  "effective_date": "YYYY-MM-DD",
  "source_url": "https://bank-website.com/interest-rates",
  "scraped_at": "2026-07-22T00:00:00.000Z",
  "extraction_confidence": "high",
  "extraction_method": "manual_browser_fetch",
  "notes": "Manually fetched from bank website. [Add any relevant notes here.]",
  "rate_slabs": [
    {
      "tenure_text": "7 days to 14 days",
      "tenure_min_days": 7,
      "tenure_max_days": 14,
      "rate_general_pct": 3.00,
      "rate_senior_pct": 3.50,
      "rate_super_senior_pct": null,
      "deposit_range": "below_3cr",
      "min_deposit": null,
      "compounding_freq": "QUARTERLY",
      "source_row_text": "7 days to 14 days | 3.00% | 3.50%"
    }
  ],
  "special_schemes": [],
  "warnings": [],
  "errors": []
}
```

### Step 5: Run Validation

After writing the file, validate it using:

```bash
node scripts/reextract-dates.js
node "C:\Users\ASUS\.gemini\antigravity\brain\b036432f-3479-4100-8838-db483623582b\scratch\tree-44.js"
```

This will:
1. Populate the `data_quality` freshness block automatically.
2. Re-display the Gold-11 cohort tree to confirm the file is now ✓ OK.

---

## Tenure Day Conversion Reference

| Tenure Text | Min Days | Max Days |
|---|---|---|
| 7 days | 7 | 7 |
| 7–14 days | 7 | 14 |
| 15–30 days | 15 | 30 |
| 1 month | 30 | 30 |
| 3 months | 90 | 90 |
| 6 months | 180 | 180 |
| 1 year | 365 | 365 |
| 2 years | 730 | 730 |
| 3 years | 1095 | 1095 |
| 5 years | 1825 | 1825 |
| Above 5 years / 10 years | 1826 | 3650 |

---

## Future Manual Fetch Schedule

Banks with `data_quality.freshness_status: "EXTREMELY_STALE"` and `manual_verification_needed: true` should be re-fetched manually on a **monthly basis** until their automation is fixed:

| Bank | Variant(s) | Status | Next Scheduled Check |
|---|---|---|---|
| Canara Bank | FD, NRE, NRO, FCNR | ✅ **Completed (`FRESH`)** | 2026-08-22 (Monthly) |
| Bank of Maharashtra | FD, NRE, NRO, FCNR | ✅ **Completed (`FRESH`)** | 2026-08-18 (Monthly) |
| HDFC Bank | FCNR | ✅ **Completed (`FRESH`)** | 2026-08-03 (Monthly) |
| Saraswat Co-op Bank | NRO | ✅ **Completed (`FRESH`)** | 2026-08-30 (Monthly) |
| Cosmos Co-op Bank | NRO | ✅ **Completed (`FRESH`)** | 2026-08-22 (Monthly) |
| Yes Bank | FCNR | ✅ **Patched (`FRESH`) — 2026-09-01** | 2026-11-01 (Quarterly) |
| RBL Bank | FCNR | ✅ **Patched (`FRESH`) — 2026-09-01** | 2026-11-01 (Quarterly) |
| Axis Bank | FCNR | ✅ **Patched (`FRESH`) — 2026-09-04** | 2026-11-04 (Quarterly) |

---

## Banks With Zero Rate Slabs — Full Registry

> **237 rate files** currently have `rate_slabs: []` — the agent ran but returned no data.  
> These are grouped below by failure reason. All are candidates for manual rate fetch.

---

### 🔴 WAF / HTTP 403 Blocked (6 banks)
> Automated agent is actively blocked by a Web Application Firewall or IP ban.  
> **Action:** Manual browser fetch required. Use `/browser` command or open in Chrome/Edge.

| # | Bank | Variant | URL |
|---|---|---|---|
| 1 | bank-of-ceylon | FD | [boc.lk/international-banking/overseas-branches](https://boc.lk/international-banking/overseas-branches) |
| 2 | hdfc-bank-limited | FCNR | [hdfc.bank.in/nri-banking/.../fcnr-deposit/rates](https://hdfc.bank.in/nri-banking/fixed-deposit-foreign-currency-account/fcnr-deposit/rates) |
| 3 | paytm-payments-bank-limited | FD | [paytm.bank.in/products/fixed-deposit](https://paytm.bank.in/products/fixed-deposit) |
| 4 | qatar-national-bank-qpsc-ibu | GIFT | [qnb.com/sites/qnb/qnbindia/page/.../enifscbankingunit.html](https://qnb.com/sites/qnb/qnbindia/page/en/enifscbankingunit.html) |
| 5 | qatar-national-bank-qpsc | FD | [qnb.com/en/india](https://qnb.com/en/india) |
| 6 | uttar-pradesh-gramin-bank | FD | [upgb.bank.in/fixed-deposit.php](https://upgb.bank.in/fixed-deposit.php) |

---

### 🟠 HTTP 404 / Page Not Found (4 banks)
> The rate page URL on record returns a 404 error — the URL has likely moved or been removed.  
> **Action:** Search bank's website for current rate page URL and update registry.

| # | Bank | Variant | Last Known URL |
|---|---|---|---|
| 1 | canara-bank-ibu | GIFT | [canarabank.bank.in/pages/ifsc-banking-unit](https://canarabank.bank.in/pages/ifsc-banking-unit) |
| 2 | rander-peoples-co-op-bank-ltd | FD | [rpcbl.in/deposits/](https://rpcbl.in/deposits/) |
| 3 | the-district-co-operative-central-bank-ltd-khammam | FD | *(URL missing from registry)* |
| 4 | yes-bank-ibu | GIFT | [yes.bank.in/gift-ibu](https://yes.bank.in/gift-ibu) |

---

### 🔵 DNS / Domain Unreachable (7 banks)
> The bank's domain itself cannot be resolved — the website may be down, decommissioned, or the domain has changed.  
> **Action:** Verify if the bank's website is still live. If domain changed, update registry. If defunct, mark as `inactive`.

| # | Bank | Variant | Last Known URL |
|---|---|---|---|
| 1 | chennai-central-co-operative-bank-ltd | FD | [ccbankchennai.com](https://ccbankchennai.com) |
| 2 | ctbc-bank-co-ltd-ibu | GIFT | [ctbcbank.bank.in](https://ctbcbank.bank.in) |
| 3 | jilla-sahakari-kendriya-bank-maryadit-ujjain | FD | [jskbrjn.bank.in/interest-rates.php](https://jskbrjn.bank.in/interest-rates.php) |
| 4 | ramanagaram-urban-co-operative-bank-ltd | FD | [rucbank.com](https://rucbank.com) |
| 5 | sangli-urban-co-operative-bank-ltd-sangli | FD | [sangliurban.bank.in/deposit-int-rate](https://sangliurban.bank.in/deposit-int-rate) |
| 6 | the-manipur-state-co-operative-bank-ltd | FD | [mscbmanipur.in](https://mscbmanipur.in) |
| 7 | vasai-vikas-sahakari-bank-ltd | FD | [vvsb.bank.in/deposite/243](https://vvsb.bank.in/deposite/243) |

---

### ⏱ Timeout (2 banks)
> The rate page exists but the server takes too long to respond (>30s).  
> **Action:** Retry at off-peak hours or fetch manually via browser.

| # | Bank | Variant | URL |
|---|---|---|---|
| 1 | idfc-first-bank-ibu | GIFT | [IDFC First IBU GIFT City PDF](https://idfcfirst.bank.in/content/dam/idfcfirstbank/interest-rate/Interest-Rates-on-Gift-City-Fixed-Deposits-website-16012026.pdf) |
| 2 | varanasi-district-central-co-operative-bank-ltd | FD | [dcbvaranasi.bank.in/intrest.php?id=4](https://dcbvaranasi.bank.in/intrest.php?id=4) |

---

### 📋 PDF Error (3 banks)
> The bank publishes a PDF but the automated PDF extractor failed (invalid structure or unreadable).  
> **Action:** Download the PDF manually, read it, and transcribe the rate table.

| # | Bank | Variant | PDF URL |
|---|---|---|---|
| 1 | mizuho-bank-ibu | GIFT | [term-deposit-interest-rates.pdf](https://cdn.prod.website-files.com/67cb23eaf0c6c4d4080e059a/68dd816514ae9148580a1e23_term-deposit-interest-rates.pdf) |
| 2 | nilgiris-central-co-operative-bank-ltd | FD | [nilgirisccb.bank.in](https://nilgirisccb.bank.in/) |
| 3 | united-overseas-bank-limited | FD | [uob.bank.in/.../interest-rate.pdf](https://uob.bank.in/assets/web-resources/in/pdf/useful/interest-rates/interest-rate.pdf) |

---

### 🚫 No Rate Page Registered (143 banks)
> The bank's website is known but no rate page URL has been registered in the system registry.  
> The agent skipped these banks entirely (`extraction_method: "registry_skip"`).  
> **Action:** Visit the bank website, find the FD interest rate page URL, and register it.

<details>
<summary>Click to expand — 143 banks with no rate page registered</summary>

| # | Bank | Variant | Website / Last URL Attempted |
|---|---|---|---|
| 1 | au-small-finance-bank-limited | FCNR | [au.bank.in/interest-rates/au-fcnr](https://au.bank.in/interest-rates/au-fcnr) |
| 2 | bahraich-district-central-co-operative-bank-ltd | FD | *(no URL)* |
| 3 | bank-of-baroda-ibu | GIFT | [ifsc.bankofbaroda.bank.in/rates-and-charges/interest-rates](https://ifsc.bankofbaroda.bank.in/rates-and-charges/interest-rates) |
| 4 | barclays-bank-plc-ibu | GIFT | [barclays.bank.in/gift/giftcity/](https://barclays.bank.in/gift/giftcity/) |
| 5 | bhiwani-central-co-operative-bank-ltd | FD | *(no URL)* |
| 6 | citibank-na | NRE | [citigroup.com/.../deposit-rate.pdf](https://citigroup.com/rcs/citigpa/storage/public/India/regulatory-disclosures/deposit-rate.pdf) |
| 7 | cuddalore-district-central-co-operative-bank-ltd | FD | [cuddaloredccb.bank.in/term_deposit.php](https://cuddaloredccb.bank.in/term_deposit.php) |
| 10 | dharampuri-district-central-co-operative-bank-ltd | FD | *(no URL)* |
| 11 | dindigul-central-co-operative-bank-ltd | FD | [dindigulccb.bank.in](https://dindigulccb.bank.in/) |
| 12 | emirates-nbd-bank-pjsc | FD/NRE/NRO/FCNR | *(no URL — 5 variants)* |
| 13 | etah-district-co-operative-bank-ltd | FD | [etah.nic.in](https://etah.nic.in/) |
| 14 | faridabad-central-co-operative-bank-ltd | FD | *(no URL)* |
| 15 | fatehabad-central-co-operative-bank-ltd | FD | *(no URL)* |
| 16 | fatehgarh-sahib-central-co-operative-bank-ltd-sirhind | FD | [pbcoopbank.in](https://pbcoopbank.in/) |
| 17 | fazilka-central-co-operative-bank-ltd | FD | *(no URL)* |
| 18 | ghazipur-district-co-operative-bank-ltd | FD | *(no URL)* |
| 19 | guntur-district-co-operative-central-bank-ltd | FD | [gunturdccb.bank.in/term-deposit/](https://gunturdccb.bank.in/term-deposit/) |
| 20 | hardoi-district-co-operative-bank-ltd | FD | [hardoi.nic.in](https://hardoi.nic.in/) |
| 21 | idbi-bank-ibu | GIFT | [idbi.bank.in/ibu/interest-rates.aspx](https://idbi.bank.in/ibu/interest-rates.aspx) |
| 22 | indian-bank-ibu | GIFT | [indianbank.bank.in/.../Deposit-rates-IBU-March_2026.pdf](https://indianbank.bank.in/wp-content/uploads/2024/03/Deposit-rates-IBU-March_2026.pdf) |
| 23 | jammu-kashmir-bank-limited | NRE | [jkb.bank.in/deposits/nre-fixed-deposits](https://jkb.bank.in/deposits/nre-fixed-deposits) |
| 24 | jammu-kashmir-bank-limited | NRO | [jkb.bank.in/deposits/nro-fixed-deposits](https://jkb.bank.in/deposits/nro-fixed-deposits) |
| 25 | janalaxmi-co-operative-bank-ltd-nashik | FD | [janalaxmi.bank.in/assets/uploads/gallery/gallery_248.jpg](https://janalaxmi.bank.in/assets/uploads/gallery/gallery_248.jpg) *(image)* |
| 26 | jilla-sahakari-kendriya-bank-maryadit-ambikapur | FD | [jskbambikapur.bank.in](https://jskbambikapur.bank.in) |
| 27 | jilla-sahakari-kendriya-bank-maryadit-balaghat | FD | *(no URL)* |
| 28 | jilla-sahakari-kendriya-bank-maryadit-jhabua | FD | *(no URL)* |
| 29 | jilla-sahakari-kendriya-bank-maryadit-khargone | FD | *(no URL)* |
| 30 | jilla-sahakari-kendriya-bank-maryadit-morena | FD | *(no URL)* |
| 31 | jilla-sahakari-kendriya-bank-maryadit-raisen | FD | *(no URL)* |
| 32 | jilla-sahakari-kendriya-bank-maryadit-rajgarh | FD | *(no URL)* |
| 33 | jilla-sahakari-kendriya-bank-maryadit-seoni | FD | *(no URL)* |
| 34 | jilla-sahakari-kendriya-bank-maryadit-shahdol | FD | *(no URL)* |
| 35 | jilla-sahakari-kendriya-bank-maryadit-sidhi | FD | *(no URL)* |
| 36 | karnataka-central-co-operative-bank-ltd | FD | *(no URL)* |
| 37 | kolar-district-central-co-operative-bank-ltd | FD | *(no URL)* |
| 38 | kookmin-bank | FCNR | [kbstar.bank.in/fcnr-deposits](https://kbstar.bank.in/fcnr-deposits) |
| 39 | kookmin-bank | NRE | [kbstar.bank.in/nre-deposits](https://kbstar.bank.in/nre-deposits) |
| 40 | kookmin-bank | NRO | [kbstar.bank.in/nro-deposits](https://kbstar.bank.in/nro-deposits) |
| 41 | kotak-mahindra-bank-ibu | GIFT | [kotak.bank.in/.../deposit-rates-gift-City.html](https://kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html) |
| 42 | madurai-district-central-co-operative-bank-ltd | FD | [maduraidccb.bank.in](https://maduraidccb.bank.in/) |
| 43 | mainpuri-district-co-operative-bank-ltd | FD | *(no URL)* |
| 44 | medak-district-co-operative-central-bank-ltd | FD | [medakdccb.bank.in/term-deposit/](https://medakdccb.bank.in/term-deposit/) |
| 45 | meerut-district-co-operative-bank-ltd | FD | *(no URL)* |
| 46 | meghalaya-rural-bank | FD | [meghalayaruralbank.bank.in/fd.php](https://meghalayaruralbank.bank.in/fd.php) |
| 47 | mirzapur-zilla-sahakari-bank-ltd | FD | *(no URL)* |
| 48 | murshidabad-district-central-co-operative-bank-ltd | FD | *(no URL)* |
| 49 | nizamabad-district-co-operative-central-bank-ltd | FD | [nizamabaddccb.bank.in/fixed-deposit/](https://nizamabaddccb.bank.in/fixed-deposit/) |
| 50 | panipat-central-co-operative-bank-ltd | FD | *(no URL)* |
| 51 | pratapgarh-jilla-sahakari-bank-ltd | FD | *(no URL)* |
| 52 | pt-bank-maybank-indonesia-tbk | FCNR | [maybank.co.in/fcnr.html](https://maybank.co.in/fcnr.html) |
| 53 | pt-bank-maybank-indonesia-tbk | NRE | [maybank.co.in/nri_dep.html](https://maybank.co.in/nri_dep.html) |
| 54 | pt-bank-maybank-indonesia-tbk | NRO | *(no URL)* |
| 55 | rajkot-nagrik-sahakari-bank-ltd | FD | [rnsb.bank.in/admin/uploads/banners.JPG](https://rnsb.bank.in/admin/uploads/banners.JPG) *(image)* |
| 56 | rampur-district-co-operative-bank-ltd | FD | *(no URL)* |
| 57 | rewari-central-co-operative-bank-ltd | FD | *(no URL)* |
| 58 | samata-sahakari-bank-ltd-mumbai | FD | [samatabank.com/fixed_deposit](https://samatabank.com/fixed_deposit) |
| 59 | sangli-district-central-co-operative-bank-ltd | FD | [sanglidccbank.com](https://www.sanglidccbank.com) |
| 60 | shri-shiddheshwar-co-operative-bank-ltd-bijapur | FD | [shiddeshwarbank.com/...INTEREST_RATES](https://shiddeshwarbank.com/index.aspx?Cmd=Menu&Comp=Cms&Action=ArtById&MenuId=202&ArtId=37&PublicFile=INTEREST_RATES) |
| 61 | the-anantapur-district-co-operative-central-bank-ltd | FD | [anantapurdccb.bank.in/rate-of-interest/](https://anantapurdccb.bank.in/rate-of-interest/) |
| 62 | the-jammu-and-kashmir-state-co-operative-bank-ltd | FD | [coopbank.co.in/...jksx/](https://coopbank.co.in/the-jammu-and-kashmir-state-cooperative-bank-jscb-jksx/) |
| 63 | the-mehsana-district-central-co-operative-bank-ltd | FD | [mdccb.in](https://mdccb.in) |
| 64 | the-surendranagar-district-co-operative-bank-ltd | FD | *(no URL)* |
| 65 | thoothukudi-central-co-operative-bank-ltd | FD | *(no URL)* |
| *(+78 more)* | Various co-op & district banks | FD | *(run `node scripts/find-no-url-banks.js` to see full list)* |

</details>

---

### 🚫 No Public Rate Page (1 bank)
> Bank has no own website or public FD rate disclosure page.

| # | Bank | Variant | Note |
|---|---|---|---|
| 1 | vysya-co-operative-bank-ltd-tumkur | FD | Axis-sponsored bank (IFSC: UTIB0SVCBL1). No independent website or public FD rate page exists. |

---

### 🗑 Data Error / Cleared (2 banks)
> Rate file was found to contain wrong data (cross-bank contamination) and was cleared to 0 slabs pending correct data entry.

| # | Bank | Variant | Note |
|---|---|---|---|
| 1 | erode-co-operative-urban-bank-ltd | FD | Data cleared pending re-extraction |
| 2 | the-amravati-merchants-co-operative-bank-ltd | FD | Sprint-008: wrongly mapped data removed |

---

### Summary: Zero Slab Banks by Category

| Failure Reason | Bank Count | Priority | Recommended Action |
|---|---|---|---|
| **WAF / HTTP 403 Blocked** | 6 | 🔴 High | Manual browser fetch |
| **HTTP 404 / Page Not Found** | 4 | 🔴 High | Find new URL, update registry |
| **DNS / Domain Unreachable** | 7 | 🟠 Medium | Check if domain still live |
| **Timeout** | 2 | 🟠 Medium | Retry off-peak or fetch manually |
| **PDF Error** | 3 | 🟠 Medium | Download & transcribe PDF manually |
| **No Rate Page Registered** | 143 | 🟡 Low | Discover URL and register |
| **No Public Rate Page** | 1 | ⚪ Skip | Mark as `inactive` |
| **Data Error / Cleared** | 2 | 🟠 Medium | Re-enter correct data |
| **Unknown / Unclassified** | 70 | 🟡 Low | Investigate individually |
| **Total** | **237** | — | — |
