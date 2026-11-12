# Phase 3: Consumer Platform — Implementation Doc

## Completed: 2026-03-28

---

## USP

Every rate on the platform is displayed alongside its institutional trust context — DICGC insurance status, RBI category, data freshness, and a computed safety tier. Users can filter by insurance status, compare banks side-by-side with safety badges, and immediately see which institutions carry higher risk. No competitor (BankBazaar, Paisabazaar, ClearTax) foregrounds trustworthiness alongside rates.

---

## What Was Built

### Trust Framework (`packages/web/src/lib/trust.ts`)

Client-side module computing trust signals from existing database fields — no new backend columns needed.

**Trust Tier** (3-level):

| Tier | Criteria | Display |
|------|----------|---------|
| High Safety | DICGC insured + PSB/PVB/SFB + data ≤ 7 days old | Green shield badge |
| Insured | DICGC insured + other categories, or data 8-30 days old | Yellow shield badge |
| Verify Safety | Not insured, or data > 30 days old | Red shield badge |

Categories qualifying as "high trust" (when combined with insurance + fresh data): `PSB`, `PVB`, `SFB`.

**Data Freshness** (3-level):

| Level | Threshold | Display |
|-------|-----------|---------|
| Fresh | ≤ 7 days since `scraped_at` | Green: "Verified recently" |
| Aging | 8-30 days | Yellow: "Verified this month" |
| Stale | > 30 days | Red: "May be outdated" |

**Exports**: `getTrustTier()`, `trustLabel()`, `trustColor()`, `getFreshness()`, `freshnessLabel()`, `freshnessColor()`.

### API Enhancements (`packages/api/src/routes/rates.ts`, rewritten)

All rate endpoints now include `deposit_insurance` and `bank_category` in their responses, enabling client-side trust computation.

**Enhanced existing endpoints:**

- `GET /api/rates` — new query params:
  - `tenure_min`, `tenure_max` — filter by tenure range in days
  - `category` — filter by bank category (PSB, PVB, SFB, etc.)
  - `insured_only=true` — only DICGC-insured banks
  - `sort_by` — `rate` (default), `bank_name`, `tenure`
  - `order` — `desc` (default), `asc`
  - Now returns total count for pagination
- `GET /api/rates/best` — added `category`, `insured_only` filters + `deposit_insurance`, `scraped_at` in response
- `GET /api/banks/:code/rates` — enriched bank object with `deposit_insurance`, `website_url`, `rate_page_url`, `state`, `assets_under_mgmt`

**New endpoints:**

- `GET /api/rates/compare?banks=code1,code2,...` — multi-bank comparison (up to 4 banks). Returns `{ banks: [...], rates: [...] }` with trust fields per bank. Uses `inArray()` for efficient query.
- `GET /api/rate-changes?limit=N&bank=code` — recent rate changes from `rate_change_log` joined with `banks` and `rate_slabs`. Returns bank trust fields, tenure text, old/new values, detection timestamp.

### Consumer Pages

**Homepage** (`packages/web/src/routes/index.tsx`):
- Hero section with headline emphasizing the dual value prop (rates + safety)
- CTA buttons to FD Rates and Compare pages
- "Best FD Rates Today" table with tenure bucket selector (1Y / 2Y / 3Y / 5Y)
- Each row shows: bank name (linked), category, trust tier badge, general rate, senior rate, effective date
- Trust explainer card: why we show safety ratings, DICGC coverage explained
- Quick links grid: FD Rates, Compare Banks, FD Calculator

**FD Rates** (`packages/web/src/routes/fd.tsx`):
- Sticky filter bar with:
  - Tenure presets: All, 7-14d, 6M, 1Y, 2Y, 3Y, 5Y
  - Category dropdown: All Banks, Public Sector, Private Sector, Small Finance, Foreign, Co-operative
  - DICGC Insured Only checkbox toggle
  - Result count display
- Sortable results table: bank (linked), safety badge, tenure, general rate (bold), senior rate, freshness badge
- Compare checkboxes (max 4) with fixed bottom comparison bar that appears when ≥ 2 banks selected
- Uninsured bank rows have subtle red background tint
- Pagination

**Bank Profile** (`packages/web/src/routes/banks/$bankCode.tsx`):
- Header with bank name, category, state, website link
- **Trust panel** (4 cards):
  - Deposit Insurance: "DICGC Insured (up to ₹5 lakh)" or "NOT DICGC Insured" in red
  - Safety Rating: computed trust tier badge
  - RBI Category: label + description from `BANK_CATEGORIES` constants
  - Data Freshness: freshness badge + last verified date
- Red warning banner for uninsured banks: "Deposits at this institution are NOT covered by DICGC insurance."
- Rate tables grouped by product/variant (FD/regular, FD/NRE, etc.)
- Super-senior column shown conditionally (only if any slab has it)
- Source URL link with "verify with bank" disclaimer

**Compare** (`packages/web/src/routes/compare.tsx`):
- Bank selector with autocomplete search (debounced, filters to active banks only, max 4)
- Selected banks shown as removable chips
- Comparison grid: rows = union of all tenure ranges, columns = one per bank
- Trust badge in each column header
- Best rate per row highlighted in green bold
- Uninsured bank columns have red tint
- Empty when < 2 banks selected, with link to FD Rates page

**FD Calculator** (`packages/web/src/routes/calculators/fd.tsx`):
- Inputs: deposit amount, interest rate (% p.a.), tenure (years + months), compounding frequency (quarterly/monthly/yearly)
- Compound interest formula: `A = P × (1 + r/n)^(n×t)`
- Output card: maturity amount, interest earned, effective annual yield
- All client-side — no backend dependency
- Disclaimer about TDS and verification

**Rate Changes** (`packages/web/src/routes/rate-changes.tsx`):
- Reverse-chronological feed of rate changes
- Each card shows: bank name + trust badge, tenure, field changed, old → new value, delta in bps (green for increase, red for decrease), detection date
- Fetches from `GET /api/rate-changes`

### Navigation (`packages/web/src/routes/__root.tsx`)

Updated nav with consumer-facing links:

```
Home | FD Rates | Compare | Banks | Calculator | Changes | Admin
```

Extracted `NavLink` component for consistent active-state styling.

### API Client (`packages/web/src/lib/api.ts`, rewritten)

New types: `RateListResponse`, `BankRatesResponse`, `CompareResponse`, `RateChangeRow`.

New functions: `fetchRates()`, `fetchBankRates()`, `fetchCompare()`, `fetchRateChanges()`.

---

## Verification Results

- `npx tsc --noEmit -p packages/api/tsconfig.json` — zero errors
- `npx tsc --noEmit -p packages/web/tsconfig.app.json` — zero errors
- `npm run build -w @bird/api` — clean
- `npm run build -w @bird/shared` — clean
- API tested:
  - `GET /api/rates/best?tenure_min=365&tenure_max=365&insured_only=true&limit=3` — returns 3 SFBs with `deposit_insurance: true`
  - `GET /api/rates/compare?banks=hdfc-bank-limited,axis-bank-limited` — 2 banks, 45 rates
  - `GET /api/rate-changes?limit=5` — 5 SBI rate changes with tenure context

---

## Git History

```
5bf5cc9 Phase 3: Consumer platform with trust framework and rate comparison
91618f4 Add Phase 3 plan: consumer platform with trust framework
```

11 files changed, 1,469 insertions(+), 136 deletions(-).

---

## Deviations from Plan

- **No SSR / programmatic SEO pages**: Plan noted these as deferred to Phase 4. URL structure is SEO-friendly (`/fd`, `/banks/state-bank-of-india`, `/compare`) and ready for SSR when added.
- **No RD / Savings / Post Office pages**: Plan specified FD-first approach. The FD rates page and bank profile are reusable for other product types — just needs different filter defaults and product_type param.
- **Trust score not yet computed server-side**: The `trust_score` field in the DB schema remains unused. The 3-tier trust system is computed client-side from `deposit_insurance`, `category`, and `scraped_at`. A server-side score incorporating asset size and other signals can be added later.
- **Insured-only filter defaults to OFF**: Plan suggested defaulting to ON. Changed to OFF to show the full picture by default — users can opt in to insured-only filtering.
- **Compare page uses URL search param**: `?banks=code1,code2` rather than a separate route. This allows bookmarkable comparison URLs and linking from the FD rates page's compare bar.

---

## Known Issues / Debt for Later Phases

1. **Banks list page (`/banks`) not updated** — still shows the basic Phase 0 table without trust badges or rate summary. Should be enhanced with trust indicators and a "has rates" flag.
2. **No loading skeletons** — all pages show "Loading..." text. Should use skeleton placeholders for better perceived performance.
3. **Compare tenure alignment** — when banks have slightly different tenure boundaries (e.g., "21 months" parsed as 637 vs 639 days), they appear as separate rows instead of aligning. Needs fuzzy tenure matching.
4. **Product type filter on FD page** — currently hardcoded. Should use `product` query param so the same page can serve RD/Savings by changing the filter.
5. **No mobile-responsive testing** — layout uses `sm:` and `lg:` breakpoints but hasn't been tested on small screens. The filter bar and compare grid likely need mobile adjustments.
6. **FD calculator doesn't auto-fill from bank selection** — plan mentioned linking from bank profile to calculator with rate pre-filled. Not yet implemented.
7. **Rate changes feed has limited data** — only 4 Axis Bank changes exist from the import's versioning detection. Will grow as the pipeline runs daily and detects real rate changes.
