# Phase 3: Consumer Platform — Detailed Plan

## USP

BIRD's public platform is **the single place to compare interest rates across tenures AND visualize the reliability of the institution offering the product**. Every competitor (BankBazaar, Paisabazaar, ClearTax) shows rates — none foreground institutional trustworthiness alongside the rate. BIRD does both, because a higher rate from an uninsured cooperative bank is a fundamentally different proposition than the same rate from an insured scheduled bank.

This means every rate displayed must carry its trust context: DICGC insurance status, RBI category, asset size, data freshness, and an overall trust signal. The comparison UX must let users trade off rate vs safety, not just sort by rate.

---

## Trust Framework

Trust is not a single number. It's a composition of verifiable signals:

### Signal 1: Deposit Insurance (DICGC)

The most important binary signal. DICGC insures deposits up to ₹5 lakh per depositor per bank. Banks in these RBI categories have DICGC coverage (from `BANK_CATEGORIES` constants):

| Insured | Categories |
|---------|-----------|
| Yes | PSB, PVB, SFB, PB, FB, RRB, SUCB, NSUCB, LAB |
| No | SSCB, NSSCB, DCCB, FI, NBFC |

Display: prominent shield badge on insured banks. Red warning banner on uninsured ones — "Deposits at this institution are NOT covered by DICGC insurance."

### Signal 2: RBI Category

Category tells the user what kind of institution they're dealing with:
- **PSB** (Public Sector Bank) — government-owned, implicit sovereign backing
- **PVB** (Private Sector Bank) — well-regulated, DICGC insured
- **SFB** (Small Finance Bank) — newer, higher rates, insured, RBI-regulated
- **FB** (Foreign Bank) — insured Indian branch, but limited presence
- **Co-operatives** (SUCB/NSUCB/SSCB/DCCB) — highly variable quality, some insured
- **NBFC** — no deposit insurance, higher risk, often highest rates

Display: category label + short explainer tooltip.

### Signal 3: Data Freshness

How recently was this rate verified from the bank's own website?

| Freshness | Threshold | Display |
|-----------|-----------|---------|
| Fresh | Last verified ≤ 7 days | Green badge |
| Aging | 8–30 days | Yellow badge |
| Stale | 30+ days | Red badge + "verify with bank" warning |

Source: `scraped_at` field on rate slabs; `last_checked_at` in page_hashes.

### Signal 4: Asset Size (future enhancement)

`assets_under_mgmt` is in the schema but not yet populated for most banks. When available, it provides a quantitative scale signal — ₹50,000 Cr PSB vs ₹500 Cr cooperative. Will be populated from RBI annual reports or agent discovery in a future pass.

### Computed Trust Tier

For the UI, collapse the above into a simple 3-tier indicator:

| Tier | Criteria | Display |
|------|----------|---------|
| High | DICGC insured + (PSB or PVB or SFB) + data fresh | Green shield: "High Safety" |
| Medium | DICGC insured + other categories, OR data aging | Yellow shield: "Insured" |
| Low | Not insured (NBFC/DCCB/NSSCB/FI) OR data stale | Red shield: "Verify Safety" |

This is computed client-side from `deposit_insurance`, `category`, and `scraped_at` — no new backend field needed.

---

## Pages & Routes

### Homepage (`/`)

The landing page. Must immediately answer: "What are the best FD rates right now, and are these banks safe?"

**Layout:**
1. **Hero section** — headline, subheadline, search bar for bank name or rate
2. **Best Rates Today** — table or cards showing top 5 rates for common tenures (1 year, 2 years, 3 years, 5 years). Each row shows: bank name, rate, senior rate, trust tier badge, category label, "Compare" button
3. **Trust explainer** — short paragraph: "We show deposit insurance status and institution type alongside every rate so you can make informed decisions."
4. **Quick links** — cards linking to `/fd`, `/compare`, `/calculators/fd`

**API**: `GET /api/rates/best?limit=5` (already exists) — but needs trust fields. See API additions below.

### FD Rates (`/fd`)

The primary comparison page. Users come here from search (SEO) or nav.

**Layout:**
1. **Filter bar** (sticky top):
   - Tenure selector: preset buttons (1Y, 2Y, 3Y, 5Y) + custom range slider
   - Investor type: toggle (General / Senior Citizen / NRI)
   - Bank type: multi-select pills (PSB, PVB, SFB, Co-op, NBFC, Foreign)
   - Deposit amount: input (affects which slab applies for banks with deposit-based tiers)
   - "Only DICGC insured" toggle (default ON)
2. **Results table** (sortable columns):
   - Bank name (linked to `/banks/$code`)
   - Trust tier badge (shield icon + color)
   - Category label (PSB/PVB/SFB/etc.)
   - Rate (general) — bold, large
   - Rate (senior citizen) — if investor type is senior
   - Effective from date
   - Freshness badge
   - "Compare" checkbox (adds to comparison, max 4)
3. **Compare bar** (fixed bottom, appears when ≥2 banks checked) — "Compare N banks" button → navigates to `/compare?banks=code1,code2,...`

**API**: `GET /api/rates` with additional query params: `tenure_min`, `tenure_max`, `investor_type`, `category`, `insured_only`, `sort_by`, `order`. Most of these need new backend support.

### Bank Profile (`/banks/$bankCode`)

Detailed view of a single bank. Trust signals are front and center.

**Layout:**
1. **Header**: bank name, category badge, trust tier badge, DICGC badge, website link
2. **Trust panel** (prominent card):
   - DICGC insurance: Yes/No with ₹5L coverage note
   - RBI category: label + description
   - Data freshness: when last verified, source URL
   - Asset size (when available)
3. **FD Rate table**: all active slabs for this bank, grouped by variant (regular/senior/NRE/NRO). Columns: tenure, general rate, senior rate, super-senior rate
4. **Special schemes**: promotional FDs with expiry dates
5. **Rate history** (future): chart showing rate changes over time

**API**: `GET /api/banks/:code/rates` (exists) + `GET /api/banks/:code` (exists, but needs to return trust fields).

### Compare (`/compare`)

Side-by-side comparison of 2-4 banks.

**Layout:**
1. **Bank selector bar**: add/remove banks by name search (autocomplete)
2. **Comparison table**: rows = tenure slabs (union of all selected banks' tenures), columns = one per bank. Each cell shows the rate + trust badge. Highest rate in each row highlighted green. Uninsured bank columns have a subtle warning tint.
3. **Summary row**: best overall rate per bank across all tenures

**API**: `GET /api/rates/compare?banks=code1,code2,code3` — new endpoint that returns rates for multiple banks in one call.

### FD Calculator (`/calculators/fd`)

Maturity value calculator.

**Inputs**: Principal amount, tenure (years + months), interest rate (auto-filled if bank selected), compounding frequency (quarterly default, monthly/yearly options), investor type (for tax bracket — future).

**Output**: Maturity amount, total interest earned, effective annual yield. Show comparison: "If you invested ₹5L at SBI (6.50%) vs HDFC (6.45%) for 3 years, the difference is ₹X."

**API**: Pure client-side calculation. No backend needed.

### Rate Changes (`/rate-changes`)

Timeline of recent rate changes across all banks.

**Layout**: reverse-chronological feed. Each entry: bank name, tenure affected, old rate → new rate, date detected. Filter by bank or category.

**API**: `GET /api/rate-changes` — new endpoint. Query `rate_change_log` joined with banks + rate_slabs.

---

## API Additions

### Enhanced bank response

`GET /api/banks/:code` and `GET /api/banks` must return trust-relevant fields that already exist in the schema but aren't currently exposed:

```
deposit_insurance, category, assets_under_mgmt, trust_score,
website_url, rate_page_url, rbi_licence_no
```

### Enhanced rate responses

`GET /api/rates` and `GET /api/rates/best` must include bank trust fields alongside rates:

```
bank_code, bank_name, bank_category, deposit_insurance,
tenure_text, tenure_min_days, tenure_max_days,
rate_general_pct, rate_senior_pct, rate_super_senior_pct,
effective_from, scraped_at
```

### New endpoints

- `GET /api/rates/compare?banks=code1,code2,...` — multi-bank comparison in one call
- `GET /api/rate-changes?limit=N&bank=code&days=30` — recent rate changes from `rate_change_log`

### Filter additions to existing endpoints

`GET /api/rates` gains:
- `tenure_min`, `tenure_max` — filter by tenure range in days
- `category` — filter by bank category (PSB, PVB, etc.)
- `insured_only=true` — only DICGC-insured banks
- `sort_by` — `rate` (default), `bank_name`, `tenure`
- `order` — `desc` (default), `asc`

---

## Implementation Order

| Step | What | Depends On |
|------|------|-----------|
| 1 | API enhancements: trust fields in bank/rate responses, filter params, new endpoints | Nothing |
| 2 | Homepage: hero + best rates with trust badges | Step 1 |
| 3 | FD Rates page: filter bar + sortable results table with trust indicators | Step 1 |
| 4 | Bank Profile: trust panel + rate table + special schemes | Step 1 |
| 5 | Compare page: side-by-side with trust context | Step 1 |
| 6 | FD Calculator: client-side maturity calculation | Nothing |
| 7 | Rate Changes feed | Step 1 |

Steps 2-6 are largely independent once Step 1 (API) is done. The calculator (Step 6) has no backend dependency at all.

---

## SEO Considerations

Phase 3 focuses on getting the pages right. SEO optimization (programmatic pages like `/fd/best-rates-3-years`, JSON-LD structured data, sitemap generation) is deferred to Phase 4, but the URL structure established here must be SEO-friendly from the start:

- `/fd` — "Best FD Rates in India 2026"
- `/banks/state-bank-of-india` — "SBI FD Interest Rates 2026"
- `/compare?banks=sbi,hdfc` — "SBI vs HDFC FD Rates Comparison"
- `/calculators/fd` — "FD Calculator — Calculate Maturity Amount"

All pages use semantic HTML (`<h1>`, `<table>`, `<th>`) for accessibility and crawler readability.

---

## What We're NOT Building in Phase 3

- **User accounts / auth** — Phase 4
- **Email alerts for rate changes** — Phase 4
- **Affiliate links / monetization** — Phase 4
- **SSR / programmatic SEO pages** — Phase 4 (requires SSR setup or prerendering)
- **NRI-specific pages** — Phase 4+ (data exists but UX needs NRI-specific flows)
- **RD / Savings / Post Office pages** — Phase 3 focuses on FD. Other products share the same components and will be enabled once FD is solid.
- **Mobile app / PWA** — Phase 5+
