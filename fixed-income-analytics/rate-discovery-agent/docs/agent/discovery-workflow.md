# Discovery Workflow

Read this when DISCOVERING a bank: efficiency budget, finding the website, finding rate pages, classifying the scraper type, and extracting rates.

> Single source of truth: `lib/prompts/fragments.js` reads the anchored sections below; do not duplicate this content elsewhere. Edit here.

## Step 0 — Check known domains first

Before searching the web, look the bank up in `data/bank-domains.json` (use that exact relative path) by its `$BANK_CODE`:

- **Found with `domain` + `rate_pages.fd`** → skip website/rate-page search; build the URL `https://<domain><rate_pages.fd>` and go straight to classifying the scraper type. Use `scraper_type` and any `rate_pages.fd_nre/_nro/_fcnr` as hints. (Note: when an entry has an `extraction.<key>` block for a rate page, the `run_playwright`/`fetch_pdf` tools auto-resolve the matching hint from the URL — you don't pass selectors manually.)
- **Found with `domain` only** → skip website search; do the rate-page step on the known domain.
- **`parent_bank_code` present (IBU)** → look up the parent's domain for GIFT-City discovery.
- **Not found** → proceed with the full workflow below.

(The automated pipeline performs this registry lookup in code, so this step is unanchored — it is guidance for interactive/manual discovery.)

<!-- @fragment EFFICIENCY_RULES -->
## Efficiency Rules

You have a limited tool-call budget. Prefer fewer, larger calls over many small ones.

1. **Smart retry on fetch failures.** If fetch_url returns HTTP 403/429 or empty HTML scaffolding (JS framework), **immediately try run_playwright** on the same URL — these are signs of bot protection or JS rendering, not dead pages. Do NOT retry with fetch_url (no www./non-www. variants). For HTTP 404/500/timeout, move on — those are genuinely broken.
2. **Do not search for NRI/FCNR pages** for co-operative banks (SUCB, NSUCB, SSCB, NSSCB, DCCB), RRBs, Payments Banks, or Local Area Banks. They do not offer NRI products.
3. **Write config and rates in the same turn** when possible.
4. **Always write _rates.json** even if extraction yields zero slabs. Use `rate_slabs: []` with a warning explaining why.
5. **Skip NRI discovery** unless the bank type is PSB, PVB, FB, IBU, or a large SFB (AU, Equitas, Ujjivan, IDFC First, Bandhan).
<!-- @end EFFICIENCY_RULES -->

<!-- @fragment STEP_FIND_WEBSITE -->
## Find the Official Website

**Search strategy (bank.in first):**
1. **First search**: `site:bank.in "<bank name>"` — per RBI directive, all Indian banks must migrate to the `.bank.in` domain. This is the most authoritative source.
2. **If no bank.in result**: search `"<bank name>" official website india` as fallback.
3. **Do NOT fetch the homepage just to verify** — if the search result clearly shows the bank's domain, trust it and proceed. Only fetch the homepage if results are ambiguous.
4. If the bank is very small (cooperative banks), try: `"<bank name>" interest rates deposit`
5. Record the **official website URL**.

**Domain priority:**
- `.bank.in` domains — RBI-mandated, always prefer even if the bank also has a .com/.co.in
- `.co.in` / `.com` / `.org` — acceptable fallback if bank.in not yet available
- **Never use** aggregator sites (bankbazaar, paisabazaar, cleartax, groww, etc.)

**Note:** Some banks are still migrating to bank.in. If you find both a .bank.in and a legacy domain (.com, .co.in), always record the .bank.in as the canonical website.
<!-- @end STEP_FIND_WEBSITE -->

<!-- @fragment STEP_FIND_RATE_PAGES -->
## Find Interest Rate Pages

Banks often have **multiple separate FD rate pages** for different products:
- **Domestic FD** (general public retail deposits) — the primary page
- **Senior Citizen FD** — sometimes a separate page/table, sometimes a column on the domestic page
- **NRE FD** — Non-Resident External (separate product, separate rates)
- **NRO FD** — Non-Resident Ordinary (separate product, separate rates)
- **FCNR deposits** — Foreign Currency (separate product, separate rates per currency)
- **GIFT City / IBU deposits** — IFSC Banking Unit (foreign currency, separate)
- **Bulk/wholesale deposits** — different rate tiers for amounts above Rs. 3 crore

**Discovery steps:**
1. **Fetch the homepage once** and look for links containing: `interest rate`, `deposit rate`, `FD rate`, `fixed deposit`, `NRI deposits`.
2. If no rate link found in the homepage HTML, **web search**: `site:<domain> interest rate deposit`.
3. Identify the **domestic FD page** first — this is the primary target.
4. Note any links to other rate pages (NRI, senior citizen, bulk) — record their URLs in the config even if you don't extract them in this run.

Record all discovered rate page URLs in `rate_page_urls`:
```json
"rate_page_urls": {
  "fd": "/domestic-fd-rates",
  "fd_nre": "/nri/nre-deposits",
  "fd_nro": "/nri/nro-deposits",
  "fd_fcnr": "/nri/fcnr-deposits",
  "fd_nri_combined": null,
  "savings": "/savings-interest-rates",
  "rd": null
}
```
<!-- @end STEP_FIND_RATE_PAGES -->

<!-- @fragment STEP_SCRAPER_TYPE -->
## Classify Scraper Type

Based on what you observe when fetching the rate page, classify into one of these types:

| Type | How to Identify |
|------|----------------|
| `html_static` | Rate numbers visible in raw HTML response (e.g., "6.50%", "7 days to 14 days"). Standard `<table>` elements. |
| `html_js` | Empty containers, React/Angular/Vue root divs, rate data loaded by JavaScript. **Use run_playwright tool** instead of fetch_url. |
| `pdf` | Rate page links to a downloadable PDF rate card instead of showing rates inline. |
| `mixed` | Some products in HTML, others in PDFs on the same or linked pages. |
| `government` | Government gazette / ministry notification format (India Post, RBI). |
| `manual` | No website found, or page behind CAPTCHA / login. Manual data entry required. |

**How to tell html_static from html_js:** If the fetched HTML contains actual rate numbers, it's html_static. If it contains only empty `<div>` scaffolding, script bundles, or a JS framework root element, it's html_js.

**IMPORTANT — Playwright fallback strategy:**
- If fetch_url returns **HTTP 403** or **429**: this is bot protection (WAF/Cloudflare/Imperva). Use `run_playwright` on the same URL immediately.
- If fetch_url returns **HTML with no rate data** (empty divs, just scripts): this is JS-rendered. Use `run_playwright` with appropriate flags.
- **Never classify as "manual" until you have tried run_playwright.** Many banks that block fetch_url work fine with Playwright.
- Use `run_playwright` flags selectively — do NOT enable all flags at once (causes timeout):
  - `accordions: true` — for pages with collapsed/accordion sections (most common, try this first)
  - `scroll: true` — only if content is lazy-loaded on scroll
  - `tabs: true` — only if rates are behind tab clicks (not accordion)
  - `intercept: true` — only if rates are loaded via XHR/API calls
  - If the config's `scraper_notes.playwright_flags` specifies flags, use exactly those.
- Use `fetch_pdf` tool for PDF rate cards — do not use fetch_url or run_playwright on PDF URLs.
- **If `run_playwright` returns `"playwright_disabled":true`:** the operator has declared this bank's Playwright path is broken in the cloud environment (typically due to network-level hangs on bank-specific sites like sbi.bank.in). DO NOT retry `run_playwright` on any URL for this bank. Instead, use `fetch_url` on the same URL — for sites where `scraper_type` is `html_js`, the rate sub-pages (especially NRE/NRO/FCNR) often serve static HTML that fetch_url CAN parse. If `fetch_url` returns HTTP 403, the page is genuinely unrecoverable in cloud; record what you found and move on. Do not classify as "manual" purely because Playwright is disabled.
<!-- @end STEP_SCRAPER_TYPE -->

<!-- @fragment STEP_EXTRACT_RATES -->
## Extract Rate Data

When you fetch a rate page to classify it, **also extract the rate data** in the same step. The config file is the primary output; rate extraction is best-effort.

**For html_static:** Record table CSS selectors, column mapping (tenure, general rate, senior rate, super-senior rate), effective date location, number of rate tables.

**For html_js:** Record framework, bot protection, data format (tables vs divs), interactive elements (tabs, dropdowns, lazy-loaded sections), number of rate tables.

Record scraper notes in the config:
```json
"scraper_notes": {
  "framework": "AEM/server-rendered with JS hydration",
  "bot_protection": "CloudFront WAF",
  "data_format": "Tab-separated text lines (not HTML tables)",
  "rate_tables_on_page": 2,
  "has_tabs": true,
  "has_dropdowns": false,
  "has_lazy_loading": false
}
```

**For pdf:** Record the exact PDF download URL, column structure, date in filename.

**Multi-currency tables (FCNR / GIFT / IBU) — extract EVERY currency column:**

For FCNR and GIFT-City (IBU) rate cards, the source table is typically multi-currency. Two common layouts:

- **Pattern A (currency rows)**: column 0 = currency code (USD, GBP, EUR, JPY, CAD, AUD), column 1+ = tenure-keyed rates. Each currency row produces N tenure slabs.
- **Pattern B (currency columns)**: row 0 = currency headers (USD | GBP | EUR | …), column 0 = tenure ranges, body cells = rates. Each (tenure × currency) cell produces ONE slab.

**Rule**: For both patterns, emit EVERY currency column / row as separate slabs — do not collapse to USD only. A 6-currency × 8-tenure table = 48 slabs, not 8. Each slab carries its `currency` field.

The HDFC-IBU rate card (cohort #3, 2026-05-23) was a Pattern B PDF with USD + EUR columns; an LLM extraction that emitted only USD slabs dropped 23 of 35 baseline slabs. To prevent this: when you see two or more currency codes in the header or first column of a rate table, write a slab for EACH currency code paired with EACH tenure row. If a currency appears in a header but its column is empty for a given tenure, emit no slab for that pair (do not invent zero rates). Same applies to PDF tables read via `fetch_pdf` and HTML tables read via `run_playwright`.
<!-- @end STEP_EXTRACT_RATES -->
