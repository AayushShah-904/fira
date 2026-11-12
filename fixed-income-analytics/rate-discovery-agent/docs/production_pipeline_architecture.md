# Architecture Blueprint: Production-Ready Rate Discovery Pipeline

**Document Purpose:**
This document outlines the architectural solutions required to transition the Rate Discovery Agent from a naive scraper to an industry-ready, robust data pipeline. It specifically addresses the "Overwrite Disasters" where automated agents corrupt or delete perfectly clean manual data due to website structural changes, hardcoded URLs, or fallback logic flaws.

**Implementation Status Legend:**
- ✅ IMPLEMENTED — code is live in the codebase
- 🔲 PLANNED — designed, not yet coded
- 📋 FUTURE — longer-term improvement

---

## Pillar 1 — Manual Lock Flag ✅ IMPLEMENTED

**Problem:** When a scraper fails (e.g., can't read a widget-based page), fallback logic kicks in and blindly copies data from another variant (e.g., Domestic table into NRE file), silently corrupting verified manual patches. Setting `url: null` was a workaround that destroyed source URL metadata.

**Solution:** A formal `extraction_modes` map in `bank-domains.json` per product, with value `"manual_locked"`.

### Schema (`data/bank-domains.json`)
```json
"idfc-first-bank-limited": {
  "rate_pages": {
    "fd":     "/personal-banking/deposits/fixed-deposit/fd-interest-rates",
    "fd_nre": "/nri-banking/nri-fixed-deposit/nre-fixed-deposit",
    "fd_nro": "/nri-banking/nri-fixed-deposit/nro-fixed-deposit"
  },
  "extraction_modes": {
    "fd_nre": "manual_locked",
    "fd_nro": "manual_locked"
  }
}
```
The `rate_pages` URL is preserved for human reference. The `extraction_modes` controls whether the agent is allowed to scrape.

### How It Works
`run-batch.js` passes `extraction_modes` to the orchestrator as `hints.cached_extraction_modes`. At the **very start** of every product loop iteration in `lib/orchestrator.js`, before fetching anything:

```js
const extractionMode = hints.cached_extraction_modes?.[product];
if (extractionMode === 'manual_locked') {
  log.info(`product=${product}: manual_locked — skipping`);
  variantSummary[variant] = { status: 'manual_locked' };
  continue; // jumps to next product; on-disk file is NEVER touched
}
```

### Flow
```
run-batch.js
    │
    ▼
orchestrator.js — iterates: [fd, fd_nre, fd_nro, fd_fcnr]
    ├── fd       → no lock → scrape normally ✅
    ├── fd_nre   → manual_locked → skip ⏩ (file untouched)
    ├── fd_nro   → manual_locked → skip ⏩ (file untouched)
    └── fd_fcnr  → no lock → scrape normally ✅
```

### Relationship with Custom Parsers (Pillar 3)
`manual_locked` and custom parsers solve **different problems**:

| Scenario | Custom Parser Helps? | `manual_locked` Needed? |
|---|---|---|
| Bank uses `<div>` widgets instead of tables | ✅ Yes — parser reads widgets | ❌ No longer needed once parser works |
| Website structure changes suddenly | ✅ If parser is updated | ✅ Emergency brake while parser is being fixed |
| Data transcribed from a phone call / non-public source | ❌ No parser can access | ✅ Yes — permanently |
| Bank's PDF is behind a login wall | ❌ No parser can reach it | ✅ Yes — permanently |
| Bank published incorrect rates on their website | ❌ Parser copies the bug | ✅ Yes — lock the corrected version |

**Recommended lifecycle:**
1. Bank has widget → set `manual_locked`, patch data manually
2. Build custom parser → test it → parser works
3. Remove `manual_locked` → automation takes over
4. If bank changes website again → set `manual_locked` temporarily

### Currently Locked Banks
| Bank | Product | Reason |
|---|---|---|
| IDFC First Bank | `fd_nre`, `fd_nro` | NRE/NRO pages use React `<div>` calculator widgets; generic parser extracts 0 slabs and triggers fallback. Senior Citizen rates are NOT applicable for NRI variants per RBI policy. |

### Files Modified
- [`lib/orchestrator.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/orchestrator.js) — manual lock guard added at top of product loop

---

## Pillar 2 — Dynamic PDF Discovery ✅ IMPLEMENTED

**Problem:** Hardcoding PDF URLs that contain dates (e.g., `...27-august-26.pdf`) is an anti-pattern. These URLs break the moment the bank uploads a new PDF, causing the scraper to fetch stale data.

**Solution:** The registry stores the HTML Landing Page and a `pdf_discovery` block with regex patterns. A pre-flight module (`lib/preflight-pdf-finder.js`) scans the live HTML page at runtime to find the latest matching PDF href and passes it downstream — eliminating the hardcoded URL dependency entirely.

### Registry Schema (`data/bank-domains.json`)
```json
"extraction": {
  "fd_pdf_nri": {
    "type": "pdf",
    "fulfills_product": ["fd_nre", "fd_nro"],
    "pdf_discovery": {
      "landing_page": "https://www.axisbank.com/deposits/fixed-deposits/fd-interest-rates",
      "link_pattern": "nri.*fixed.deposit.*\\.pdf",
      "exclude_pattern": "plus|floating|fcnr",
      "prefer_latest": true
    }
  }
}
```

### How It Works
1. Orchestrator iterates products and finds a hint with `pdf_discovery`
2. Calls `discoverPdfUrl()` from `lib/preflight-pdf-finder.js`
3. Module fetches the HTML landing page and extracts all `<a href="*.pdf">` links
4. Filters matches using `link_pattern` and removes noise using `exclude_pattern`
5. Returns the alphabetically last match (picks the most recent date-stamped filename)
6. Orchestrator sets `cachedPath` to the live URL — **static fallback only used if discovery fails**

### Live Test Results (2026-10-03) ✅
When run against Axis Bank's live website, the pre-flight discovered **brand new PDFs** that were completely unknown to our hardcoded registry:
```
Axis NRI:      .../nri-fixed-deposit-interest-rates-less-than-3-crores-01-october-2026.pdf
Axis Domestic: .../domestic-fixed-deposit-interest-rates-less-than-3-crores-01-october-2026.pdf
```
These are October 1, 2026 PDFs — 5 weeks newer than what was hardcoded in the registry.

### Targets Requiring Dynamic PDF Discovery
- **Axis Bank (NRI + Domestic):** ✅ Migrated — `pdf_discovery` added to `fd_pdf_nri` and `fd_pdf_domestic` hints
- **Yes Bank (FCNR):** 🔲 — rates stored in `nri_interest_rates_pdf.pdf`; at risk of renaming on next upload
- **Axis Bank IBU:** 🔲 — GIFT City rate charts distributed as PDFs
- **General FCNR Deposits:** Most banks (HDFC, Bank of Baroda, SBI) rely on PDFs for FCNR — volatile foreign currency rates change weekly/monthly
- **GIFT City (IBU) Branches:** Nearly all IBU rate cards are exclusively in PDFs due to newer, less-developed web infrastructure

### Files Created / Modified
- [`lib/preflight-pdf-finder.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/preflight-pdf-finder.js) — **NEW** — discovery engine (fetches HTML, regex-matches PDF hrefs)
- [`lib/orchestrator.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/orchestrator.js) — **MODIFIED** — pre-flight call injected before static hint resolution in product loop
- `data/bank-domains.json` — **MODIFIED** — Axis Bank `fd_pdf_nri` + `fd_pdf_domestic` hints now carry `pdf_discovery` blocks

---

## Pillar 3 — Custom Parser Adapters (Strategy Pattern) ✅ IMPLEMENTED

**Problem:** A generic HTML `<table>` parser fails for banks using non-standard HTML. When it fails, fallback logic corrupts data.

**Solution:** Strategy Pattern via `lib/parsers/` directory. A bank's extraction hint declares `"custom_parser": "<key>"`. The orchestrator routes the HTML body to that specific parser *before* attempting the generic extractor. If the custom parser returns 0 slabs, the generic extractor acts as a safety fallback.

### Orchestrator Flow
```
HTML page fetched
      │
      ▼
hint has custom_parser key?
   YES ──► runCustomParser(key, html)
              │
          slabs > 0?
           YES ──► use result ✅
            NO ──► generic extractHtmlTable (fallback)
    NO ──► generic extractHtmlTable directly
```

### Registry Schema (`data/bank-domains.json`)
```json
"extraction": {
  "fd_html_nre": {
    "type": "html",
    "fulfills_product": "fd_nre",
    "custom_parser": "idfc"
  }
}
```

### Files Created / Modified
| File | Purpose |
|---|---|
| [`lib/parsers/index.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/parsers/index.js) | Strategy dispatcher — maps keys to parser modules |
| [`lib/parsers/idfc-parser.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/parsers/idfc-parser.js) | IDFC First Bank — enforces NRE 1yr min tenure, `rate_senior_pct=null` |
| [`lib/parsers/bom-parser.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/parsers/bom-parser.js) | Bank of Maharashtra — sanitizes `xx` cells, section isolation |
| [`lib/parsers/cosmos-parser.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/parsers/cosmos-parser.js) | Cosmos Co-op — isolates correct variant table from multi-table page |
| [`lib/parsers/saraswat-parser.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/parsers/saraswat-parser.js) | Saraswat Co-op — dynamic column→currency mapping for FCNR |
| [`lib/orchestrator.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/orchestrator.js) | **MODIFIED** — custom parser check injected in HTML extraction branch |

### How to Add a New Parser (for future engineers)
1. Create `lib/parsers/<bank-id>-parser.js` exporting `async function parse(html, opts)`
2. Register it in `lib/parsers/index.js` `PARSER_REGISTRY`
3. Add `"custom_parser": "<bank-id>"` to the bank's extraction hint in `bank-domains.json`

### Test Results (all passing ✅)
| Parser | Test | Expected | Result |
|---|---|---|---|
| **BoM** | HTML with 2 valid rows + 1 `xx` row | 2 slabs | ✅ 2 slabs, `xx` row skipped |
| **IDFC (NRE)** | 3 rows: 1 sub-1yr + 2 valid | 2 slabs, senior=null | ✅ 2 slabs, `rate_senior_pct=null` enforced |
| **Saraswat (FCNR)** | 2 tenures × 3 currencies (USD/GBP/EUR) | 6 slabs | ✅ 6 slabs, dynamic column map worked |
| **Registry** | 4 valid keys, 1 unknown | true×4, false×1 | ✅ Correct |

### General Industry Edge Cases (Future Parsers)
- **Iframes:** Banks hiding rate tables inside `<iframe>` pointing to third-party vendor servers
- **Accordions/Tabs:** Banks hiding NRE/NRO behind clickable tabs requiring Playwright `.click()` before DOM renders
- **Images/Scans:** Rate cards as `.jpg` / `.png` — route to Azure Document Intelligence OCR



## Pillar 4 — Anomaly Detection / Quality Gates ✅ IMPLEMENTED

**Problem:** Silent failures — the agent extracts 0 slabs (or stale data) and overwrites clean, verified files without any warning.

**Solution:** A pre-save `DiffEngine` in `lib/diff-engine.js` runs three checks before every write. It is hooked into `lib/safe-write.js` — the **single write chokepoint** all writes pass through.

### Three Checks

#### Check 1: Volume Drop → HARD REJECT
```
existing = 12 slabs  |  incoming = 0 slabs  →  REJECTED
reason: "volume_drop: existing=12 slabs, incoming=0 slabs"
incoming is routed to .pending.json for operator review
```

#### Check 2: Stale Regression → HARD REJECT
```
existing.effective_date = 2026-09-01  |  incoming.effective_date = 2025-01-01
→  REJECTED
reason: "stale_regression: incoming=2025-01-01 is older than existing=2026-09-01"
```

#### Check 3: Rate Variance > 2% → WARNING ONLY (write still proceeds)
```
existing: 7-14 days = 3.75%  |  incoming: 7-14 days = 1.00%  (delta = 2.75%)
→  VARIANCE WARNING logged, write NOT blocked
Engineers must review the warning log
```

### Key Design Decision: Operator Writes Are Exempt
Manual patches by the operator always land, regardless of what the diff engine says:
```js
// In safe-write.js:
if (kind === 'rates' && !force && source !== 'operator') {
  // diff checks run here
}
// operator writes (force=true OR source='operator') skip all diff checks
```

### Test Results (all passing ✅)
| Test | Input | Expected | Result |
|---|---|---|---|
| Volume Drop | 138 existing slabs → 0 incoming | REJECT | ✅ REJECTED |
| Stale Regression | existing=2026-10-02, incoming=2025-01-01 | REJECT | ✅ REJECTED |
| Rate Variance | 3.75% → 1.00% (delta 2.75%) | WARN only | ✅ WARNED, not rejected |
| Clean new write | normal new date + valid slabs | ALLOW | ✅ ALLOWED |

### Files Created / Modified
- [`lib/diff-engine.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/diff-engine.js) — **NEW** — the three quality gate checks
- [`lib/safe-write.js`](file:///d:/College/Intership/Bharatomni%20Technology/Development/week-5/fia-agent-intregrations/fixed-income-analytics/rate-discovery-agent/lib/safe-write.js) — **MODIFIED** — diff-engine hooked in before rejection rule 1

---

## Summary: What Each Pillar Protects Against

| Disaster Scenario | Pillar 1 Lock | Pillar 2 PDF | Pillar 3 Parser | Pillar 4 Gates |
|---|---|---|---|---|
| Agent overwrites verified manual patch | ✅ | ❌ | ❌ | ✅ |
| Stale PDF URL → old data overwrites new | ❌ | ✅ | ❌ | ✅ |
| Widget page → 0 slabs → file wiped | ✅ (temp) | ❌ | ✅ (perm) | ✅ |
| Wrong table scraped, garbage data saved | ❌ | ❌ | ✅ | ✅ |
| Rate suddenly drops 4% (data anomaly) | ❌ | ❌ | ❌ | ✅ (warn) |
| Bank renames PDF file | ❌ | ✅ | ❌ | ✅ (0 slabs block) |
