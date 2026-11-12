# Phase 0 — Summary and downstream plan revisions

**Date:** 2026-05-24
**Closes:** Phase 0 (data mining)
**Sub-step reports:**
- `./phase-0-baseline-snapshot-2026-05-24.md`
- `./phase-0-cluster-analysis-2026-05-24.md`
- `./phase-0-failure-inventory-2026-05-24.md`
- `./phase-0-golden-harvest-2026-05-24.md`
- `../../scripts/analysis/code-inventory.md` (Phase 0.3)

## Goal of Phase 0

Before writing any production code for the architectural reset, ground every later phase in observed reality from the 633 existing extractions, sprint-003/004 retros, and the current pack BLOCK findings. The exit criterion: if data invalidates the template-first assumption, revisit the plan; if it validates, hand A–E a punch list grounded in evidence.

## Verdict

**The template-first architecture is the right call, with significant revisions to extractor priorities and migration order driven by the data.**

The stop-condition threshold (success top-30 cluster coverage > 50%) was met at **54%** — just over the line. Workable, but it confirms that singleton handling (`_generic-html-3col.js` and `_llm-fallback.js` fallbacks) is as important as the per-template extractors. The win is concentrated in a few mega-clusters, not evenly distributed across 30 templates.

## Headline insights

### 1. The .bank.in co-op mega-cluster is the highest-leverage extractor target

The top 6 success clusters (103 banks combined) all share: `html_static` + `.bank.in` + regular-only + has-senior + slab-count 4-15. They are **one template family** with bank-type and slab-count variation. A single extractor — provisionally `coop-bankin-3col-tenure-general-senior.js` — would unblock ~100 banks at once.

**Plan revision:** The original migration order (PSB → PVB → FB → SFB → co-op) is upside-down by extractor leverage. New order: **co-op .bank.in family → PSB → PVB/FB multi-variant → IBU/manual stop conditions**.

### 2. The "unknown scraper_type" cluster is a dispatcher bug, not a discovery failure

~31 banks across NSUCB/DCCB have `scraper_type: null` in their configs because discovery bailed early. The dispatcher gives up before fetching when `scraper_type` is null. **Phase A dispatcher fix:** default `unknown → html_static`, attempt fetch, re-classify based on response. Cheapest, highest-leverage Phase A change in the sprint.

### 3. JS-rendered .bank.in pages cluster (~20 banks) needs one Phase B fix

Today's Playwright wrapper waits for `domcontentloaded` — too early for many .bank.in JS sites. Replacing the default `waitForFunction` with `() => document.querySelectorAll("table").length > 0 && /%/.test(document.body.innerText)` moves ~20 banks from BLOCK to PASS.

### 4. Pack regressions and rate anomalies are the SAME problem with different symptoms

A column-mapping bug shows up as a regression (cells dropped → fewer slabs) AND as an anomaly (senior_below_general when the senior column actually carries a different product, e.g. bandhan-bank's `general:6.5, senior:1.0` is the minimum-deposit-in-lakhs column being misread). **Don't double-count effort** — fixing the column_map per template closes both classes at once.

### 5. Class C (cohort-runtime failures) is zero — silent success is the trust gap

Across 14 cohort runs in the baseline, no bank threw a runtime exception. The orchestrator is good at completing-without-erroring. The same banks that "completed successfully" produced zero-slab rates files that show up as 100% regressions. **A successful run that produced no data is indistinguishable from a successful run that produced real data**, unless you read the rates file. The Phase D per-bank manifest's `fallback_engaged` and `rows_kept` fields convert this silent failure into a loud one.

### 6. OCR is wired (correction logged in Phase 0.3 code-inventory)

`lib/actions/extract_via_ocr.js` (Sprint 004 M3) and `lib/actions/extract_via_vision.js` (Sprint 003 A5) are both fully wired Azure paths. `pending_vision` / `pending_ocr` are bookkeeping markers (CURATED) per `lib/extraction-methods.js:71-72`, not "feature missing" flags. Both extractors lift as-is into `lib/extractors/` under the new architecture.

## Phase outputs ready for downstream consumption

| Output | Consumer |
|---|---|
| `tmp/baseline-pre-reset/` (5.3 MB snapshot) | Phase E per-bank parity check (±1 slab, ±5bps) |
| `tmp/analysis/clusters.json` + `clusters.md` | Phase A1 fingerprint validation; Phase C1 extractor list; Phase E migration order |
| `tmp/analysis/failures.json` + `failures.md` | Phase B retry escalation rungs; Phase C extractor priorities; Phase D manifest signals |
| `scripts/analysis/code-inventory.md` | Phase A–F lift/fix/replace/delete map |
| `tests/golden-html/<bank>.{expected,expected.meta}.json` × 50 | Phase D3 golden test fixtures |
| `tests/golden-html/regression-cases/<bank>__<variant>.{actual,baseline,diff}.{json,md}` × 105 | Phase C per-extractor regression gate; Phase E per-bank promotion gate |
| `tests/golden-html/INDEX.json` | Phase D3 test runner index |

## Plan revisions (`../plan/sprint-005-scope.md` will be updated separately)

### Phase A — Template Fingerprinting + Registry

- **A.1 fingerprint** unchanged in design — but the expected output count from "30-35 templates" is empirically closer to **25 distinct ≥3-bank clusters** structurally; the finer DOM-level fingerprinting (once it can re-fetch HTML) likely brings the total to **35-50**, with the long tail dominated by the .bank.in co-op family sub-themes.
- **A.2 schema extension** unchanged.
- **A.3 author-template.js** — add a "dispatcher repair" code path: when bank has `scraper_type: unknown` in registry, the authoring CLI tries `html_static` as a default fetch first before invoking LLM authoring. This recovers ~31 banks without LLM cost.

### Phase B — Fetch Layer

- **B.1 fetch_html** — the default `waitForFunction` must be `() => document.querySelectorAll("table").length > 0 && /%/.test(document.body.innerText)`. This is the load-bearing fix for the JS-rendered .bank.in cluster.
- **B.3 challenge_detect** — already correctly scoped per the failure inventory; the FB/html_js cluster (ANZ, KEB Hana, Woori, Societe Generale) is the calibration test set.

### Phase C — Extractor Registry

- **NEW extractor:** `coop-bankin-3col-tenure-general-senior.js` — the .bank.in co-op family. Single-table, 3-column (tenure / general / senior), 4-15 slabs. ~100 banks covered. **This is now the priority extractor, not the originally-listed `wp-table-3col-tenure-general-senior`.**
- The originally-listed templates remain valid but reorder by leverage:
  1. `coop-bankin-3col-tenure-general-senior` (~100 banks)
  2. `psb-pdf-rate-card-3col` (~12 banks, but high-traffic)
  3. `aem-tabbed-fcnr-currency-matrix` (Canara/PNB/IDBI/IndianBank — fixes the FCNR cell-loss bug)
  4. `bootstrap-multitable-with-merged-headers` (Kotak family — fixes the wrong-table-pick bug)
  5. `axis-multi-column-with-sub-headers` (Axis-class multi-column PDFs)
  6. `hdfc-section-context-tabs`
  7. `ibu-static-pdf-quarterly` (BoI/IDBI/IndusInd IBU)
  8. `_generic-html-3col` (no-template fallback)
  9. `_llm-fallback` (LLM extraction, traceability enforced)
- The `image-ocr-via-docintel.js` and `image-vision-llm.js` extractors are thin wrappers around the already-wired `extract_via_ocr.js` and `extract_via_vision.js`.

### Phase D — Observability + Quality Gate Hardening

- **Manifest schema addition:** `extraction_method_drift` — when a bank's `extraction_method` flips between automatic and llm_fallback across consecutive runs, flag it. This is the structural signal for the "silent success" class.
- D2 signed-accept CLI design unchanged.
- D3 golden test framework — the test runner skips fixture pairs without a matching `.html` until Phase A's `harvest-golden-html.js` backfills them.

### Phase E — Migration

**Revised order:**
1. **co-op .bank.in family** (~100 banks) — single extractor, biggest leverage.
2. **PSB** (12 banks) — high-visibility, but small bank count.
3. **PVB** (~21 banks) — multi-variant (NRE/NRO/FCNR), most complex extractors.
4. **FB** (~45) — WAF-blocked subset goes straight to manual.
5. **IBU** (~30) — most go to manual stop-condition; a few (HDFC-IBU, IDBI-IBU) get dedicated PDF extractors.
6. **Long tail** — `_generic-html-3col` + `_llm-fallback` carries the singletons.

### Phase F — Delete / Simplify

Unchanged. The Phase 0.3 code-inventory pins the exact delete list:
- `lib/agent.js` (after stub period)
- `lib/extraction-hint.js` (after migration to `template.extract.column_map`)
- `lib/prompts/{build-prompt.js,fragments.js}` (with `lib/agent.js`)
- `scripts/fetch_rates_playwright.js` (replaced by `lib/fetch/fetch_html.js`)
- `prompts/discover.md` (replaced by `lib/prompts/author-template.md`)

## Sprint 005 exit criteria (revisited against Phase 0 outcomes)

| Original exit criterion | Status |
|---|---|
| 1. Phase 0 outputs committed to sdlc + tests/golden-html | ✅ Ready to commit |
| 2. Cluster topology validates "30-35 templates" assumption | ⚠️ Met threshold (54% > 50%) but with revisions: data says start with co-op mega-cluster, not PSB |
| 3. `lib/templating/fingerprint.js` shipped with unit tests; schema extension landed | ⏭️ Phase A — not yet started |
| 4. One PSB extractor shipped + replaces LLM path for ≥3 PSBs + slab parity vs baseline | ⏭️ Phase C — proposed change: ship `coop-bankin-3col-tenure-general-senior` first (higher leverage) and PSB second |
| 5. `bin/approve-accept.js` shipped — closes 2026-05-23 trust incident structurally | ⏭️ Phase D — not yet started |

Recommend keeping exit criteria 3 and 5 firm; **swap criterion 4 from "one PSB extractor" to "one mega-cluster extractor (coop-bankin) covering ≥20 banks"** for higher Sprint-005 impact.

## What to commit at Phase 0 close

```
sdlc/sprints/sprint-005/plan/sprint-005-scope.md
sdlc/sprints/sprint-005/plan/phase-0-data-mining-handoff.md
sdlc/sprints/sprint-005/design/README.md
sdlc/sprints/sprint-005/implementation/README.md
sdlc/sprints/sprint-005/implementation/phase-0-baseline-snapshot-2026-05-24.md
sdlc/sprints/sprint-005/implementation/phase-0-cluster-analysis-2026-05-24.md
sdlc/sprints/sprint-005/implementation/phase-0-failure-inventory-2026-05-24.md
sdlc/sprints/sprint-005/implementation/phase-0-golden-harvest-2026-05-24.md
sdlc/sprints/sprint-005/implementation/phase-0-summary-2026-05-24.md
scripts/analysis/baseline-snapshot.js
scripts/analysis/cluster-existing-configs.js
scripts/analysis/failure-inventory.js
scripts/analysis/harvest-goldens.js
scripts/analysis/code-inventory.md
tests/golden-html/<…> (50 pairs + INDEX.json)
tests/golden-html/regression-cases/<…> (35 × 3 files)
```

`tmp/baseline-pre-reset/` and `tmp/analysis/` are NOT committed — they're working artifacts. `tmp/baseline-pre-reset/` should be checked into a separate archive (or kept as a long-lived working snapshot) but isn't part of source control.

## Next concrete action

Update `../plan/sprint-005-scope.md` Phase outline and exit criteria to reflect the revisions in this summary, then begin Phase A with the design doc `../design/template-fingerprinting.md`.
