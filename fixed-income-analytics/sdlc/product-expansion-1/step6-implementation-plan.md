# Rate Discovery Expansion: NRE, NRO, FCNR, GIFT City, IBU, HFC

## Context

The BIRD platform currently collects only domestic FD rates (`variant: "regular"`). The product manager wants to expand to NRI deposit products (NRE, NRO, FCNR) and two new bank categories (IBU, HFC). Steps 1-5 of `sdlc/product-expansion-1/` already added schema support (`currency` column on `rate_slabs`, `productVariant` enum with `nre`/`nro`/`fcnr`/`gift`, `IBU`/`HFC` in `BANK_CATEGORIES`). This plan covers **Step 6**: making the rate discovery agent and extraction pipeline actually discover and produce multi-variant rate data.

Source doc: `sdlc/product-expansion-1/step6-rate-discovery-expansion.md`

---

## Scope Summary

6 tasks, split into **agent instructions**, **data plumbing**, and **discovery runs**:

| # | Task | Type | Files |
|---|------|------|-------|
| 1 | Update CLAUDE.md — NRI/FCNR discovery instructions | Docs | `rate-discovery-agent/CLAUDE.md` |
| 2 | Update bank-domains.json — add NRI URL keys + IBU/HFC entries | Data | `rate-discovery-agent/data/bank-domains.json` |
| 3 | Multi-variant extraction in extract_rates.js | Code | `rate-discovery-agent/scripts/extract_rates.js` |
| 4 | GIFT City / IBU discovery prompt additions | Docs+Data | `rate-discovery-agent/CLAUDE.md`, `data/bank-domains.json` |
| 5 | Import pipeline — multi-variant file discovery + currency | Code | `packages/scraper/src/import/import-discovery.ts` |
| 6 | Variant-aware validation | Code | `rate-discovery-agent/scripts/utils/validate-rates.js`, `packages/scraper/src/validators/range.ts` |

---

## Implementation Plan

### Task 1: Update CLAUDE.md — NRI/FCNR Discovery Instructions

**File:** `rate-discovery-agent/CLAUDE.md`

**Changes:**

**1a. Step 2 (Find Interest Rate Pages) — add NRI search after FD discovery:**

After the existing FD rate page search, add a new subsection "Step 2b: Find NRI/FCNR Rate Pages":
- Additional search keywords: `NRE deposit`, `NRO deposit`, `NRI fixed deposit`, `FCNR deposit rates`, `FCNR-B rates`, `foreign currency deposit`
- Additional URL patterns: `/nri-deposits`, `/nri-interest-rates`, `/nri-fd-rates`, `/fcnr-rates`, `/foreign-currency-deposits`, `/nri-banking`
- Note: many banks have a single combined NRI page; some publish separate PDFs per variant (like Axis Bank)
- Note: FCNR rates are in foreign currencies (USD, GBP, EUR, etc.) — not INR
- Guidance on which bank types to check: PSB/PVB/FB always have NRI products; SFBs sometimes; co-ops/RRBs/PBs rarely

**1b. Step 5 (Generate Config) — extend `rate_page_urls`:**

Add new keys to the config schema:
```json
"rate_page_urls": {
  "fd": "...",
  "fd_nre": "...",
  "fd_nro": "...",
  "fd_fcnr": "...",
  "fd_nri_combined": "..."
}
```

**1c. Bank Type table — add IBU and HFC rows:**

| Category | bank_type |
|----------|-----------|
| IFSC Banking Unit | IBU |
| Housing Finance Company | HFC |

**1d. Add GIFT City discovery subsection (for Task 4):**

New "Step 2c: GIFT City / IFSC Rate Pages" subsection:
- Only applies when discovering IBU banks
- Search parent bank's site for IFSC/GIFT City sections
- URL patterns: `/gift-ifsc/`, `/ifsc-banking/`, `/international-banking/gift-city/`
- Output variant is `gift`, currency per slab (USD, GBP, EUR, etc.)
- IBU deposits are NOT covered by DICGC insurance

---

### Task 2: Update bank-domains.json

**File:** `rate-discovery-agent/data/bank-domains.json`

**2a. Add NRI URL key stubs to existing entries:**

For all existing entries that have a `domain` and `rate_pages.fd`, add placeholder keys `fd_nre`, `fd_nro`, `fd_fcnr` set to `null`. This signals to the agent that these fields exist and should be populated during future discovery sweeps.

We already have a working example in the `axis_bank` entry with `fd_pdf_nri` and `fd_pdf_fcnr`.

**2b. Add IBU entries from `docs/gift-city-ibus.json`:**

For each of the 37 IBUs, add an entry keyed by their `code` field, with:
- `domain`: same as parent bank's domain (look up from existing entries)
- `rate_pages`: `{ "fd": null }` (to be populated during GIFT City discovery)
- `parent_bank_code`: link to parent bank's slug
- `scraper_type`: null (unknown until discovered)

**2c. Add HFC entries from `docs/housing-finance-companies.json`:**

For each of the 7 HFCs (5 with websites), add an entry with:
- `domain`: from the JSON's `website_url` field
- `rate_pages`: `{ "fd": null }`
- `scraper_type`: null

---

### Task 3: Multi-Variant Extraction in extract_rates.js

**File:** `rate-discovery-agent/scripts/extract_rates.js`

This is the core code change. Currently `extractBank(code)` reads one config, extracts one `_rates.json` with `variant: "regular"`. It needs to also extract NRE/NRO/FCNR variants when the config has those URLs.

**3a. Add variant extraction loop in `extractBank()`:**

After the existing domestic FD extraction (which stays as-is), add:

```
for each variant in ['nre', 'nro', 'fcnr']:
  url = config.rate_page_urls[`fd_${variant}`]
       || (variant !== 'fcnr' ? config.rate_page_urls.fd_nri_combined : null)
  if !url: skip

  result = extract using same scraper_type routing (html_static/html_js/pdf)

  write to output/<bank_code>_<variant>_rates.json with:
    - variant: <variant>
    - currency: 'INR' for nre/nro, per-slab for fcnr
```

**3b. FCNR currency handling:**

For FCNR PDFs/pages, the extractor needs to tag each slab with its currency. Most FCNR rate cards have sections per currency (USD, GBP, EUR, JPY, CAD, AUD). The PDF extractor (`extract_rates_pdf.mjs`) will need a mode flag to detect currency section headers.

Approach: Pass a `--variant fcnr` flag to the PDF extractor. When set, it looks for currency headers (e.g., "US Dollar", "Pound Sterling", "Euro") and tags slabs accordingly. FCNR slabs have NO senior/super-senior rates.

**3c. Update `extractBank()` return to handle multi-file output:**

Currently returns `boolean`. Change to return `{ domestic: boolean, nre: boolean, nro: boolean, fcnr: boolean }` for reporting.

**3d. Variant-aware validation:**

Call `validateSlabs()` with variant context so FCNR gets different bounds (see Task 6).

---

### Task 4: GIFT City / IBU Discovery

This is primarily handled by the CLAUDE.md instructions (Task 1d) + bank-domains.json entries (Task 2b). No additional code changes needed — the agent uses the same `run-discovery.js` flow. The key difference is:

- IBU configs should set `bank_type: "IBU"`, `deposit_insurance: false`
- IBU rate files should use `variant: "gift"` and include `currency` per slab
- Discovery searches the parent bank's domain for IFSC/GIFT City sections

The batch script already supports custom categories. IBU banks will be added to the master CSV (or run from the JSON directly).

---

### Task 5: Import Pipeline — Multi-Variant File Discovery

**File:** `packages/scraper/src/import/import-discovery.ts`

**5a. Scan for variant rate files:**

Currently `importBank()` (line 263) looks for `<code>_rates.json` only. Change to also scan for:
- `<code>_nre_rates.json`
- `<code>_nro_rates.json`
- `<code>_fcnr_rates.json`
- `<code>_gift_rates.json`

For each found file, call `importRates()` with the appropriate variant (already read from the file's `variant` field).

**5b. Currency column handling:**

In `importRates()` (line 289-313), when building resolved slabs, pass through the `currency` field from each slab. Currently the `resolvedSlabs` mapping doesn't include `currency`. Add:
```ts
currency: s.currency ?? (variant === 'fcnr' || variant === 'gift' ? 'USD' : 'INR'),
```

When inserting into `rate_slabs` DB table, include the `currency` value.

**5c. Currency-aware slab matching:**

In the versioning logic (active slab comparison), match by tenure range AND currency for FCNR/GIFT variants. Two slabs with same tenure but different currencies (e.g., 1Y USD vs 1Y GBP) are distinct slabs.

**5d. Update RawSlab type:**

In `packages/scraper/src/validators/types.ts`, add `currency?: string` to `RawSlab`.

---

### Task 6: Variant-Aware Validation

**6a. Agent-side validation (`scripts/utils/validate-rates.js`):**

Add variant-specific rate bounds:

```js
const RATE_BOUNDS = {
  general:       { min: 1.50, max: 9.50 },  // existing
  senior:        { min: 1.50, max: 10.50 }, // existing
  super_senior:  { min: 1.50, max: 10.50 }, // existing
  fcnr:          { min: 0.50, max: 8.00 },  // new
  gift:          { min: 0.50, max: 8.00 },  // new
  nre:           { min: 2.00, max: 9.50 },  // new
  nro:           { min: 2.00, max: 9.50 },  // new
};
```

Update `validateSlabs(slabs, variant)` to accept an optional variant parameter and use the appropriate bounds. For FCNR: skip senior/super-senior checks (they don't apply). For FCNR/GIFT: validate tenure range is 365-1825 days.

**6b. Import-side validation (`packages/scraper/src/validators/range.ts`):**

Currently uses `PRODUCT_TYPES[productType].rateRange`. For variant-specific bounds, add a helper:

```ts
function getVariantRateRange(productType: string, variant: string): { min: number; max: number } {
  if (variant === 'fcnr' || variant === 'gift') return { min: 0.5, max: 8.0 };
  if (variant === 'nre') return { min: 2.0, max: 9.5 };
  if (variant === 'nro') return { min: 2.0, max: 9.5 };
  return PRODUCT_TYPES[productType as ProductType]?.rateRange ?? { min: 2.5, max: 9.5 };
}
```

Pass `variant` through the `ImportValidationContext` (add field to `types.ts`). Update `validateRange()` to call `getVariantRateRange()`.

For FCNR/GIFT: skip senior citizen rate checks entirely (flag as info if present).

---

## Execution Order

```
Task 1  (CLAUDE.md)       — Do first, all subsequent discovery uses new instructions
Task 6a (validate-rates.js) — Needed before extraction runs
Task 3  (extract_rates.js)  — Multi-variant extraction code
Task 2  (bank-domains.json) — Add URL stubs + IBU/HFC entries
Task 6b (range.ts + types)  — Import-side validation
Task 5  (import-discovery)  — Multi-variant file scanning + currency
Task 4  (IBU discovery runs) — Run last, after all code is ready
```

Tasks 1, 6a can be done in parallel. Tasks 3, 2 can be done in parallel after that. Tasks 5, 6b can be done in parallel. Task 4 is last.

---

## Verification

1. **Axis Bank (existing NRI PDFs):** Run `node scripts/extract_rates.js axis-bank-limited` — should produce `axis-bank-limited_nre_rates.json`, `axis-bank-limited_fcnr_rates.json` with currency tags on FCNR slabs
2. **SBI re-discovery:** Run `node run-discovery.js "State Bank of India" "Public Sector Bank"` — config should now include `fd_nre`, `fd_nro`, `fd_fcnr` URLs
3. **Validation:** Run `node scripts/utils/validate-rates.js output/axis-bank-limited_fcnr_rates.json` — should use FCNR bounds (0.5%-8.0%)
4. **Import:** Run `npx tsx packages/scraper/src/cli/import.ts rate-discovery-agent/output/` — should import NRE/NRO/FCNR rate files, create products with correct variants, set currency on FCNR slabs
5. **Dashboard:** `GET /api/rates/dashboard` should return non-null data for NRE/NRO/FCNR rows after import
