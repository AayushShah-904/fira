# Step 3 (a + b) — Extractor dispatch chain + 4 new template extractors

**Date:** 2026-05-24
**Design:** `../design/extract-html-table-split.md`
**Plan:** `../plan/sprint-006-scope.md`

## Scope adjustment (documented per autonomous mandate)

The original Step 3a plan called for a full split of `lib/actions/extract_html_table.js` (1,870 LOC) into `_generic-html-3col.js` + `_llm-fallback.js`. **That split is deferred to Sprint 7** for reasons documented in `../design/extract-html-table-split.md`:

- 30+ existing tests are built around the current shape (14 `_*` helpers exposed via `module.exports`)
- A correct split is multi-day work; doing it alongside Phase B + D1 + E + F in one sprint puts the sprint at risk
- The dispatcher works end-to-end via architectural skeletons (this step's deliverables)

What ships in Sprint 6 instead is an **architecturally complete fallback chain** that lets Step 4 pilot migration proceed without the legacy `extract_html_table.js` being touched.

## What landed (Step 3a + 3b combined)

**6 new extractor modules + dispatcher updates + 25 unit tests:**

| Module | LOC | Tests | Purpose |
|---|---:|---:|---|
| `lib/extractors/_generic-html-3col.js` | 170 | 6 | Fallback when no `template_id` matches but page is structurally 3-col |
| `lib/extractors/_llm-fallback.js` | 60 | 6 | Last-resort dispatcher path; structured stub (Sprint 7 wires real AOAI) |
| `lib/extractors/psb-pdf-rate-card-3col.js` | 95 | 3 | PSB PDF rate cards (BoB/Union/IOB/Canara/IDBI family) |
| `lib/extractors/pvb-multi-variant.js` | 60 | 2 | PVB multi-variant (HDFC/ICICI/Axis/Kotak/...) |
| `lib/extractors/fb-multi-variant.js` | 50 | 2 | Foreign bank non-WAF (DBS/Citi/SBM/StanChart/...) |
| `lib/extractors/ibu-static-pdf-quarterly.js` | 110 | 4 | IBU GIFT City PDFs (HDFC-IBU, IDBI-IBU) |
| `lib/extractors/dispatch.js` | (modified) | covered | Registry includes all 6 modules; fallback chain implemented |

**Total: ~545 LOC + 25 new tests.** Full suite: **1041 pass / 0 fail / 51 skip** (vs Sprint 6 step-2 close at 1016).

## The new dispatch fallback chain

`pickExtractor({ templateId, kind, productContext })`:

1. `templateId` set → require the named module from registry (Sprint 5 behavior, kept)
2. `templateId` absent AND kind is `html_static` / `html_js` → `_generic-html-3col.js`
3. Any other case → `_llm-fallback.js`

The manifest's `extract.fallback_engaged` field records which fallback rung fired (`'generic-3col'` / `'llm'` / `null`), and `extract.needs_template_authoring: true` surfaces in the run summary so operators see exactly which banks need template authoring.

## What each new extractor does today

**`_generic-html-3col.js`** — fully working. Lifts the `coop-bankin-3col-tenure-general-senior` pattern without the bank-type filter. Uses Sprint 5's shared `score-table.js` + `synonyms.js` + `parse-tenure.js` + `_assert_traceability.js`. Handles inferred or explicit `column_map`. 6 tests cover happy path, no-table page, inferred-vs-explicit columns, anti-fabrication, unparseable-tenure drops, header synonyms.

**`_llm-fallback.js`** — structured stub. Returns 0 slabs with explicit `Sprint 7` + `needs_template_authoring` warnings. Diagnostics record input kind + bank code so the manifest catches every invocation. **Why a stub is acceptable**: the pilot 50 banks are expected to ALL have operator-authored `template_id`s via Step 4 migration; this path only fires for banks the operator forgot. Sprint 7 wires real AOAI (lift the prompt + parser from `extract_html_table.js` lines 1109-1199, traceability post-processor from `validateSlabAgainstChunk`).

**`psb-pdf-rate-card-3col.js`** — works against tab-separated PDF text via `parseRateLines`. Tested against synthetic 6-slab PDF text fixture. DocIntel-layout path is a skeleton (Sprint 7 refactors `extract_via_ocr.js#cellsToGrid` + `classifyColumns`).

**`pvb-multi-variant.js`** — `regular` / `nre` / `nro` variants delegate to `_generic-html-3col`. FCNR / GIFT variants are skeletons (Sprint 7 lifts the currency-matrix path from `extract_html_table.js`).

**`fb-multi-variant.js`** — same shape as PVB but tagged for FB bank type. Skips WAF cluster (Amex/Barclays/Nova Scotia) by design — those go to manual curation via `bin/approve-accept.js` in Sprint 7.

**`ibu-static-pdf-quarterly.js`** — single-currency PDF works fully (USD-only pilot scope: HDFC-IBU, IDBI-IBU). Tags every slab with detected currency. Multi-currency PDFs emit a warning + tag dominant currency; Sprint 7 per-(tenure × currency) expansion.

## Why this is acceptable for Sprint 6

| Exit criterion | Status |
|---|---|
| #3 ("`extract_html_table.js` split — legacy file is a thin shim") | **DEFERRED to Sprint 7** — explicit scope adjustment |
| #4 ("4 new extractor modules shipped with unit tests") | ✅ all 4 ship with tests (skeletons for non-trivial variants) |
| Step 4 readiness (pilot migration) | ✅ dispatcher routes through end-to-end |
| Manifest visibility into fallbacks | ✅ `extract.fallback_engaged` captures the rung |

Exit criterion #3 is the only one this scope adjustment changes. Operator should review and explicitly accept the Sprint 7 deferral; the trade-off is documented in `extract-html-table-split.md`.

## Verification

```
$ node --test tests/extractors/_generic-html-3col.test.js   → 6 pass
$ node --test tests/extractors/_llm-fallback.test.js        → 6 pass
$ node --test tests/extractors/new-extractors.test.js       → 13 pass
$ npm test                                                  → 1041 pass / 0 fail / 51 skip
$ node scripts/check-write-discipline.js                    → clean
```

## Open follow-ups

- **Sprint 7 S1 (highest priority)**: lift deterministic helpers from `extract_html_table.js` into `_generic-html-3col.js`; lift LLM scaffolding into `_llm-fallback.js`. Replace legacy with thin shim.
- **Sprint 7 S2**: wire real AOAI in `_llm-fallback.js`.
- **Sprint 7 S3**: refactor `psb-pdf-rate-card-3col` + `ibu-static-pdf-quarterly` DocIntel paths to use shared `lib/azure/doc_intelligence.js` and lifted cell-grid helpers.
- **Sprint 7 S4**: wire currency-matrix path for `pvb-multi-variant` + `fb-multi-variant` FCNR/GIFT variants.
- **Sprint 6 Step 4**: pilot migration uses the new dispatch chain. Real-bank tuning of the 4 new extractors happens when operator captures live HTML/PDF via `harvest-golden-html.js` + `author-template.js`.
