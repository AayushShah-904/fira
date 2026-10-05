# Bank Categories — Registry Reference

> **Source:** `Indian_Banks_Comprehensive_List_RBI.csv`  
> **Total banks in registry:** 1,995 across 14 categories  
> **Type codes:** defined in [`docs/agent/schemas.md`](./agent/schemas.md) (`BANK_TYPE_TABLE` fragment)

---

## Full Registry Breakdown

| # | Category | `bank_type` code | Count | Share |
|---|----------|-----------------|------:|------:|
| 1 | Non-Scheduled Urban Co-operative Bank | `NSUCB` | 1,392 | 69.8% |
| 2 | District Central Co-operative Bank | `DCCB` | 352 | 17.6% |
| 3 | Scheduled Urban Co-operative Bank | `SUCB` | 52 | 2.6% |
| 4 | Foreign Bank | `FB` | 44 | 2.2% |
| 5 | IFSC Banking Unit (IFSCA / GIFT City) | `IBU` | 37 | 1.9% |
| 6 | Regional Rural Bank | `RRB` | 28 | 1.4% |
| 7 | Scheduled State Co-operative Bank | `SSCB` | 24 | 1.2% |
| 8 | Private Sector Bank (Indian) | `PVB` | 21 | 1.1% |
| 9 | Public Sector Bank | `PSB` | 12 | 0.6% |
| 10 | Small Finance Bank | `SFB` | 11 | 0.6% |
| 11 | Non-Scheduled State Co-operative Bank | `NSSCB` | 10 | 0.5% |
| 12 | Payments Bank | `PB` | 6 | 0.3% |
| 13 | Financial Institution | `FI` | 4 | 0.2% |
| 14 | Local Area Bank | `LAB` | 2 | 0.1% |
| | **Total** | | **1,995** | **100%** |

---

## Category Profiles

### 🏛️ Public Sector Bank — `PSB` (12 banks)
Banks where the Government of India holds majority stake.

**Examples:** State Bank of India, Punjab National Bank, Canara Bank, Bank of Baroda, Bank of Maharashtra, Indian Overseas Bank, Union Bank of India

**Extraction characteristics:**
- Always have a `.bank.in` domain (RBI-mandated)
- FD rate pages are generally HTML-static or HTML-JS
- Offer full NRI product suite: NRE, NRO, FCNR
- Some (SBI, Canara) have WAF/bot protection — may need Playwright

---

### 🏢 Private Sector Bank (Indian) — `PVB` (21 banks)
Indian-incorporated private banks.

**Examples:** HDFC Bank, ICICI Bank, Axis Bank, Yes Bank, RBL Bank, Kotak Mahindra Bank, IndusInd Bank, IDFC First Bank

**Extraction characteristics:**
- Well-structured websites; often React/Angular SPAs (`html_js`)
- Full NRI suite: NRE, NRO, FCNR; sometimes GIFT-City IBU
- Cloudflare / Imperva WAF common on larger PVBs
- PDF rate cards rare; usually inline HTML tables

---

### 💰 Small Finance Bank — `SFB` (11 banks)
Licensed by RBI to serve unbanked and underserved segments.

**Examples:** AU Small Finance Bank, Equitas, Ujjivan, IDFC First (also PVB), Bandhan, Jana, Suryoday

**Extraction characteristics:**
- HTML-static or HTML-JS sites
- Offer NRE/NRO; FCNR only for larger SFBs (AU, Equitas, Ujjivan, IDFC First, Bandhan)
- No GIFT-City IBU unless explicitly registered

---

### 📱 Payments Bank — `PB` (6 banks)
Restricted licence — can accept deposits up to ₹2 lakh, cannot lend.

**Examples:** Airtel Payments Bank, Paytm Payments Bank, India Post Payments Bank, Jio Payments Bank

**Extraction characteristics:**
- Do **not** offer FD products (no term deposits)
- Only savings/wallet rates — tracked in `rate_page_urls.savings` in config only
- No NRI products
- `scraper_type` will typically be `"manual"` or `"government"` for India Post

---

### 🌍 Foreign Bank — `FB` (44 banks)
Banks incorporated outside India with branch presence in India.

**Examples:** Citibank, Standard Chartered, HSBC, Deutsche Bank, DBS, Mizuho, QNB, UOB, CTBC

**Extraction characteristics:**
- Wide variation: some have very clean HTML-static pages; others redirect to global sites
- May offer NRE/NRO/FCNR; FCNR especially common
- Sites often multilingual; English version must be located explicitly
- PDF rate cards are common

---

### 🏙️ Regional Rural Bank — `RRB` (28 banks)
Sponsored by central govt, state govt, and a sponsor bank; serve rural areas.

**Examples:** Baroda UP Bank, Telangana Grameena Bank, Karnataka Gramin Bank, Assam Gramin Vikash Bank

**Extraction characteristics:**
- Do **not** offer NRI products — skip NRI discovery entirely
- Rate pages often basic HTML-static; some have no website (use sponsor bank rates)
- Cooperative-bank quirks apply (see `docs/agent/field-learnings.md`)

---

### 🤝 Scheduled Urban Co-operative Bank — `SUCB` (52 banks)
Urban co-operative banks that are scheduled (listed in Second Schedule of RBI Act).

**Examples:** Saraswat Co-operative Bank, Cosmos Co-operative Bank, Shamrao Vithal Co-operative Bank, TJSB Sahakari Bank

**Extraction characteristics:**
- Do **not** offer NRI products
- Rate pages range from clean HTML-static to image-only PDFs
- Some have Hindi/regional-language URL paths
- Check `docs/agent/field-learnings.md` Rules 6–11 (multilingual, image-only, PDF quirks)

---

### 🤝 Non-Scheduled Urban Co-operative Bank — `NSUCB` (1,392 banks)
The largest segment — small urban co-operative banks not listed in the RBI Schedule.

**Characteristics:**
- Many have **no website at all** → `scraper_type: "manual"`, note for operator
- Some appear on state co-operative bank umbrella portals
- Rate pages are often static HTML or image-only
- No NRI products
- Hindi/regional-language sites very common in UP, MP, Rajasthan, Bihar, Jharkhand

> See `docs/agent/field-learnings.md` Rules 1–11 for DCCB/NSUCB-specific quirks.

---

### 🌾 Scheduled State Co-operative Bank — `SSCB` (24 banks)
Apex co-operative banks at state level; scheduled.

**Examples:** Maharashtra State Co-operative Bank, Gujarat State Co-operative Bank, Karnataka State Co-operative Apex Bank

**Extraction characteristics:**
- Often host umbrella portals linking to district co-ops below them
- HTML-static or HTML-JS; PDF rate cards common
- No NRI products

---

### 🌾 Non-Scheduled State Co-operative Bank — `NSSCB` (10 banks)
State-level apex co-operative banks; not in RBI Schedule.

**Characteristics:** Similar to SSCB; smaller footprint; basic websites.

---

### 🏘️ District Central Co-operative Bank — `DCCB` (352 banks)
District-level co-operative banks; serve rural credit societies.

**Characteristics:**
- Highly variable web presence — many are image-only or have no website
- Some are hosted as subdomains on state co-op umbrella domains
- No NRI products
- Multilingual rate pages frequent (Hindi/regional scripts)

> See `docs/agent/field-learnings.md` Rules 3–5 (umbrella domain preference rules).

---

### 🏦 IFSC Banking Unit — `IBU` (37 banks)
Foreign-currency banking units operating inside GIFT City, Gujarat under IFSCA.

**Examples:** Canara Bank IBU, Axis Bank IBU, ICICI Bank IBU, RBL Bank IBU, Yes Bank IBU, HDFC Bank IBU

**Extraction characteristics:**
- **No domestic INR FD product** — all deposits in foreign currency
- Rate pages under parent bank's GIFT City / IFSC section
- Output: `_gift_rates.json` with `variant: "gift"`, `currency` per slab, `deposit_insurance: false`
- Multi-currency tables: USD, GBP, EUR, JPY, CAD, AUD — emit every currency × tenure pair
- `rate_senior_pct: null` for all slabs (no senior citizen premium on foreign currency)

---

### 🏛️ Financial Institution — `FI` (4 banks)
Development finance institutions with limited deposit-taking.

**Examples:** NABARD, NHB, SIDBI, EXIM Bank

**Characteristics:** Rates (if any) are often government gazette format. Low extraction priority.

---

### 🏠 Local Area Bank — `LAB` (2 banks)
Very small licensed banks serving 2–3 districts.

**Characteristics:** Minimal web presence; basic HTML if available. No NRI products.

---

## NRI Product Eligibility Matrix

| `bank_type` | NRE | NRO | FCNR | GIFT |
|-------------|:---:|:---:|:----:|:----:|
| PSB | ✅ | ✅ | ✅ | via IBU |
| PVB | ✅ | ✅ | ✅ | via IBU |
| SFB (large) | ✅ | ✅ | ✅¹ | ❌ |
| SFB (small) | ✅ | ✅ | ❌ | ❌ |
| FB | ✅ | ✅ | ✅ | ❌ |
| RRB | ❌ | ❌ | ❌ | ❌ |
| SUCB | ❌ | ❌ | ❌ | ❌ |
| NSUCB | ❌ | ❌ | ❌ | ❌ |
| SSCB | ❌ | ❌ | ❌ | ❌ |
| NSSCB | ❌ | ❌ | ❌ | ❌ |
| DCCB | ❌ | ❌ | ❌ | ❌ |
| IBU | ❌ | ❌ | ❌ | ✅ |
| PB | ❌ | ❌ | ❌ | ❌ |
| FI | ❌ | ❌ | ❌ | ❌ |
| LAB | ❌ | ❌ | ❌ | ❌ |

> ¹ Large SFBs with FCNR eligibility: AU, Equitas, Ujjivan, IDFC First, Bandhan

---

## Extraction Priority Tiers

| Tier | Categories | Rationale |
|------|-----------|-----------|
| **Tier 1 — High** | PSB, PVB, SFB, IBU | High deposit volume; full product suite; PM priority |
| **Tier 2 — Medium** | FB, RRB, SUCB, SSCB | Significant but smaller market share |
| **Tier 3 — Effort-heavy** | NSUCB, DCCB, NSSCB | Largest by count; many manual/no-website cases |
| **Tier 4 — Low** | PB, FI, LAB | No or limited FD products; low business value |

---

## Current Sprint Scope

| Sprint | Cohort | Categories covered |
|--------|--------|--------------------|
| **Gold-11 Domestic FD** | `data/cohorts/gold-11-nri-banks.json` | PVB, PSB, SFB, IBU, SUCB |
| Gold-11 NRI (next) | `data/cohorts/gold-11-nri-banks.json` | PVB, PSB, SFB, IBU |
| Full fleet (future) | All 1,995 | All 14 categories |

---

*Last updated: 2026-10-05 — generated from `Indian_Banks_Comprehensive_List_RBI.csv`*
