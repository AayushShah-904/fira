# Rate Discovery Agent

A Claude Code agent that discovers bank interest rate pages and extracts rate data for the Indian Bank Interest Rate Aggregator project.

> **New to this project?** Start with the onboarding guidebook in **[`docs/about/`](docs/about/README.md)** — [`overview.md`](docs/about/overview.md) explains the whole system, and there's an area doc for architecture, agent design, crawling, extraction, quality checks, deployment, testing, scripts, plus an operator runbook.

## What It Does

Given a bank name, the agent:

1. **Finds** the bank's official website (prefers `.bank.in` RBI-mandated domains)
2. **Locates** interest rate / deposit rate pages
3. **Classifies** the scraper type (static HTML, JS-rendered, PDF, etc.)
4. **Extracts** FD/RD/SA rate data into a standardised format (when possible)
5. **Outputs** a per-bank scraper config JSON + rate data JSON

These outputs feed directly into the Phase 2 scraping pipeline as ready-to-use configurations.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 20+
- Run `npm install` once (installs Playwright for JS-rendered bank pages)

## Quick Start

### Mode 1: Interactive (recommended to start with)

```
cd rate-discovery-agent
claude
```

Claude Code reads `CLAUDE.md` automatically. Then just chat:

```
> Discover rates for: State Bank of India | Category: Public Sector Bank

> Now do HDFC Bank Limited | Category: Private Sector Bank (Indian)
```

You can course-correct in real time — "that's the wrong URL", "try the .bank.in domain", "use Playwright for this one".

### Mode 2: Headless — Single Bank

```
node run-discovery.js "State Bank of India" "Public Sector Bank" "Maharashtra"
node run-discovery.js "HDFC Bank Limited" --category "Private Sector Bank (Indian)"
node run-discovery.js "Rajkot Nagrik Sahakari Bank Ltd."
```

### Mode 3: Headless — Batch from CSV

```
:: All Public Sector Banks (12 banks)
node run-batch.js banks.csv --category "Public Sector Bank"

:: First 5 Private Sector Banks
node run-batch.js banks.csv --category "Private Sector Bank (Indian)" --limit 5

:: All Small Finance Banks
node run-batch.js banks.csv --category "Small Finance Bank"

:: Custom delay between banks (default 2s)
node run-batch.js banks.csv --category "Public Sector Bank" --delay 5
```

CSV format: `Sr. No., Bank Name, Category, State / Country, City, Notes`

### Mode 4: As a Skill in your main monorepo

Copy CLAUDE.md into your monorepo as a skill:

```
mkdir .claude\skills\discover-bank
copy rate-discovery-agent\CLAUDE.md .claude\skills\discover-bank\SKILL.md
```

Add frontmatter at the top of SKILL.md:

```yaml
---
name: discover-bank
description: Discover a bank's official website and interest rate pages.
argument-hint: "Bank Name | Category | State"
---
```

Then from within your monorepo: `/discover-bank Rajkot Nagrik Sahakari Bank Ltd.`

## Project Files

```
rate-discovery-agent/
├── CLAUDE.md                          # Agent brain (Claude Code reads this)
├── package.json                       # Node deps (playwright)
├── run-discovery.js                   # Single bank runner (cross-platform)
├── run-batch.js                       # Batch runner from CSV (cross-platform)
├── run-discovery.sh / run-batch.sh    # Bash equivalents (macOS/Linux)
├── prompts/
│   └── discover.md                    # Prompt template for headless mode
├── scripts/
│   ├── fetch_rates_playwright.js      # Playwright scraper with anti-bot evasion
│   ├── validate_output.py             # Validate output JSON against schema
│   └── compile_report.py              # Compile all outputs into summary
├── docs/
│   └── playwright-scraper.md          # Learnings from HDFC discovery
└── output/                            # All results land here
    ├── hdfc_config.json               # HDFC Bank — discovered config
    └── hdfc_rates.json                # HDFC Bank — 19 FD rate slabs
```

## Output Format

### Config File (`*_config.json`)

Contains everything the automated scraper needs:

```json
{
  "bank_code": "hdfc",
  "bank_name": "HDFC Bank Limited",
  "bank_type": "PVB",
  "website": "https://www.hdfc.bank.in",
  "scraper_type": "html_js",
  "rate_page_urls": { "fd": "https://www.hdfc.bank.in/fixed-deposit/fd-interest-rate" },
  "selectors": { "table": null, "rows": null },
  "column_mapping": { "0": "tenure_text", "1": "rate_general_pct", "2": "rate_senior_pct" },
  "expected_slab_count": 19,
  "deposit_insurance": true,
  "scraper_notes": {
    "framework": "AEM/server-rendered with JS hydration",
    "bot_protection": "CloudFront WAF",
    "data_format": "Tab-separated text in divs (not HTML tables)"
  }
}
```

### Rate File (`*_rates.json`)

```json
{
  "bank_code": "hdfc",
  "product_type": "FD",
  "effective_date": "2026-03-06",
  "extraction_confidence": "high",
  "rate_slabs": [
    {
      "tenure_text": "7 - 14 days",
      "tenure_min_days": 7,
      "tenure_max_days": 14,
      "rate_general_pct": 2.75,
      "rate_senior_pct": 3.25,
      "compounding_freq": "QUARTERLY"
    }
  ]
}
```

## Playwright Scraper

Many Indian bank sites (HDFC confirmed, likely others) require Playwright because:

1. **Rate data is JS-rendered** — not in the raw HTML
2. **Bot protection** (CloudFront/Akamai WAF) blocks plain HTTP requests
3. **No `<table>` tags** — data is in styled divs, extracted via body text parsing

The scraper (`scripts/fetch_rates_playwright.js`) handles all three:

```
:: Default (HDFC FD rates)
node scripts/fetch_rates_playwright.js

:: Any bank URL
node scripts/fetch_rates_playwright.js "https://www.somebank.bank.in/interest-rates"
```

See `docs/playwright-scraper.md` for detailed learnings from the HDFC Bank discovery.

## Scraper Type Guide

| Type | Meaning | Next Step |
|------|---------|-----------|
| `html_static` | Rates in plain HTML tables | `fetch + cheerio` with selectors |
| `html_js` | JS-rendered (React/Angular/AEM) | **Playwright** with anti-bot evasion |
| `pdf` | Downloadable PDF rate card | `pdf-parse` with the PDF URL |
| `mixed` | Some products HTML, some PDF | Combination approach |
| `government` | Ministry gazette / RBI notification | Special gazette parser |
| `manual` | No website or behind CAPTCHA | Manual data entry required |

## Recommended Discovery Order

1. **Public Sector Banks** (12) — large, well-structured sites
2. **Private Sector Banks** (21) — modern sites, JS-heavy (use Playwright)
3. **Small Finance Banks** (11) — generally good websites
4. **Scheduled Urban Co-op Banks** (52) — mixed quality
5. **Regional Rural Banks** (28) — varies widely
6. **Other categories** — many small co-ops may lack websites

## Architecture Alignment

This agent produces outputs that directly feed the Phase 2 pipeline:

- `*_config.json` → `packages/pipeline/src/configs/<bank_code>.json`
- `*_rates.json` → Initial seed data for the `rate_slabs` table
- `scraper_type` → Determines which scraper tier handles the bank
- `scraper_notes` → Captures bot protection and data format quirks per bank
- `selectors` / `column_mapping` → Used by the normalisation stage
