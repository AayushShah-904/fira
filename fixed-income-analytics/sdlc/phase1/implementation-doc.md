# Phase 1: Rate Discovery & Bank Classification — Implementation Doc

## Completed: 2026-03-28

---

## What Was Built

Phase 1 delivered the rate-discovery-agent and its supporting infrastructure, then significantly exceeded scope with 6 optimization phases that reduced cost and time by ~50%.

### Rate Discovery Agent (`rate-discovery-agent/`)

A Claude Code agent that discovers bank websites, locates rate pages, classifies scraper types, and extracts deposit interest rates. One agent session per bank.

**Core workflow** (CLAUDE.md, 5 steps):
- Step 0: Check known domains (skip web search if bank is in `data/bank-domains.json`)
- Step 1: Find official website via web search
- Step 2: Locate interest rate pages on the site
- Step 3: Classify scraper type (html_static / html_js / pdf / mixed / government / manual)
- Step 4: Record extraction metadata (selectors, column mappings, scraper notes)
- Step 5: Write config + rates JSON files

**Invocation modes**:
- Interactive: `cd rate-discovery-agent && claude`
- Single bank: `node run-discovery.js "State Bank of India" "PSB" "Maharashtra"`
- Batch: `node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Public Sector Bank" --resume`

**Output per bank**:
- `output/<bank_code>_config.json` — website, rate page URLs, scraper type, selectors, column mappings, discovery confidence
- `output/<bank_code>_rates.json` — extracted rate slabs with tenure days, rates (general/senior/super-senior), effective dates

### Discovery Results

| Metric | Count |
|--------|-------|
| Config files generated | 96 |
| Rate files generated | 96 |
| Discovery logs captured | 105 |
| Batch result summaries | 3 |

**Categories discovered**:
- 4 PSBs (SBI, BoB, PNB, Union Bank) + all 21 PVBs
- 11 SFBs (AU, Bandhan, Capital, Equitas, ESAF, Jana, Shivalik, Slice, Suryoday, Ujjivan, Unity, Utkarsh)
- 6 Payments Banks (Airtel, Fino, IPPB, Jio, NSDL, Paytm)
- ~25 Foreign Banks (HSBC, Citibank, DBS, Deutsche, Barclays, etc.)
- ~24 Scheduled State Co-operative Banks

### Scraping Architecture Decision

**Document**: `sdlc/phase1/scraping-architecture.md`

The original plan called for a traditional config-driven pipeline (Crawlee/Cheerio/Playwright with CSS selectors). After testing the agent against SBI (Liferay), HDFC (AEM + CloudFront WAF), Cosmos (static HTML), and Axis (6 separate PDFs), the architecture pivoted to a **hybrid approach**:

- **Agent = primary extractor** — handles bot detection, JS rendering, PDF parsing, footnote rules, table variations without per-bank code
- **Change detection = daily lightweight check** — HTTP fetch + content hash triggers agent re-extraction only on change
- **Cost**: ~$3/week for ~300 banks instead of $210/week for daily full crawl

### Batch Processing Infrastructure

**`run-batch.js`** — processes banks from the RBI CSV file by category:
- Parses CSV with the same `findCategoryInRow` logic from the seed generator (handles unquoted commas in bank names)
- 4-way status classification: `success | failed | timeout | rate_limited`
- Rate-limit detection with consecutive backoff (60s → 5min pause → abort)
- Smart `--resume`: retries rate-limited banks, skips succeeded ones
- `--retry-failed` flag for opt-in retry of failed banks
- `--concurrency N` for parallel processing (max 5)
- Per-batch results file: `output/_batch_results_<category>.json`

**`run-discovery.js`** — single-bank runner:
- Spawns Claude Code CLI with prompt file + bank input
- `--extract` / `--no-extract` flags (default: extract)
- Logs to `output/<bank_code>.log`

### Shared Utilities (`scripts/utils/`)

Deterministic logic extracted from both the agent and the monorepo's shared package:

| File | Purpose | CLI |
|------|---------|-----|
| `slugify.js` | Bank code generation (port of `helpers.ts`) | `node slugify.js "HDFC Bank"` |
| `parse-tenure.js` | Tenure text → min/max days (port of `tenure-maps.ts`) | `node parse-tenure.js "1 year to less than 2 years"` |
| `validate-rates.js` | Rate bounds + slab continuity checks | `node validate-rates.js output/sbi_rates.json` |
| `config-defaults.js` | Default values + `mergeWithDefaults()` / `stripDefaults()` | — |
| `index.js` | Barrel re-export | — |

### Extraction Tools

| File | Purpose | Depends On |
|------|---------|-----------|
| `scripts/fetch_rates_playwright.js` | JS-rendered page extraction with anti-bot measures | Playwright |
| `scripts/extract_rates_pdf.mjs` | PDF rate card extraction | pdfjs-dist |
| `scripts/extract_rates.js` | Deterministic extraction router (HTML/JS/PDF) | Above two |
| `scripts/run-extract-only.js` | Batch extraction without LLM | extract_rates.js |
| `scripts/seed-domains.js` | Generate `data/bank-domains.json` from existing configs | — |

**Tiered extraction routing** (skips LLM for known banks):

| Tier | Condition | Time | Tokens |
|------|-----------|------|--------|
| A | Known domain + html_static | 30s | 0 |
| B | Known domain + html_js | 1min | 0 |
| C | Known domain + pdf | 30s | 0 |
| D | Known domain, no rate page | 2-3min | 8-12K |
| E | Unknown bank | 3-5min | 15-20K |

### Import Pipeline

**`packages/api/src/db/seed/import-discovery.mjs`** (311 lines):
- Reads agent output files and updates the `banks` table
- Matches banks by slug code → name → fuzzy substring
- Maps `scraper_type` → `scraper_status` (active/manual_only/pending)
- Maps `discovery_metadata.confidence` → `discovery_status` (discovered/partial/not_found)
- Optionally imports rate slabs and creates product records
- Prints summary with status breakdown

### Admin Dashboard

- `GET /api/admin/discovery-stats` — total, by_discovery_status, by_scraper_status, by_category breakdowns
- `/admin/discovery` web route — progress bar, status cards, per-category table with inline progress bars

---

## Technical Challenges Encountered

1. **CloudFront WAF** (HDFC) — blocks default headless Chromium. Solved with Playwright + `AutomationControlled` disabled + custom UA + `navigator.webdriver` removal. All three measures required.
2. **No `<table>` tags** (HDFC) — rates rendered as styled divs. Solved by extracting `page.innerText("body")` and parsing tab-separated lines with regex.
3. **PDF rate cards** (Axis Bank) — rates in 6 separate date-stamped PDFs. Agent downloads and parses with pdfjs-dist.
4. **API rate limits** — 91% failure rate on foreign bank batch. Solved with rate-limit detection + backoff (optimization Phase 1).
5. **Footnote-based rules** — SBI Patron (80+) rate is "+10 bps" noted below the table, not in the table itself. Agent reads footnotes.
6. **Multiple tables per page** — SBI, HDFC, Axis all have retail vs bulk deposit tables. Agent extracts both.
7. **Windows shell issues** — pipe characters and special characters in bank names broke `cmd.exe`. Solved by passing prompts via stdin instead of CLI args.

---

## Git History

```
06274d2 Add extract-only tiered routing, config defaults, and deposit_range (Phase 6)
f6ebd26 Add Playwright scroll/tabs/intercept flags and batch parallelization (Phase 5)
c8cf51a Split discovery from extraction with deterministic rate router (Phase 4)
34e82b4 Add known-bank domain seeding and PDF rate extractor (Phase 3)
5672c46 Add rate-limit detection, backoff, and shared utility scripts (Phase 1-2)
30e7f38 Add discovery analysis doc and pdf-parse/pdfjs-dist dependencies
483dca1 Add scraping architecture doc: hybrid approach with agent + change detection
8012751 Scope batch summary to current category only
ff85e63 Standardize bank_code as slug across agent, scripts, and database
aa6b205 Simplify discovery output: spinner + one-line summary
16a7bac Add real-time progress logging to discovery agent
e9dba6a Pass prompt via stdin to avoid Windows cmd.exe argument mangling
18e0f5c Fix pipe character in prompt breaking Windows shell
f4b37a5 Fix Windows spawn and add resume to batch runner
9b402ce Updates to use node scripts instead of bash/powershell
44c36bf Updates to the rate discovery agent - use playwright
96bd769 Phase 1 infrastructure: import pipeline, admin dashboard, agent scripts
2529a59 Add rate-discovery-agent for bank website and rate page discovery
```

---

## Deviations from Plan

- **Hybrid architecture instead of config-driven scrapers**: The plan assumed Crawlee/Cheerio/Playwright with per-bank CSS selectors. Testing revealed the agent approach is cheaper to maintain and handles edge cases better. The scraping-architecture.md doc captures this pivot.
- **Optimization Phases 1-6 not in original plan**: Emerged after discovering that full discovery of 1958 banks at ~$500 was too expensive. Six optimization phases reduced projected cost to ~$220-300.
- **Tier 4 banks (1754 NSUCBs/DCCBs) not yet discovered**: Plan called for bulk discovery of all remaining banks. Deferred — optimizations make this tractable but it remains a large batch job.
- **Admin dashboard simpler than planned**: Plan specified a web route with bank-level drill-down. Implemented as a stats endpoint + simple progress page. Sufficient for Phase 1 tracking.

---

## Cost Analysis

| Metric | Original Estimate | After Optimizations |
|--------|-------------------|---------------------|
| Tokens per known bank | 18K | 0 (no LLM) |
| Tokens per unknown bank | 18K | 10-12K |
| Projected total for 1900 banks | ~34M tokens | ~15-20M tokens |
| Time per bank | 3-6 min | 30s-3min |
| Batch failure rate (rate limits) | 91% | ~0% |
| PDF banks with data | 0% | ~90% |
| Cost estimate | ~$500 | ~$220-300 |

---

## Known Issues / Debt

1. **~1800 banks undiscovered** — Tier 4 (NSUCBs, DCCBs) mostly expected to have no website. Batch job is ready (`run-batch.js --category "Non-Scheduled Urban Co-operative Bank"`), just needs execution time.
2. **Two config naming conventions** — legacy configs use short names (`sbi_config.json`), newer ones use full slugs (`state-bank-of-india_config.json`). Both import correctly but create duplicate rate slabs with slightly different tenure boundaries.
3. **CommonJS vs ESM split** — Agent utilities are CommonJS (`require()`), monorepo packages are ESM. Logic is ported/duplicated rather than shared. Future consolidation possible with a build step.
4. **Playwright not pre-installed in agent** — First JS-rendered bank discovery installs Playwright at runtime. Should be in `package.json` dependencies (added in later commits).
5. **Agent sometimes uses aggregator sources** — CLAUDE.md prohibits BankBazaar/Paisabazaar but the instruction occasionally gets overridden during complex discoveries. Needs reinforcement.
