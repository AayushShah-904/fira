# Phase 3: Pre-Seed Known Domains + PDF Extractor — Implementation Notes

**Date:** 2026-03-28
**Status:** Complete
**Files created:** `scripts/seed-domains.js`, `data/bank-domains.json`, `scripts/extract_rates_pdf.mjs`
**Files modified:** `CLAUDE.md`

## Phase 3a: Known Bank Domains

### Problem
Every bank discovery started with a web search to find the official website, even for banks that had already been discovered. This wasted 1 WebSearch + 1 WebFetch call per known bank (~3-5K tokens each).

### Solution

**`scripts/seed-domains.js`** — One-time generator that reads all existing `output/*_config.json` files and extracts:
- `domain` (hostname, stripped of `www.`)
- `rate_pages` (path portion of rate page URLs, keyed by product type)
- `scraper_type` (html_static, html_js, pdf, etc.)
- `notes` (framework + bot protection from scraper_notes)

Generated **`data/bank-domains.json`** with 96 entries (all previously discovered banks):
- 85 of 96 have known FD rate page URLs (can skip Steps 1 and 2)
- 11 have domain only (can skip Step 1)

Distribution by scraper_type:
| Type | Count |
|------|-------|
| html_static | 45 |
| html_js | 23 |
| pdf | 19 |
| manual | 6 |
| mixed | 3 |

**CLAUDE.md** — Added "Step 0: Check Known Domains" before Step 1:
- Agent derives bank_code, looks up in `data/bank-domains.json`
- If domain + rate_page found → skip Steps 1-2, go directly to Step 3
- If only domain found → skip Step 1, do Step 2 on known domain
- If not found → full 5-step workflow

### Maintenance
`data/bank-domains.json` is checked into git. As new banks are discovered, re-run `node scripts/seed-domains.js` to regenerate from output configs. Can also be manually edited for corrections.

## Phase 3b: PDF Extractor

### Problem
24% of banks (19 of 96) serve PDF rate cards. The discovery agent correctly identifies the PDF URL and marks `scraper_type: "pdf"`, but produces empty `rate_slabs: []`. The `pdf-parse` and `pdfjs-dist` packages were already installed but unused.

### Solution

**`scripts/extract_rates_pdf.mjs`** — Standalone PDF rate extractor using `pdfjs-dist`.

**Why `.mjs` (ESM)?** The `pdfjs-dist` package only ships ESM modules (`.mjs` files in `build/` and `legacy/build/`). Since the rate-discovery-agent is CommonJS, the extractor uses `.mjs` extension to enable ESM imports while the utilities (`parse-tenure`, `validate-rates`) are loaded via `createRequire()`.

**Extraction flow:**
1. Accept PDF path or URL as input
2. If URL: download via Node `https.get` with redirect following
3. Load PDF with `pdfjs-dist/legacy/build/pdf.mjs`
4. Extract text from all pages, grouping text items into lines by Y coordinate (items within 3px vertical distance are on the same line)
5. Parse rate lines using regex: `tenure_text \t rate1% \t rate2% \t rate3%`
6. Normalize tenure text for edge cases:
   - "07days - 14 Days" → "7 days to 14 days" (insert space between digits and unit)
   - ">=1096 Days" → "1096 days and above"
   - "> 2Years" → "3 years and above" (> means next integer)
   - "732 - 1095 Days" → "732 days to 1095 days"
7. Apply `parseTenure()` and `validateRate()` from utilities
8. Extract effective date from text ("with effect from", "w.e.f.", "modified date")
9. Output structured JSON after `=== JSON_OUTPUT ===` marker

**CLAUDE.md** — Added Tier 3 extraction instruction to use:
```bash
node scripts/extract_rates_pdf.js <pdf_url>
```

### Testing

| PDF | Bank | Slabs | Tenure Parse | Effective Date |
|-----|------|-------|-------------|---------------|
| citibank-na_deposit_rates.pdf | Citibank | 34 (17 Resident + 17 NRO) | All parsed | 16-Dec-25 |
| cooperatieve-rabobank-ua_deposit_rates.pdf | Rabobank | 13 | All parsed (after normalizer fix) | Not found |
| yes_bank_rates.pdf | YES Bank | N/A | N/A | N/A — file is actually HTML, not PDF |

### Known Limitations

1. **pdfjs-dist warnings** — Outputs `Cannot polyfill DOMMatrix` and `standardFontDataUrl` warnings to stderr. These are cosmetic (text extraction still works) but noisy. Could be suppressed by providing the standard fonts path, but not critical.

2. **Duplicate tables** — Citibank PDF has Resident and NRO/NRE tables with identical rates. Both are extracted (34 slabs instead of 17). The caller (or Phase 4 extraction router) should deduplicate or label by variant.

3. **Amount-slab grids** — JP Morgan-style PDFs with 13+ amount columns are not fully handled. Currently extracts the first rate column only. Phase 5 could enhance this.

4. **Scanned PDFs** — Only works with text-based (digital) PDFs. Scanned/image PDFs would need OCR, which is out of scope.
