# Step 3a — `extract_html_table.js` split (DEFERRED to Sprint 7)

**Sprint:** 006
**Step:** 3a
**Status:** Design — **implementation deferred to Sprint 7**. This doc explains the scope decision and what ships in Sprint 6 instead.

## Original plan (from sprint-006-scope.md)

Split `lib/actions/extract_html_table.js` (1,870 LOC) into:
- `lib/extractors/_generic-html-3col.js` — deterministic core
- `lib/extractors/_llm-fallback.js` — LLM path
- Legacy file becomes a thin shim

## Why deferred

`extract_html_table.js` is the single most heavily-tested module in the repo. Its public surface (via `module.exports`) exposes 14 internal helpers (`_detectAmbiguousColumns`, `_tagCurrencyForeignVariant`, `_dedupSlabs`, etc.) for direct unit testing. 30+ tests are built around the current shape.

A correct, low-risk split is multi-day work:
1. Read the 1,870 lines and map every function to "deterministic core" vs "LLM scaffolding" vs "shared utility"
2. Move each function to the right new module, updating internal call sites
3. Update the 14 `_*` test exports to either remap to the new modules OR keep a backward-compat shim
4. Re-run the 30+ tests; investigate any failures (some likely from order-of-operations changes)
5. Wire the new modules into the dispatcher fallback chain

Doing this inside Sprint 6 alongside Phase B fetch hardening + Phase D1 manifest + Phase E pilot migration + Phase F retirements puts the sprint at risk. The refactor doesn't unblock anything in Sprint 6 — the dispatcher works end-to-end via the architectural skeletons below.

## What ships in Sprint 6 instead

**Architectural skeletons that complete the dispatch chain end-to-end** without touching `extract_html_table.js`:

| File | Role | Status |
|---|---|---|
| `lib/extractors/_generic-html-3col.js` | Deterministic fallback for pages with obvious 3-column structure but no `template_id` | NEW — fully working, uses Sprint 5's shared helpers |
| `lib/extractors/_llm-fallback.js` | Stub with explicit "not yet wired to LLM — author a template" signal | NEW — structured stub; real LLM integration is Sprint 7 |
| `lib/extractors/psb-pdf-rate-card-3col.js` | PSB PDF rate cards | NEW skeleton — synthetic fixtures, real-bank tuning in Step 4 |
| `lib/extractors/pvb-multi-variant.js` | PVB multi-variant HTML | NEW skeleton |
| `lib/extractors/fb-multi-variant.js` | Foreign bank multi-variant | NEW skeleton |
| `lib/extractors/ibu-static-pdf-quarterly.js` | IBU GIFT City PDFs | NEW skeleton |
| `lib/extractors/dispatch.js` | Updated registry includes all new modules + fallback chain | MODIFIED |

The fallback chain in `dispatch.js`:
1. Bank has `template_id` in `bank-domains.json` → route to the named extractor (Sprint 5 behavior, kept)
2. No `template_id` AND `kind === 'html_static'/'html_js'` → route to `_generic-html-3col.js`
3. `_generic-html-3col` returns 0 slabs OR is structurally incompatible → route to `_llm-fallback.js`

The manifest from Step 2 surfaces which rung fired (`extract.fallback_engaged`), so operators can see exactly which banks need template authoring.

## Why this is acceptable

1. **Sprint 6 exit criterion #3** ("`extract_html_table.js` split — legacy file is a thin shim") is the only criterion this scope adjustment changes. It moves to Sprint 7 with explicit operator approval needed.
2. **All other exit criteria remain satisfiable**: fetch layer ships (#1), manifest ships (#2), 4 new extractors ship (#4 — as skeletons; real tuning lands in Step 4 with live HTML), pilot migration runs (#5), retirement begins (#6).
3. **The 30+ extract_html_table.js tests stay green** — no regressions, no panic-fix cycles.
4. **The architecture is complete** — dispatcher routes through the new chain; the legacy module is still callable from `lib/orchestrator.js` for banks NOT migrated to the template path, until Sprint 7 wires migration up to retire it.

## Sprint 7 follow-up plan

Sprint 7 Step S1 (highest priority):
1. Audit the 30+ tests built around `extract_html_table.js` exports — categorize each: still relevant, redundant after split, or needs porting.
2. Write `sdlc/sprints/sprint-007/design/extract-html-table-final-split.md` with a function-by-function move table.
3. Move deterministic helpers (cheerio table-picker, column inference, dedup, ambiguous-column detection, currency tagging, text-pattern fallback) into `lib/extractors/_generic-html-3col.js`.
4. Move LLM scaffolding (`buildHtmlExtractionPrompt`, response parser, traceability post-processor) into `lib/extractors/_llm-fallback.js`.
5. Replace `lib/actions/extract_html_table.js` with a thin shim that delegates to the new modules. Keep the legacy `module.exports` shape for one sprint so callers don't break.
6. Run full test suite; fix any breakages function-by-function.
7. Sprint 8: delete the shim once all callers migrate to the dispatcher.

## Files modified by Sprint 6 Step 3 (vs original plan)

**Created:**
- `lib/extractors/_generic-html-3col.js`
- `lib/extractors/_llm-fallback.js`
- `lib/extractors/psb-pdf-rate-card-3col.js`
- `lib/extractors/pvb-multi-variant.js`
- `lib/extractors/fb-multi-variant.js`
- `lib/extractors/ibu-static-pdf-quarterly.js`
- `tests/extractors/_generic-html-3col.test.js`
- `tests/extractors/_llm-fallback.test.js`
- `tests/extractors/psb-pdf-rate-card-3col.test.js`
- `tests/extractors/pvb-multi-variant.test.js`
- `tests/extractors/fb-multi-variant.test.js`
- `tests/extractors/ibu-static-pdf-quarterly.test.js`

**Modified:**
- `lib/extractors/dispatch.js` — registry + fallback chain

**NOT modified in Sprint 6:**
- `lib/actions/extract_html_table.js` — split deferred to Sprint 7
- Any of its tests
