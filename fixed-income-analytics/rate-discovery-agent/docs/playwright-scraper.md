# Playwright Rate Scraper — Learnings & Usage

## Why Playwright?

Many Indian bank websites (HDFC Bank, and likely others) render rate tables via JavaScript after initial page load. A plain HTTP fetch (curl, node-fetch, WebFetch) returns the HTML skeleton but **no rate data** — the tables are injected into the DOM by client-side JS.

Playwright launches a real Chromium browser, executes the page's JavaScript, and lets us extract from the fully-rendered DOM.

## Setup

```bash
cd rate-discovery-agent
npm install playwright
```

Playwright ships its own Chromium binary. No separate browser install needed if `npx playwright --version` works.

## Usage

```bash
# Default: fetches HDFC Bank FD rates
node scripts/fetch_rates_playwright.js

# Any bank URL
node scripts/fetch_rates_playwright.js "https://www.somebank.co.in/interest-rates"
```

### Output

The script prints:
1. Human-readable rate slabs to stdout
2. A `=== JSON_OUTPUT ===` marker followed by structured JSON containing all extracted data

To capture just the JSON:

```bash
node scripts/fetch_rates_playwright.js | sed -n '/=== JSON_OUTPUT ===/,$ p' | tail -n +2 > rates.json
```

## Learnings from HDFC Bank Discovery

### 1. CloudFront Bot Protection (403 Errors)

**Problem:** HDFC Bank uses CloudFront WAF. Default headless Chromium is fingerprinted and blocked with a 403.

**Solution:** Three changes are needed:

```js
// 1. Disable automation indicators in Chromium args
browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});

// 2. Set a real browser User-Agent and locale
context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...",
  viewport: { width: 1366, height: 768 },
  locale: "en-IN",
});

// 3. Remove the navigator.webdriver flag (set by Playwright by default)
await page.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => false });
});
```

All three are required. Removing any one results in a 403.

### 2. Rate Data is NOT in `<table>` Elements

**Problem:** HDFC Bank renders rate data as styled divs, not HTML `<table>` tags. Searching for `<table>` finds nothing.

**Solution:** Extract via `page.innerText("body")` and parse the tab-separated lines with regex:

```js
const ratePattern = /^(.+?(?:days?|months?|years?|year).+?)\t(\d+\.\d+%)\t(\d+\.\d+%)$/i;
```

The rendered page produces lines like:
```
7 - 14 days\t2.75%\t3.25%
```

This approach works regardless of whether the underlying HTML uses `<table>`, `<div>`, or any other structure.

### 3. Multiple Rate Tables on One Page

HDFC Bank's FD rate page contains **two separate tables**:

| Table | Deposit Range | Effective Date |
|-------|--------------|----------------|
| 1 | < ₹3 Crore (retail) | 6th March, 2026 |
| 2 | ≥ ₹3 Cr to < ₹5 Cr | 7th March, 2026 |

The script extracts all 34 slabs (19 + 15). The caller is responsible for splitting them by context — currently done by position (first 19 = retail).

### 4. Effective Date Extraction

Dates appear as free text like "Applicable from 6th March, 2026". The regex:

```js
/(?:applicable\s+from|w\.?e\.?f\.?)\s*[:\-]?\s*(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})/gi
```

Handles both "Applicable from" and "w.e.f." formats common across Indian bank sites.

### 5. Domain Redirect

`hdfcbank.com` → 301 → `hdfc.bank.in`

HDFC Bank migrated to the RBI-mandated `.bank.in` domain. The old domain still works but redirects. Always use `hdfc.bank.in` as the canonical domain.

## Scraper Classification

| Property | Value |
|----------|-------|
| Scraper type | `html_js` (Tier 2) |
| Framework | AEM / server-rendered with JS hydration |
| Bot protection | CloudFront WAF |
| Data format | Tab-separated text in divs |
| Tables on page | 2 (retail + bulk) |
| Slab count | 19 (retail) + 15 (bulk) |

## Applicability to Other Banks

This script should work for any bank that:
- Renders rates via JavaScript (not in static HTML)
- Uses standard bot protection (CloudFront, Akamai, etc.)
- Presents rates in a tabular text format

Banks with different patterns will need adjustments:
- **PDF-only banks:** Playwright won't help; need a PDF parser
- **Captcha-protected pages:** Would need additional handling
- **API-backed SPAs:** Better to intercept the XHR/fetch call directly (use `page.on("response")` to capture API responses)

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| 403 error | Bot detection | Ensure all three anti-detection measures are applied |
| 0 rate slabs parsed | Different text format | Dump `bodyText` and adjust `ratePattern` regex |
| Timeout on `goto()` | Slow page / blocked assets | Increase timeout, or use `waitUntil: "domcontentloaded"` instead of `"networkidle"` |
| Missing Chromium | Playwright not installed | Run `npm install playwright` (downloads browser) |
