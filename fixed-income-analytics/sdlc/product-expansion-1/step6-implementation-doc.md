# Step 6: Rate Discovery Agent Expansion — Implementation Doc

## Completed: 2026-03-30

---

## Scope

Step 6 extends the rate discovery agent and import pipeline to support NRI deposit products (NRE, NRO, FCNR) and two new bank categories (IBU, HFC). Steps 1-5 had already added schema support — this step makes the agent actually discover, extract, validate, and import multi-variant rate data.

**What was added:**
1. Agent instructions for discovering NRI/FCNR/GIFT City rate pages
2. Multi-variant extraction in the deterministic rate extractor
3. Variant-aware validation (agent-side and import-side)
4. Multi-variant file scanning and currency-aware import pipeline
5. 37 IBU + 7 HFC entries in the bank domains registry

---

## What Was Built

### 1. CLAUDE.md — NRI/FCNR/IBU Discovery Instructions

**File:** `rate-discovery-agent/CLAUDE.md`

Three new subsections added to the discovery workflow:

**Step 2b: Find NRI/FCNR Rate Pages** — After finding the domestic FD rate page, the agent now searches for NRI deposit pages using keywords (`NRE deposit`, `NRO deposit`, `FCNR deposit rates`, `FCNR-B rates`) and URL patterns (`/nri-deposits`, `/nri-interest-rates`, `/fcnr-rates`). The agent records URLs in new config fields:

```json
"rate_page_urls": {
  "fd": "...",
  "fd_nre": "...",
  "fd_nro": "...",
  "fd_fcnr": "...",
  "fd_nri_combined": "..."
}
```

Key guidance encoded in the instructions:
- PSB, PVB, FB: always search for NRI pages
- SFB: search for larger SFBs only
- Co-ops, RRBs, PBs: skip — they rarely offer NRI products
- NRE/NRO rates are in INR; FCNR rates are in foreign currencies (USD, GBP, EUR, etc.)
- FCNR has no senior citizen premium and a tenure range of 1-5 years only
- Many banks have a single combined NRI page; others publish separate PDFs per variant

**Step 2c: Find GIFT City / IFSC Rate Pages** — Only applies to IBU banks. Searches the parent bank's domain for IFSC/GIFT City sections using URL patterns like `/gift-ifsc/`, `/ifsc-banking/`, `/international-banking/gift-city/`. The `parent_bank_code` field in `bank-domains.json` links IBUs to their parent bank's domain.

**Step 0 update** — Known domain lookup now also checks for `fd_nre`/`fd_nro`/`fd_fcnr` keys. Added handling for `parent_bank_code` (IBU banks look up the parent's domain).

**Bank Type table** — Added `IBU` (IFSC Banking Unit) and `HFC` (Housing Finance Company).

**Output directory** — Documented variant rate file naming: `<code>_nre_rates.json`, `<code>_nro_rates.json`, `<code>_fcnr_rates.json`, `<code>_gift_rates.json`. FCNR/GIFT files require a `currency` field on each slab.

---

### 2. Multi-Variant Extraction (`extract_rates.js`)

**File:** `rate-discovery-agent/scripts/extract_rates.js`

The extractor was refactored to handle multiple product variants per bank. Previously, `extractBank(code)` read one config and produced one `_rates.json` file with `variant: "regular"`. Now it:

1. Extracts domestic FD rates as before (unchanged behavior)
2. Loops through NRI variants (`nre`, `nro`, `fcnr`), checking for URLs in the config
3. Falls back to `fd_nri_combined` URL for NRE/NRO if specific URLs aren't set
4. Routes each variant through the same scraper infrastructure (`routeExtraction()`)
5. Writes separate files: `<code>_nre_rates.json`, `<code>_fcnr_rates.json`, etc.

**New function: `routeExtraction(config, url, variant)`** — A shared scraper router that takes any URL and routes to the correct extraction method (HTML static, Playwright, PDF) based on the config's `scraper_type`. It also detects PDF URLs by extension, overriding the scraper type when a variant points directly to a PDF.

**New function: `writeRatesFile(code, config, result, variant, sourceUrl)`** — Centralizes rate file writing with variant-aware validation and naming.

**Currency tagging:**
- NRE/NRO slabs: tagged with `currency: "INR"`
- FCNR slabs: currency should come from the extractor (per-slab, based on section headers in the PDF/HTML). If missing, a warning is logged but no silent default is applied to avoid data corruption.

**PDF extractor integration:** When extracting FCNR variants, passes `--variant fcnr` to `extract_rates_pdf.mjs` so it can detect currency section headers.

**Return type change:** `extractBank()` now returns `{ domestic: boolean, nre: boolean, nro: boolean, fcnr: boolean }` instead of a flat boolean. The batch summary reports total variant files written.

---

### 3. Variant-Aware Validation (Agent-Side)

**File:** `rate-discovery-agent/scripts/utils/validate-rates.js`

Added variant-specific rate bounds and tenure constraints:

| Variant | Rate Range | Tenure Range | Senior Citizen |
|---------|-----------|-------------|---------------|
| `regular` | 1.50% – 9.50% | 7d – 10y | Yes |
| `nre` | 2.00% – 9.50% | 1y – 10y | Yes |
| `nro` | 2.00% – 9.50% | 7d – 10y | Yes |
| `fcnr` | 0.50% – 8.00% | 1y – 5y | No |
| `gift` | 0.50% – 8.00% | 1y – 5y | No |

`validateSlabs(slabs, variant)` now accepts an optional second parameter. Changes:
- Uses `VARIANT_BOUNDS` for rate range checks when a variant is specified
- Skips senior/super-senior rate checks for FCNR/GIFT (flags as warning if present)
- Validates tenure against `VARIANT_TENURE` constraints (365-1825 days for FCNR/GIFT)
- Checks that FCNR/GIFT slabs have a `currency` field

The CLI (`node scripts/utils/validate-rates.js <file> --variant fcnr`) reads variant from the `--variant` flag or from the file's `variant` field.

Backward compatible: calling `validateSlabs(slabs)` without a variant works exactly as before.

---

### 4. Variant-Aware Validation (Import-Side)

**Files:**
- `packages/scraper/src/validators/types.ts`
- `packages/scraper/src/validators/range.ts`
- `packages/scraper/src/validators/index.ts`

**types.ts** — Added `currency?: string` to both `RawSlab` and `ActiveSlab`. Optional fields so existing code using these types continues to compile.

**range.ts** — `validateRange(slabs, productType, variant?)` now accepts an optional `variant` parameter.

Added `VARIANT_RATE_RANGES` lookup and `getRateRange(productType, variant)` helper. When a variant is specified and has an entry in the lookup, its bounds override the product-type defaults from `PRODUCT_TYPES`.

For FCNR/GIFT (`NO_SENIOR_VARIANTS` set): senior citizen rates are flagged as `severity: "info"` rather than validated — these variants don't have senior premiums, so the presence of one is noteworthy but not an error.

**index.ts** — Added `variant?: string` to `ImportValidationContext`. Passes it through to `validateRange()` in Layer 2.

Backward compatible: `validateRange(slabs, productType)` without variant works identically to before. The `variant` field in `ImportValidationContext` is optional.

---

### 5. Import Pipeline — Multi-Variant File Discovery + Currency

**File:** `packages/scraper/src/import/import-discovery.ts`

**Multi-file scanning:** `importConfig()` now looks for variant rate files alongside the standard `_rates.json`:
- `<code>_nre_rates.json`
- `<code>_nro_rates.json`
- `<code>_fcnr_rates.json`
- `<code>_gift_rates.json`

Each found file is passed to `importRates()`, which reads the `variant` field from the JSON to create the correct product record.

**Currency in resolved slabs:** The slab resolution step now passes `currency` through from the agent output. For domestic/NRE/NRO variants, defaults to `"INR"` if not set. For FCNR/GIFT variants, currency must come from each individual slab — slabs missing currency are logged as warnings and skipped during insert (no silent defaulting to avoid incorrect data).

**Currency-aware slab matching:** The rate versioning logic (which detects changes between new and active slabs) now considers currency for FCNR/GIFT variants. `findMatchingActive()` accepts an optional `currency` parameter. For non-INR currencies, a "1-2 year" USD slab only matches against a "1-2 year" USD active slab — not a GBP or EUR slab at the same tenure.

**ActiveSlab query:** `getActiveSlabs()` now selects the `currency` column so it's available for matching.

**Slab insert:** The `currency` field is written to the `rate_slabs` table on every insert. Falls back to `"INR"` for slabs without an explicit currency (backward compatible with existing domestic data).

Backward compatible: existing domestic rate files (no `currency` field on slabs) import identically to before — the default `"INR"` is applied.

---

### 6. Bank Domains Registry — IBU + HFC Entries

**File:** `rate-discovery-agent/data/bank-domains.json`

**37 IBU entries** added, keyed by the `code` field from `docs/gift-city-ibus.json`. Each entry has:
- `domain`: inherited from the parent bank's existing entry (e.g., `sbi-ibu` gets `sbi.bank.in`)
- `parent_bank_code`: slug pointing to the parent bank's entry for domain lookup
- `rate_pages.fd`: `null` (to be populated during discovery)
- `notes`: "IFSC Banking Unit in GIFT City"

**7 HFC entries** added from `docs/housing-finance-companies.json`. 5 of 7 have known website domains (Can Fin Homes, ICICI Home Finance, LIC Housing Finance, PNB Housing Finance, Sundaram Home Finance). The other 2 (Cent Bank Home Finance, Manipal Housing Finance Syndicate) have `domain: null`.

Total entries in `bank-domains.json`: 140 (up from 96).

---

## Design Decisions

### No silent currency defaults for FCNR/GIFT
FCNR and GIFT City deposits can be in any of several currencies (USD, GBP, EUR, AED, JPY, CAD, AUD, etc.). Rather than defaulting missing currencies to "USD" (which would produce incorrect data for non-USD slabs), the pipeline:
- Logs a warning for slabs missing currency
- Skips them during DB insert
- Relies on the extractor to tag currency correctly at extraction time

This prevents silent data corruption at the cost of potentially dropping slabs that the extractor didn't tag. The agent instructions emphasize that FCNR/GIFT slabs "must include a currency field."

### Backward-compatible API surfaces
All new parameters are optional. Existing callers of `validateSlabs()`, `validateRange()`, `validateImport()`, and `findMatchingActive()` work without modification. The `RawSlab` and `ActiveSlab` types add `currency` as an optional field.

### Reusing scraper infrastructure for variants
Rather than building separate extraction paths for NRI products, `routeExtraction()` reuses the same HTML/Playwright/PDF pipeline. The only variant-specific behavior is:
- PDF extractor receives a `--variant` flag to detect currency section headers
- Currency tagging logic after extraction

---

## Files Changed

| File | Change |
|------|--------|
| `rate-discovery-agent/CLAUDE.md` | Steps 2b, 2c, Step 0 update, config schema, bank types, output docs |
| `rate-discovery-agent/scripts/extract_rates.js` | Multi-variant extraction loop, `routeExtraction()`, `writeRatesFile()`, PDF variant flag |
| `rate-discovery-agent/scripts/utils/validate-rates.js` | `VARIANT_BOUNDS`, `VARIANT_TENURE`, variant-aware `validateSlabs()` |
| `rate-discovery-agent/data/bank-domains.json` | 37 IBU entries, 7 HFC entries |
| `packages/scraper/src/validators/types.ts` | `currency?` on `RawSlab` and `ActiveSlab` |
| `packages/scraper/src/validators/range.ts` | `VARIANT_RATE_RANGES`, `getRateRange()`, variant-aware `validateRange()` |
| `packages/scraper/src/validators/index.ts` | `variant?` on `ImportValidationContext` |
| `packages/scraper/src/import/import-discovery.ts` | Multi-file scan, currency passthrough, currency-aware slab matching |

---

## What's NOT Done Yet (Requires Live Runs)

1. **Actual NRI rate page discovery** — The agent instructions are in place but no banks have been re-discovered yet. Need to run discovery sweeps starting with PSBs, PVBs, and FBs.
2. **FCNR currency tagging in PDF extractor** — `extract_rates_pdf.mjs` receives the `--variant fcnr` flag but doesn't yet parse currency section headers. This will need implementation when processing the first FCNR PDF (Axis Bank is the test case).
3. **IBU/HFC discovery runs** — 37 IBU and 7 HFC entries added to `bank-domains.json` but none have been discovered yet.
4. **Dashboard population** — `GET /api/rates/dashboard` will return data for NRE/NRO/FCNR/GIFT rows once the pipeline has rate data to import.

## Verification Plan

1. **Axis Bank** — Has known NRI/FCNR PDF URLs in `bank-domains.json`. Run `node scripts/extract_rates.js axis-bank-limited` to produce `_nre_rates.json` and `_fcnr_rates.json`.
2. **SBI re-discovery** — Run `node run-discovery.js "State Bank of India" "Public Sector Bank"` — config should include `fd_nre`, `fd_nro`, `fd_fcnr` URLs.
3. **Validation** — Run `node scripts/utils/validate-rates.js output/<bank>_fcnr_rates.json` — should use FCNR bounds (0.5%-8.0%).
4. **Import** — Run `npx tsx packages/scraper/src/cli/import.ts rate-discovery-agent/output/` — should create NRE/NRO/FCNR product records with correct variants and currency values.
