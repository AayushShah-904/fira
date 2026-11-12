# NRI Deposit Rates — 11-Bank Gold Pack: Quality Report
**As of 9 July 2026 · pack `rates-pack-gold11-2026-07-09` · 18 entities (11 banks + 7 GIFT-City IBUs) · 1,188 rate slabs · quality gate PASS (1 documented exception)**

What each bank publishes for NRE, NRO, FCNR and GIFT-City deposits, how fresh it is, and where to trust it.

- **15** bank·variant blocks are current & dated — safe to cite
- **13** are usable with a caveat (undated / thin / aging)
- **9** should be doubted / verified before citing

*(Interactive version: shareable web report available on request.)*

## Coverage matrix

Slab count · currencies (FCNR/GIFT only — NRE/NRO are rupee accounts) · bank-published effective date. Confidence in **[brackets]**: ✅ cite · ⚠️ caveat · ❌ doubt · — missing/NA.

| Bank | NRE | NRO | FCNR | GIFT (IBU) |
|---|---|---|---|---|
| **Yes Bank** | 21 ❌ eff 2019 | 18 ⚠️ 84d old | 25 ❌ eff 2019 | — no rate table |
| **Axis Bank** | 72 ⚠️ undated | 162 ⚠️ undated | 38 ✅ 6ccy, 13-Jun, lock-in | 12 ❌ was 24, thin |
| **AU Small Finance** | 8 ⚠️ undated | 12 ⚠️ undated | 25 ✅ 4ccy, 10-Jun | — no IBU |
| **ICICI Bank** | 6 ⚠️ undated | 9 ⚠️ undated | 13 ✅ USD+GBP, 11-Jun | 24 ✅ 8ccy, 07-Apr |
| **RBL Bank** | 12 ⚠️ undated | 20 ⚠️ undated | 30 ✅ 6ccy, 12-Jun | 84 ⚠️ 6ccy, undated |
| **IDFC First** | 7 ✅ 10-Jun | 13 ✅ 10-Jun | 30 ✅ 5ccy, 16-Jun | 9 ❌ was 22, stale PDF |
| **Canara Bank** | 36 ❌ eff Jul-2025 | 37 ❌ eff Jul-2025 | 68 ❌ 5ccy, eff Jul-2025 | 32 ✅ 3ccy, 11-Jun |
| **Indian Overseas** | 9 ✅ 15-May | 27 ✅ 15-May | 45 ⚠️ 9ccy, undated | — no IBU |
| **Bank of Maharashtra** | 6 ⚠️ undated | — not separate | 21 ✅ 5ccy, 26-Jun | 7 ⚠️ USD only, 26-Feb |
| **Saraswat Co-op** | 9 ❌ Mar-2025, 88d | — not separate | 10 ✅ USD, 15-Jun | — no IBU |
| **Cosmos Co-op** | 8 ❌ eff 2020 | — not separate | 24 ✅ 4ccy, 01-Jun | — no IBU |

## ✅ Cite — current & dated, safe to quote today
- **FCNR is the strongest variant.** Axis (38, 6 ccy, with RBI lock-in flags), RBL (30), IDFC (30), Bank of Maharashtra (21), AU (25), ICICI (13, thin), Saraswat & Cosmos (USD-led) — all carry a June 2026 effective date.
- **Indian Overseas & IDFC NRE/NRO** — freshly scraped and bank-dated (May/June 2026).
- **GIFT-City: ICICI (24, 8 ccy) and Canara (32, 3 ccy)** — dated and multi-currency.

## ⚠️ Caveat — usable, but flag when quoting
- **Undated ladders** — Axis, AU, ICICI, RBL, BoM NRE/NRO carry no bank-published effective date. Scraped fresh, but treat the "as-of" as the scrape date, not an official one.
- **RBL GIFT (84 slabs)** — largest GIFT ladder, but undated.
- **IOB FCNR (45, 9 currencies)** — broadest FCNR currency set, but undated.
- **BoM GIFT (7, USD only) & Yes NRO (84 days old)** — thin / aging; fine as directional.

## ❌ Doubt — verify before citing
- **Yes Bank NRE & FCNR** — source PDF stamps an effective date of **2019**. Either a misprint on a current card or a stale archive; do not quote until confirmed current.
- **Canara Bank NRE / NRO / FCNR** — all carry effective date **1 July 2025** (a year old). Site is JS/WAF-protected; the pipeline may be reading an old cached card.
- **Cosmos NRE (eff 2020) & Saraswat NRE (eff Mar-2025)** — clearly stale co-op rupee-deposit rates.
- **IDFC GIFT (9, was 22) & Axis GIFT (12, was 24)** — under-extracted from dated GIFT-City PDFs that have since rolled; fuller ladders known and being recovered. IDFC GIFT is the one documented quality-gate exception in this pack.

## What is genuinely missing
- **Yes Bank GIFT** — Yes operates a GIFT-City IBU, but the page has no static rate table (FX-market-linked).
- **NRO for BoM, Saraswat, Cosmos** — not published as a separate schedule (typically priced at domestic term-deposit rate).
- **GIFT for AU, IOB, Saraswat, Cosmos** — these do not operate a GIFT-City IBU, so GIFT is N/A (not a gap).

## Method & provenance
Rates are extracted from each bank's own website / rate-card PDF (never aggregators), collected via an automated cloud run on 8–9 July 2026. NRE/NRO are rupee-denominated (no currency column); FCNR/GIFT are foreign-currency. "Effective date" is what the bank printed; "fresh" = scraped within the last day. A quality gate blocks any bank losing >50% of its rates vs a fixed baseline — one exception (IDFC GIFT) accepted and documented. Counts are slab-level (one bank · currency · tenure = one slab).
