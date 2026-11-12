# Step 6: Rate Discovery Agent Expansion — NRE, NRO, FCNR, GIFT City FD

## Background

The BIRD platform is expanding from domestic-only FD rates to include international/NRI deposit products. The schema, API, and frontend have already been updated (Steps 1-5) to support:

- **New product variants:** NRE, NRO,`fcnr`, `gift` (added to `packages/shared/src/schemas/product.ts`)
- **New bank categories:** `IBU` (37 IFSC Banking Units), `HFC` (7 Housing Finance Companies)
- **New DB column:** `currency` on `rate_slabs` (default `'INR'`, for FCNR/GIFT rates in USD/GBP/EUR/AED)
- **New API endpoint:** `GET /api/rates/dashboard` returns best rates for 7 domestic rows + 4 FCNR currency rows + 4 GIFT currency rows

The dashboard currently shows "Coming soon" for NRE, NRO, FCNR, and GIFT rows because no rate data exists for those variants yet. This step populates that data.

## What Already Exists

### Schema Support (already done)
- `products.variant` accepts: `regular`, `senior_citizen`, `super_senior`, `nre`, `nro`, `fcnr`, `gift`, `tax_saving`, `flexi`, `green`, `special_tenure`, `women`, `minor`, `staff`
- `rate_slabs.currency` stores currency code (default `'INR'`; `USD`, `GBP`, `EUR`, `AED` for FCNR/GIFT)

### Agent Already Discovers Some NRI URLs
Axis Bank's entry in `data/bank-domains.json` already has:
```json
{
  "axis_bank": {
    "domain": "axis.bank.in",
    "rate_pages": {
      "fd": "/deposits/fixed-deposits/fd-interest-rates",
      "fd_pdf_domestic": "/docs/.../domestic-fixed-deposits-27-march-26.pdf",
      "fd_pdf_nri": "/docs/.../nri-fixed-deposits-27-march-26.pdf",
      "fd_pdf_fcnr": "/docs/.../fcnr-rfc-deposits-02-march-26.pdf"
    }
  }
}
```

But the agent doesn't systematically discover NRI/FCNR pages for other banks, and the extraction pipeline doesn't output separate rate files per variant.

### IBU and HFC Master Data (already done)
- `docs/gift-city-ibus.json` — 37 IFSC Banking Units (SBI IBU, HDFC IBU, etc.)
- `docs/housing-finance-companies.json` — 7 NHB-registered deposit-accepting HFCs
- Seed generator updated to import both into the `banks` table

## Tasks

### Task 1: Update CLAUDE.md — Discover NRI/NRO/FCNR Rate Pages

**File:** `rate-discovery-agent/CLAUDE.md`

The agent's Step 2 (Find Interest Rate Pages) currently focuses on finding the main FD rate page. Expand it to also discover NRI deposit pages.

**What to add to Step 2:**

After finding the main FD rate page, the agent should also search for:
- **NRE/NRO deposits page** — Search keywords: `NRE deposit`, `NRO deposit`, `NRI fixed deposit`, `non-resident deposit rates`
- **FCNR deposits page** — Search keywords: `FCNR deposit rates`, `foreign currency deposit`, `FCNR-B rates`
- Common URL patterns: `/nri-deposits`, `/nri-interest-rates`, `/nri-fd-rates`, `/fcnr-rates`, `/foreign-currency-deposits`
- Many banks have a single "NRI Banking" or "NRI Deposits" page covering NRE + NRO + FCNR
- Some banks publish these as separate PDFs (like Axis Bank)
- for FCNR products, currency also has to be stored with each row
**What to add to the config output (Step 5):**

The `rate_page_urls` object should include additional keys:
```json
{
  "rate_page_urls": {
    "fd": "...",            // existing domestic FD page
    "fd_nre": "...",        // NRE FD rates page/PDF (null if not found)
    "fd_nro": "...",        // NRO FD rates page/PDF (null if same as NRE)
    "fd_fcnr": "...",       // FCNR rates page/PDF (null if not found)
    "fd_nri_combined": "..."// combined NRI page if NRE/NRO/FCNR are on one page
  }
}
```

**Important notes for the agent:**
- Not all banks offer NRE/NRO/FCNR deposits. If not found, set to `null` — don't force it.
- Foreign banks in India almost always have NRE/NRO/FCNR products.
- PSBs and large PVBs always have them. SFBs and co-op banks usually don't.
- FCNR rates are denominated in foreign currencies (USD, GBP, EUR, JPY, CAD, AUD, etc.) — not INR.
- NRE and NRO rates are in INR but targeted at NRI customers. NRE rates are often the same as domestic rates; NRO may differ.

### Task 2: Update bank-domains.json for Existing Banks

**File:** `rate-discovery-agent/data/bank-domains.json`

For banks already in `bank-domains.json` (~96 banks), the agent should revisit their websites to discover NRI rate page URLs and amend the existing entries. This is more efficient than full re-discovery since domains are already known.

**Approach:**
1. For each bank in `bank-domains.json` that has a `domain` but no `fd_nre`/`fd_nro`/`fd_fcnr` keys:
   - Fetch the bank's homepage
   - Look for NRI banking section links
   - Record NRI rate page URLs if found
   - Update the entry in `bank-domains.json`

2. Priority order for this sweep:
   - **First:** All Foreign Banks (FB) — they almost always have NRE/NRO/FCNR
   - **Second:** All PSBs and large PVBs — they always have them
   - **Third:** SFBs — some offer NRE/NRO
   - **Skip:** Co-op banks, RRBs, Payment Banks — rarely offer NRI products

3. Add new entries for IBUs and HFCs (not currently in bank-domains.json):
   - **IBUs:** Most IBU rate pages are under the parent bank's GIFT City or IFSC section. Example: SBI IBU rates might be at `sbi.co.in/web/gift-ifsc/deposit-rates`
   - **HFCs:** The 7 deposit-accepting HFCs from `docs/housing-finance-companies.json`

### Task 3: Extract NRI/FCNR Rates — Multi-Variant Output

**File:** `rate-discovery-agent/scripts/extract_rates.js`

Currently, the extractor outputs a single `<bank_code>_rates.json` file with `variant: "regular"`. It needs to produce separate files per variant.

**Changes needed:**

1. **For banks with separate NRI pages/PDFs:**
   - If config has `fd_nre`, extract NRE rates into `<bank_code>_nre_rates.json` with `"variant": "nre"`
   - If config has `fd_nro`, extract NRO rates into `<bank_code>_nro_rates.json` with `"variant": "nro"`
   - If config has `fd_fcnr`, extract FCNR rates into `<bank_code>_fcnr_rates.json` with `"variant": "fcnr"`
   - If config has `fd_nri_combined`, extract and split by section headers in the page/PDF

2. **For FCNR specifically — currency handling:**
   - FCNR rate pages/PDFs typically show rates per currency (USD, GBP, EUR, JPY, CAD, AUD, etc.)
   - Each slab in the output must include a `"currency"` field: `"USD"`, `"GBP"`, `"EUR"`, etc.
   - The PDF/HTML usually has a table per currency, or columns per currency
   - Example FCNR rate structure:
     ```json
     {
       "bank_code": "axis-bank",
       "product_type": "FD",
       "variant": "fcnr",
       "rate_slabs": [
         { "tenure_text": "1 year to 2 years", "tenure_min_days": 365, "tenure_max_days": 730, "rate_general_pct": 5.35, "currency": "USD" },
         { "tenure_text": "1 year to 2 years", "tenure_min_days": 365, "tenure_max_days": 730, "rate_general_pct": 4.80, "currency": "GBP" },
         { "tenure_text": "1 year to 2 years", "tenure_min_days": 365, "tenure_max_days": 730, "rate_general_pct": 3.15, "currency": "EUR" }
       ]
     }
     ```
   - FCNR rates do NOT have senior citizen or super-senior variants (only general rate)
   - FCNR minimum tenure is typically 1 year (365 days), max 5 years

3. **For multi-table PDFs (like Citibank):**
   - The existing PDF extractor already handles multi-table PDFs
   - When a PDF has sections labeled "Resident", "NRO", "NRE", etc., the extractor should:
     - Detect section headers
     - Tag slabs with the appropriate variant
     - Output separate files per variant

### Task 4: GIFT City / IFSC Banking Unit Rate Discovery

**New capability** — Discover and extract rates from IFSC Banking Units.

**Background:**
- IBUs operate under IFSCA (International Financial Services Centres Authority), not directly under RBI
- IBU deposits are in foreign currency (USD, GBP, EUR, etc.) — not INR
- IBU deposits are NOT covered by DICGC insurance
- IBU rate pages are typically found under the parent bank's IFSC/GIFT City section

**Discovery approach:**
- For each IBU in `docs/gift-city-ibus.json`, the parent bank's website should have an IFSC section
- Search patterns: `site:<parent_domain> GIFT City deposit rates`, `site:<parent_domain> IFSC banking unit`
- Common URL patterns: `/gift-ifsc/`, `/ifsc-banking/`, `/international-banking/gift-city/`
- Many IBUs share rate pages with their parent bank's FCNR section (same foreign currency deposit rates)
- Some IBUs have dedicated microsite or PDF rate cards

**Output:**
- Config: `<ibu_code>_config.json` with `bank_type: "IBU"`
- Rates: `<ibu_code>_rates.json` with `variant: "gift"` and `currency` per slab

### Task 5: Update Import Pipeline for Multi-Variant Rates

**File:** `packages/scraper/src/import/import-discovery.ts`

The import pipeline needs to handle the new rate file variants.

**Changes:**

1. **File discovery:** When scanning the output directory, look for:
   - `<bank_code>_rates.json` → variant `regular` (existing behavior)
   - `<bank_code>_nre_rates.json` → variant `nre`
   - `<bank_code>_nro_rates.json` → variant `nro`
   - `<bank_code>_fcnr_rates.json` → variant `fcnr`
   - `<bank_code>_gift_rates.json` → variant `gift` (for IBUs)

2. **Product matching:** For each variant file:
   - Find or create the `products` row with matching `(bank_id, product_type='FD', variant=<variant>)`
   - Currently only creates `variant='regular'`; extend to create NRE/NRO/FCNR/GIFT products

3. **Currency column:** For FCNR and GIFT rates:
   - Read `currency` from each slab in the rate file
   - Set `rate_slabs.currency` to that value (instead of default `'INR'`)
   - If `currency` is missing, default to `'INR'` for NRE/NRO, `'USD'` for FCNR/GIFT

4. **Rate change detection:** When comparing new slabs to existing active ones:
   - Match must also consider `currency` for FCNR/GIFT (same tenure + same currency = same slab)

### Task 6: Update Validation Rules

**File:** `packages/scraper/src/validators/`

**FCNR-specific validation:**
- Rate range: **0.5% – 8.0%** (significantly lower than domestic FD range of 2.5% – 9.5%)
- No senior citizen premium (FCNR has only general rate)
- Minimum tenure: 365 days (1 year) for FCNR
- Maximum tenure: 1825 days (5 years) for FCNR

**NRE-specific validation:**
- Rate range: **2.0% – 9.5%** (similar to domestic)
- May or may not have senior citizen rates
- Minimum tenure: 365 days (1 year) for NRE term deposits

**NRO-specific validation:**
- Rate range: **2.0% – 9.5%** (similar to domestic)
- Usually has same tenure structure as domestic

**GIFT City validation:**
- Rate range: **0.5% – 8.0%** (foreign currency rates, similar to FCNR)
- Must have `currency` field set (not INR)

## Execution Order

1. **Task 1** (CLAUDE.md update) — Do this first so all subsequent discovery uses the new instructions
2. **Task 2** (bank-domains.json sweep) — Run a targeted sweep of existing banks for NRI pages
3. **Task 3** (extract_rates.js) — Update extraction to produce multi-variant output files
4. **Task 5** (import pipeline) — Update import to handle new file naming and currency column
5. **Task 6** (validation) — Add variant-specific rate range rules
6. **Task 4** (GIFT City discovery) — Run discovery for IBUs last (separate bank entities)

## Testing Strategy

1. **Start with Axis Bank** — Already has NRI/FCNR PDF URLs in bank-domains.json. Extract NRE, NRO, FCNR rate files. Verify currency tagging on FCNR slabs.

2. **SBI** — Large PSB, always has NRE/NRO/FCNR. Good validation target since their rates are well-known.

3. **HDFC Bank / ICICI Bank** — PVB with comprehensive NRI product pages.

4. **One SBI IBU** — Test GIFT City FD extraction.

5. **Verify dashboard:** After import, `GET /api/rates/dashboard` should return non-null data for NRE, NRO, FCNR, and GIFT rows.

## Reference: Product Variant Summary

| Variant | Currency | Offered By | Tenure Range | Rate Range |
|---------|----------|-----------|-------------|-----------|
| `regular` | INR | All banks | 7d – 10y | 2.5% – 9.5% |
| `nre` | INR | PSB, PVB, SFB, FB | 1y – 10y | 2.0% – 9.5% |
| `nro` | INR | PSB, PVB, SFB, FB | 7d – 10y | 2.0% – 9.5% |
| `fcnr` | USD/GBP/EUR/AED/etc. | PSB, PVB, FB | 1y – 5y | 0.5% – 8.0% |
| `gift` | USD/GBP/EUR/AED/etc. | IBU | 1y – 5y | 0.5% – 8.0% |
