# Step 3e + Step 3f — DocIntel paths + currency-matrix paths

**Date:** 2026-05-24
**Plan:** `../plan/sprint-006-scope.md`
**Context:** Both steps un-deferred from Sprint 7 per operator decision 2026-05-24.

## What landed

**Step 3e — DocIntel paths in PSB + IBU extractors**:

- `lib/extractors/_helpers/docintel-grid.js` (NEW, 100 LOC, 15 tests)
  - `cellsToGrid(table)` — converts Azure DocIntel cells array to 2D row-major grid; handles rowSpan/columnSpan; mirrors `lib/actions/extract_via_ocr.js#cellsToGrid` so the dispatcher-path extractors don't import from legacy
  - `classifyColumns(headerRow)` — returns `{tenureCol, generalCol, seniorCol, superSeniorCol, currencyCol}` using header-token regexes
  - `parseRateCell(cell)` — numeric parse with `%`-stripping, `n/a`/`-`/empty handling
  - `findHeaderRowIndex(grid)` — first row with NO percentage cell is the header; default to 0

- `lib/extractors/psb-pdf-rate-card-3col.js` — DocIntel path replaced (was a skeleton)
  - Walks layout tables, scores each by has-tenure-AND-general-cols + has-data-rows, picks best
  - Emits slabs with `source_row_text` from concatenated row cells (anti-fabrication)
  - Diagnostics include `column_map`, `rows_seen`, `rows_kept`, `rows_dropped_reasons`

- `lib/extractors/ibu-static-pdf-quarterly.js` — DocIntel path replaced (was a skeleton)
  - Same table scoring + extraction as PSB
  - **Plus currency detection** from header cells (tries `normaliseCurrency` exact match, then regex extraction of embedded codes like "USD Rate" → USD)
  - Tags every emitted slab with the dominant currency
  - Multi-currency PDFs (USD + GBP + EUR header) emit a warning that single-currency tagging is used; per-(tenure × currency) expansion lives in `currency-matrix.js` but isn't yet routed here (IBU PDFs in the pilot are USD-only; Sprint 7 if multi-ccy PDFs appear)

**Step 3f — Currency-matrix paths in PVB + FB FCNR/GIFT**:

- `lib/extractors/_helpers/currency-matrix.js` (NEW, 130 LOC, 8 tests)
  - `extractCurrencyAsColumns(rows)` — Pattern B (most common): `{Tenure, USD, GBP, EUR, JPY, ...}` rows
  - `extractCurrencyAsRows(rows)` — Pattern A: `{Currency, 1y_rate, 2y_rate, ...}` rows
  - `extractFromCurrencyMatrix(rows)` — dispatcher; tries B first, then A, picks whichever produced more slabs
  - Tolerates embedded currency codes in headers ("USD Rate" → USD)
  - FCNR/GIFT slabs MUST have `rate_senior_pct: null` (no senior premium in foreign currency)

- `lib/extractors/pvb-multi-variant.js` — FCNR/GIFT path replaced (was a skeleton)
  - Picks best-scoring `<table>` from the HTML via Sprint 5 `score-table.js`
  - Dispatches to `extractFromCurrencyMatrix`
  - Anti-fabrication: tenure must match source row (rate-match relaxed for matrix patterns)
  - Diagnostics include the pattern (A vs B), per-pattern slab counts, currency column counts

- `lib/extractors/fb-multi-variant.js` — same treatment as PVB

## Verification

```
$ node --test tests/extractors/docintel-grid.test.js        → 15 pass
$ node --test tests/extractors/currency-matrix.test.js      → 8 pass
$ node --test tests/extractors/new-extractors.test.js       → 14 pass (updated)
$ npm test                                                  → 1083 pass / 0 fail / 51 skip
```

Combined Sprint 6 test count: started Sprint 5 at 977; now at 1083 (+106).

## What this unblocks

After Step 3e + 3f, Sprint 6 exit criterion #4 is FULLY met (not just skeleton-met):
> 4 new extractor modules shipped (PSB, PVB, FB, IBU) with unit tests + REAL DocIntel/currency-matrix paths (not stubs).

The IBU + PSB extractors now do real DocIntel extraction; the PVB + FB FCNR/GIFT paths now do real currency-matrix extraction. The pilot 50 cohort's IBU + FCNR variant migrations (Wave 3) will exercise these paths end-to-end.

## Sprint 6 status snapshot

| Sub-step | Status |
|---|---|
| 1a — fetch_html | ✅ committed |
| 1b — challenge_detect | ✅ committed |
| 1c — fetch_pdf + doc_intelligence | ✅ committed |
| 1d — author-template.js skeleton | ✅ committed |
| 1e — harvest-golden-html.js | ✅ committed |
| 1f — Phase A.4 re-attempt | ✅ committed |
| 1g — Azure client refactor | ✅ committed |
| 1h — real LLM-propose in author-template.js | ✅ committed |
| 2 — per-bank manifest | ✅ committed |
| 3a — extract_html_table.js split | DEFERRED to Sprint 7 (only because Step 4 must run first; structurally not blocking) |
| 3b — 4 new template extractor skeletons | ✅ committed |
| 3c — extract_html_table.js retirement | DEFERRED to Sprint 7 (operator-driven post-migration) |
| 3d — real AOAI in _llm-fallback | ✅ committed |
| 3e — DocIntel paths in PSB+IBU | ✅ THIS COMMIT |
| 3f — currency-matrix paths in PVB+FB | ✅ THIS COMMIT |
| 4 prep — migrate-pilot-wave.js + runbook | ✅ committed |
| 4 execute — operator runs the waves | **OPERATOR-DRIVEN POST-MERGE** (--write refuses agent invocations by design) |
| 5 — Phase F retirement | pending; Steps 5a+5b below |
| Sprint close (retro + memory) | pending |

## Sprint 7 follow-ups (narrowed)

Only TWO items remain for Sprint 7, and both are blocked on Step 4 (operator migration):
- **3a/3c**: retire `lib/actions/extract_html_table.js` once all callers (orchestrator) migrate to dispatcher exclusively. The new modules are canonical; legacy file unused after Step 4 pilot 50 completes.
- **Per-(tenure × currency) for IBU multi-currency PDFs**: only blocks BoI-IBU/IndusInd-IBU which are out of pilot scope.

Plus the operationally-deferred items from the original Sprint 7 list:
- `lib/agent.js` deletion (after Step 5 deprecation period)
- `scripts/fetch_rates_playwright.js` deletion (after Step 4 proves new fetch layer)
- Cloud orchestration re-wiring
- Long-tail migration (banks 51 - ~300)
- WAF-blocked FB recovery
- BoI-IBU / IndusInd-IBU recovery
