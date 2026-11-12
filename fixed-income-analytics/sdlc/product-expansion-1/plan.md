# Phase 5: Public Dashboard & Multi-Product FD Rates

## Context

PM feedback: The homepage (visible without login) should show a simple dashboard table of best rates across multiple bank categories and FD types — 9 rows, one per category, each showing the single best rate. This replaces the current single "Best FD Rates Today" table. The expansion requires collecting NRE, NRO, FCNR, and GIFT City FD rates, adding IFSC Banking Units + Housing Finance Companies to the bank master list, and a new aggregated API endpoint.

**Key decisions:**
- Corporate FDs — excluded for now
- Dashboard = most categories show as simple rows (not cards except for FCNR and GIFT), one per category
- FCNR row is a card that  shows 4 currencies (USD, GBP, EUR, AED) with "show more" link. Likewise the IFSC i.e. GIFT
- `/fd` stays behind login — dashboard rows link to `/login` with return URL
- HFC = new bank category, separate from NBFC
- Co-op row = all co-op types: SUCB, NSUCB, SSCB, NSSCB, DCCB

## Gap Analysis

### Already exists
- NRE, NRO product variants in schema (`packages/shared/src/schemas/product.ts`)
- NBFC bank category and product type
- Co-op bank categories (SUCB, NSUCB, SSCB, NSSCB, DCCB)
- SFB, PSB, PVB, FB categories
- Rate discovery agent discovers NRI rate page URLs (Axis Bank has `fd_pdf_nri`, `fd_pdf_fcnr`)
- Skeleton components (`packages/web/src/components/skeleton.tsx`)

### Missing
| Gap | Needed |
|-----|--------|
| `fcnr` product variant | Add to `productVariant` enum |
| `gift` product variant | Add to `productVariant` enum |
| `IBU` bank category | Add enum + 37 IBU entries in master data |
| `HFC` bank category | Add enum + ~10 HFC entries |
| `currency` on rate_slabs | New column (FCNR rates in USD/GBP/EUR/AED) |
| Dashboard API | New `/api/rates/dashboard` public endpoint |
| Homepage UI | Replace single table with 9-row best-rates table |
| NRI rate scraping | Extend agent to extract NRE/NRO/FCNR rates |

## Dashboard Rows

### Domestic FD (regular FD, best rate at any tenure)
| # | Label | Categories | Variant | Currency |
|---|-------|-----------|---------|----------|
| 1 | Best Co-op FD Rate | SUCB, NSUCB, SSCB, NSSCB, DCCB | regular | INR |
| 2 | Best SFB FD Rate | SFB | regular | INR |
| 3 | Best SCB FD Rate | PSB, PVB | regular | INR |
| 4 | Best NBFC Rate | NBFC | regular | INR |
| 5 | Best Housing Finance Rate | HFC | regular | INR |

### International FD By FD Type (NRI/GIFT, best across all bank categories)
| # | Label | Categories | Variant | Currency |
|---|-------|-----------|---------|----------|
| 6 | Best NRE Rate | all | nre | INR |
| 7 | Best NRO Rate | all | nro | INR |
| 8 | Best FCNR Rate | all | fcnr | USD, GBP, EUR, AED (card with 4 expanded sub-rows) |
| 9 | Best GIFT City FD Rate | IBU | gift | USD, GBP, EUR, AED (card with 4 expanded sub-rows) |

**Each row shows:** Label | Best Rate % (bold) | Bank Name | Tenure | Safety Badge

**Clicking a row** → `/login?returnTo=/fd?category=...&variant=...`

**FCNR row** expands to show 4 currency sub-rows + "Show more currencies" link.

## Implementation Plan

### Step 1: Schema & Constants (no DB migration for enums — SQLite TEXT columns)

**`packages/shared/src/schemas/product.ts`** — Add to `productVariant` enum:
- `"fcnr"` — Foreign Currency Non-Resident
- `"gift"` — GIFT City IFSC Banking Unit FD

**`packages/shared/src/schemas/bank.ts`** — Add to `bankCategory` enum:
- `"IBU"` — IFSC Banking Unit
- `"HFC"` — Housing Finance Company

**`packages/shared/src/constants/bank-categories.ts`** — Add:
```
IBU: { label: "IFSC Banking Unit", description: "Banks operating in GIFT City IFSC", depositInsurance: false, typicalCount: "37" }
HFC: { label: "Housing Finance Company", description: "Housing finance companies accepting deposits", depositInsurance: false, typicalCount: "~10" }
```

### Step 2: DB Migration — `currency` column + index

**`packages/api/src/db/schema.ts`**:
- Add `currency: text("currency").notNull().default("INR")` to `rate_slabs` table
- Add composite index `products(bank_id, product_type, variant)` for dashboard queries

Run `npx drizzle-kit generate` → migration `0003_*.sql`

### Step 3: Master Data — IBUs and HFCs

**Create `docs/gift-city-ibus.json`** — 37 IFSC Banking Units (SBI IFSC, HDFC IFSC, ICICI IFSC, Axis IFSC, etc.)
- Category: `IBU`, state: `Gujarat`, deposit_insurance: `false`

**Create `docs/housing-finance-companies.json`** — ~10 HFCs (LIC HFL, PNB Housing, Can Fin Homes, etc.)
- Category: `HFC`, deposit_insurance: `false`

**Update `packages/api/src/db/seed/generate-seed.mjs`** to import from new JSON files.

### Step 4: Dashboard API Endpoint

**`packages/api/src/routes/rates.ts`** — New `GET /api/rates/dashboard`

Response shape:
```typescript
interface DashboardRow {
  row_id: string;           // "coop_fd", "sfb_fd", "nre", "fcnr_usd", "gift_usd", etc.
  label: string;
  best_rate: number | null; // null = no data yet
  bank_name: string | null;
  bank_code: string | null;
  bank_category: string | null;
  tenure_text: string | null;
  deposit_insurance: boolean | null;
  currency: string;         // "INR" for most, "USD"/"GBP"/"EUR"/"AED" for FCNR/GIFT
}

interface DashboardResponse {
  rows: DashboardRow[];              // 7 simple rows (co-op, SFB, SCB, NBFC, HFC, NRE, NRO)
  fcnr_currencies: DashboardRow[];   // 4 sub-rows: USD, GBP, EUR, AED
  gift_currencies: DashboardRow[];   // 4 sub-rows: USD, GBP, EUR, AED
  generated_at: string;
}
```

Implementation: 15 parallel SQL queries via `Promise.all` (7 simple rows + 4 FCNR currencies + 4 GIFT currencies):
```sql
SELECT rs.rate_general_pct, b.name, b.code, b.category,
       b.deposit_insurance, rs.tenure_text, rs.currency
FROM rate_slabs rs
  JOIN products p ON rs.product_id = p.id
  JOIN banks b ON rs.bank_id = b.id
WHERE rs.effective_to IS NULL
  AND p.product_type = 'FD'
  AND [per-row category/variant/currency filters]
ORDER BY rs.rate_general_pct DESC
LIMIT 1
```

**Register in `packages/api/src/app.ts`** as public route (alongside existing `/api/rates/best`).

Also add `variant` query param to existing `/rates/best` for future detail views.

### Step 5: Frontend Dashboard Redesign

**`packages/web/src/routes/index.tsx`** — Replace current content:

1. **Hero section** (keep, minor copy update)
2. **"Best FD Rates Across India" table** — 9 rows:
   ```
   ┌──────────────────────────┬────────┬─────────────────┬─────────┬────────┐
   │ Category                 │ Rate   │ Bank            │ Tenure  │ Safety │
   ├──────────────────────────┼────────┼─────────────────┼─────────┼────────┤
   │Domestic deposits                                                      |
   │ Best Co-op FD Rate       │ 8.50%  │ XYZ Co-op Bank  │ 3 Years │ ⚠ Verify│
   │ Best SFB FD Rate         │ 9.00%  │ AU Small Finance│ 1 Year  │ 🛡 High │
   │ Best SCB FD Rate         │ 7.25%  │ SBI             │ 2 Years │ 🛡 High │
   │ Best NBFC Rate           │ 8.75%  │ Bajaj Finance   │ 3 Years │ ⚠ Verify│
   │ Best Housing Finance     │ 8.00%  │ LIC HFL         │ 2 Years │ ⚠ Verify│
   ├──────────────────────────┼────────┼─────────────────┼─────────┼────────┤
   │International deposits                                                  │
   │ Best NRE Rate            │ 7.10%  │ HDFC Bank       │ 1 Year  │ 🛡 High │
   │ Best NRO Rate            │ 7.25%  │ ICICI Bank      │ 2 Years │ 🛡 High │
   │ Best FCNR Rate (USD)     │ 5.50%  │ Axis Bank       │ 1 Year  │ 🛡 High │
   │ Best FCNR Rate (GBP)     │ 5.50%  │ Axis Bank       │ 1 Year  │ 🛡 High │
   │ Best FCNR Rate (EUR)     │ 5.50%  │ Axis Bank       │ 1 Year  │ 🛡 High │
   │ Best FCNR Rate (AED)     │ 5.50%  │ Axis Bank       │ 1 Year  │ 🛡 High │
   │ Best GIFT City FD (USD)  │ 6.00%  │ SBI IFSC        │ 1 Year  │ ⚠ Verify│
   │ Best GIFT City FD (GBP)  │ 6.00%  │ SBI IFSC        │ 1 Year  │ ⚠ Verify│
   │ Best GIFT City FD (EUR)  │ 6.00%  │ SBI IFSC        │ 1 Year  │ ⚠ Verify│
   │ Best GIFT City FD (AED)  │ 6.00%  │ SBI IFSC        │ 1 Year  │ ⚠ Verify│
   └──────────────────────────┴────────┴─────────────────┴─────────┴────────┘
   ```
   - FCNR row is in fact a card showing subrows  → shows USD, GBP, EUR, AED sub-rows + "Show more currencies →"
   - Rows with no data → "Coming soon" in muted text
   - Clicking any row → `/login?returnTo=/fd?category=...&variant=...`
3. **Trust explainer** (keep)
4. **Quick links** (keep)

**`packages/web/src/lib/api.ts`** — Add `fetchDashboard(): Promise<DashboardResponse>`.

### Step 6: Rate Discovery Agent Expansion (parallel with Steps 4-5)

**`rate-discovery-agent/CLAUDE.md`**:
- Discover NRE/NRO/FCNR rate pages alongside domestic FD pages
- Output separate rate files per variant: `{bank_code}_nre_rates.json`, `{bank_code}_fcnr_rates.json`
- Update process to efficiently amend the bank-domains.json for the existing banks for which pages have been already discoveredy to updated NRE/NRO/FCNR products
- FCNR and GIFT (IFSC) outputs include `currency` field per slab

**`rate-discovery-agent/data/bank-domains.json`** — Add IBU and HFC domains

**Import pipeline** (`packages/scraper/src/import/`):
- Handle multi-variant rate files
- Set `currency` on FCNR rate_slabs during import

**Validation** (`packages/scraper/src/validators/`):
- FCNR rate range: 0.5–8.0% (lower than domestic 2.5–9.5%)

## Critical Files

| File | Change |
|------|--------|
| `packages/shared/src/schemas/product.ts` | Add `fcnr`, `gift` variants |
| `packages/shared/src/schemas/bank.ts` | Add `IBU`, `HFC` categories |
| `packages/shared/src/constants/bank-categories.ts` | Add IBU, HFC metadata |
| `packages/api/src/db/schema.ts` | Add `currency` column + index |
| `packages/api/src/routes/rates.ts` | New `/rates/dashboard` endpoint |
| `packages/api/src/app.ts` | Register dashboard as public route |
| `packages/web/src/lib/api.ts` | Add `fetchDashboard()` |
| `packages/web/src/routes/index.tsx` | Redesign to 9-row table |
| `docs/gift-city-ibus.json` | New: 37 IBU master data |
| `docs/housing-finance-companies.json` | New: ~10 HFC master data |
| `packages/api/src/db/seed/generate-seed.mjs` | Import new data files |
| `rate-discovery-agent/CLAUDE.md` | Extend for NRI rate collection |

## Verification

1. `npx drizzle-kit generate` — migration creates cleanly
2. Seed DB with IBU/HFC data → verify in admin panel
3. `GET /api/rates/dashboard` → returns 7 rows + 4 FCNR currency rows + 4 GIFT currency rows (some null until data collected)
4. Homepage without login → domestic rows + international rows + FCNR/GIFT cards with loading skeleton
5. FCNR and GIFT cards each show 4 currency sub-rows
6. "Coming soon" for rows with no rate data
7. Row click → redirects to `/login?returnTo=/fd?...`
8. Run rate discovery for Axis/SBI → verify NRE/NRO/FCNR imports with correct currency
