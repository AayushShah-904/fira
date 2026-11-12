# Phase 0.3 — Code inventory (lift / fix / replace / delete)

**Date:** 2026-05-24
**Phase:** 0.3 — Hand-written from grep + read pass over `lib/` and `scripts/utils/`.
**Purpose:** Pin the exact source paths and the disposition of every existing utility under the architectural reset, so Phases A–F don't re-discover what's already there.

**Production lib + scripts/utils LOC inventoried:** ~12,800 across 38 files.

## Important correction (2026-05-24)

In earlier conversation I described `pending_vision` as "image OCR not yet wired." That was wrong. The actual picture:

| Symbol | Type | Status |
|---|---|---|
| `lib/actions/extract_via_ocr.js` (527 LOC) | Code path | **Fully wired (Sprint 004 M3)** — calls Azure Document Intelligence `prebuilt-layout` on images / image-PDFs; emits `extraction_method: "automatic_ocr"`. |
| `lib/actions/extract_via_vision.js` (194 LOC) | Code path | **Fully wired (Sprint 003 A5)** — vision-LLM (gpt-4.1 + image) extraction; emits `extraction_method: "vision_model"`. Distinct from OCR; used when layout-API confidence is too low. |
| `pending_vision`, `pending_ocr` (in `lib/extraction-methods.js:71-72`) | Bookkeeping markers | **Curated bookkeeping**, NOT "feature missing" flags. They mean "operator has classified this bank as needing vision/OCR; current data is curated; auto-discovery loop must not overwrite it." Honored by `lib/tier-router.js` (skip gate) and `lib/safe-write.js` (write protection). |

Under the architectural reset, both `extract_via_ocr.js` and `extract_via_vision.js` get **lifted as-is** into new extractor modules (`lib/extractors/image-ocr-via-docintel.js` and `lib/extractors/image-vision-llm.js`). The Phase A authoring flow learns to declare `extraction.<key>.type: "image_ocr"` or `"image_vision"` hints so the right path fires for image rate cards.

---

## Disposition: LIFT VERBATIM (move into new modules as-is)

These are working utilities that the architectural reset should re-use rather than rewrite. Their interface contracts are stable and their behavior is well-tested.

| Source | LOC | Lifted into | Why keep |
|---|---:|---|---|
| `scripts/utils/parse-tenure.js` | 242 | `lib/extractors/_helpers/parse-tenure.js` (re-exported) | 40+ tenure patterns; standard_indian preset; brittle on mixed-units but >90% accurate on top clusters. **One known fix needed** — `tenure_cap_days` from `template.extract` must override the silent 3650-day clip for 15-yr tenures. |
| `scripts/utils/slugify.js` | 28 | unchanged | The canonical slug utility per [[project_slug_consistency]]. Never re-derive — always call this. |
| `scripts/utils/normalise-currency.js` | 54 | unchanged | FCNR/GIFT currency code normalization (USD/GBP/EUR/JPY/CAD/AUD). |
| `scripts/utils/normalize-rates.js` | 147 | unchanged | Rate-percent normalization (strips `%`, decimal vs comma, etc.). |
| `lib/rate-bounds.js` | 106 | unchanged | Sane-bounds rejection (0.1-15% INR, 0-12% FCNR, etc.). Phase D quality-gate uses the same thresholds. |
| `lib/safe-write.js` | 173 | unchanged | ADR-012 atomic-write discipline. **Critical** — never bypass; `bin/approve-accept.js` (Phase D2) must also use it for the signed-accepts file. |
| `lib/slug-aliases.js` + `lib/slug-guard.js` | 29 + 208 | unchanged | Bank-code aliasing for legacy spellings; needed for quality-gate parity comparisons. |
| `lib/cost-tracker.js` | 167 | unchanged | LLM cost telemetry — feeds Phase D manifest's `llm_usages` field. |
| `lib/domain-cache.js` | 176 | unchanged | bank-domains.json read/write helper; Phase A schema extension (the `template` block) lands on top of this. |
| `lib/extraction-methods.js` | 102 | unchanged | ADR-012 method enum + curated-method set. The Phase D approve-accept CLI extends `CURATED_EXTRACTION_METHODS` with `manual_signed` for operator-curated rate files. |
| `lib/failure-classifier.js` | 249 | `lib/extractors/_helpers/failure-classifier.js` | Two-tier phase_outcomes taxonomy (website / rate-page / extraction outcomes). **Becomes the Phase D manifest's failure_class field directly** — no re-design needed. |
| `lib/storage.js` | 296 | unchanged | Blob storage abstraction for cloud runs. Sprint 005 is local-first so this is unused but kept. |
| `lib/actions/extract_via_ocr.js` | 527 | `lib/extractors/image-ocr-via-docintel.js` (thin wrapper) | The Azure Document Intelligence path. Wrap it as an extractor module so the Phase C dispatcher can pick it via `template.extract.extractor = "image-ocr-via-docintel"`. |
| `lib/actions/extract_via_vision.js` | 194 | `lib/extractors/image-vision-llm.js` (thin wrapper) | Vision-LLM path. Same wrapping treatment. |
| `lib/actions/_cheerio_tables.js` | 430 | `lib/extractors/_helpers/cheerio-table-picker.js` | **The multi-table scoring heuristic** — exactly what `_generic-html-3col.js` needs. Picks the rate table from a page that has 3-8 tables. Scoring rules already balanced for Indian bank pages. |
| `lib/actions/_cheerio_section_context.js` | 371 | `lib/extractors/_helpers/cheerio-section-context.js` | Section-heading propagation (HDFC's "Senior Citizens" sub-section interpretation). Needed by `hdfc-section-context-tabs.js` extractor. |
| `lib/actions/_cheerio_heading_range.js` | 79 | `lib/extractors/_helpers/cheerio-heading-range.js` | Heading-bounded sub-DOM extraction. Companion to `_cheerio_section_context.js`. |
| `scripts/utils/parse-pdf-rate-lines.js` | 211 | `lib/extractors/_helpers/parse-pdf-rate-lines.js` | Legacy 3-column regex AND the M2.3 hint-aware multi-column parser. Both needed: simple PDF cluster uses the legacy path, Axis-class PDFs use hint-aware. |
| `scripts/extract_rates_pdf.mjs` | (lookup) | unchanged | pdfjs-dist text extraction subprocess. `lib/fetch/fetch_pdf.js` spawns it. |
| `scripts/utils/validate-rates.js` | 297 | unchanged | Per-slab invariant checks (rate bounds, tenure continuity, senior ≥ general). Phase D quality-gate already uses these. |
| `scripts/utils/validation-constants.js` | 112 | unchanged | Threshold constants. |
| `lib/azure-openai-client.js` + `lib/azure-openai-responses.js` | (lookup) | unchanged | Azure OpenAI client wrappers — used by `_llm-fallback.js` Phase C extractor. |
| `lib/actions/_playwright_session.js` | 161 | `lib/fetch/_playwright_session.js` | Playwright launch/close helper with stealth toggle. Lifted into the new `lib/fetch/` module. |
| `lib/actions/_http.js` | 187 | `lib/fetch/_http.js` | Plain-HTTP fallback fetcher. |
| `lib/run-aggregator.js` + `lib/run-report-renderer.js` | 216 + 146 | unchanged | Run-level reporting. Phase D `_manifest_summary.json` extends these. |
| `scripts/utils/logger.js` | 130 | unchanged | Structured logger — every new module uses it. |
| `scripts/quality-gate.js` | (lookup) | extended | The deterministic comparator survives; **add signature verification on `pack/quality-gate-accepts.json`** (Phase D2). |
| `scripts/compare-pack.js` | (lookup) | unchanged | totalsByBank diff used by quality-gate. |
| `lib/registry-skip.js` | 183 | unchanged | Synthetic config writer for terminal banks (no_website_known / pending_vision / etc.). |

## Disposition: LIFT WITH FIXES (move and modify)

| Source | LOC | Lifted into | Required fixes |
|---|---:|---|---|
| `lib/actions/extract_html_table.js` | **1870** | Split: deterministic → `lib/extractors/_generic-html-3col.js`; LLM-fallback path → `lib/extractors/_llm-fallback.js` | Today this single file does both deterministic cheerio extraction AND the silent LLM fallback. The split is the load-bearing change of the architectural reset: deterministic and LLM live in different files, the dispatcher picks one explicitly, and the manifest records which fired. **Preserve the anti-fabrication source-row-text contract** verbatim into both modules. |
| `lib/actions/extract_pdf_table.js` | 373 | `lib/extractors/_pdf-generic.js` (deterministic core) + `lib/extractors/psb-pdf-rate-card-3col.js` + `lib/extractors/axis-multi-column-with-sub-headers.js` | Today this is one monolithic path that handles both simple 3-column PDFs and Axis-style multi-column via the M2.3 hint. The new model: a per-template extractor declares its `column_map`, and the helper functions parse accordingly. M2.3 hint annotation in `bank-domains.json` is migrated into `template.extract.column_map`. |
| `lib/orchestrator.js` | 671 | `run-discovery.js` becomes the single dispatch path; `dispatch.js` lives in `lib/extractors/` | The two-path orchestrator (deterministic state machine vs LLM chat) collapses to one path. Action contracts (find_website, find_rate_page, fetch, extract) remain but funnel through `lib/extractors/dispatch.js`. |
| `lib/tier-router.js` | 348 | `lib/dispatch/skip-gate.js` (retained) + delete tier-1/tier-2 model routing | Skip-gate logic (terminal discovery_status, curated extraction methods) is still needed — keeps the registry contract. Tier-1-vs-tier-2 model routing goes away because under the reset, runtime LLM use is fallback-only and uses the full model. |
| `lib/tools.js` | 785 | Trim to extractor-needed tools only | This is the agent's tool-definition manifest for the LLM chat path. Most of it (find_website, find_rate_page tools) goes away with the chat path. Keep the `run_playwright` and `extract_html_via_llm` tool-callable wrappers since `_llm-fallback.js` and `scripts/author-template.js` use them. |
| `scripts/fetch_rates_playwright.js` | (lookup) | `lib/fetch/fetch_html.js` (full rewrite per Phase B1) | Replace with the retry-escalation wrapper. The existing CLI options (`--stealth`, `--tabs`, `--accordions`, `--wait-for-selector`, `--click-to-reveal`, `--extract-selector`) all become fields under `template.fetch`. |
| `scripts/utils/parse-tenure.js` | 242 | (also listed under LIFT VERBATIM) | One fix: honor `tenure_cap_days` from template instead of the silent 3650-day clip. |

## Disposition: REPLACE (delete and write fresh)

| Source | LOC | Why replace |
|---|---:|---|
| `lib/agent.js` | (lookup) | The LLM chat loop driving `prompts/discover.md` at runtime. This is the silent-fallback risk surface — the chat loop can make arbitrary tool calls and the only visibility is the cost-tracker. Under the reset, runtime extraction is template-dispatched and LLM use is confined to `_llm-fallback.js` (per-bank, observable). Kept as a stub for one sprint per the plan, then deleted. |
| `prompts/discover.md` | (lookup) | The agent's discovery prompt. Replaced by `lib/prompts/author-template.md` which is invoked only by `scripts/author-template.js` (interactive operator tool), not at runtime. |
| `lib/extraction-hint.js` | 136 | The M2.3 per-bank hint resolver. Subsumed by `template.extract.column_map` (declared once per template, applies to all member banks). One-shot migration script downgrades existing hints to column_maps, then delete this file. |
| `lib/prompts/build-prompt.js` + `lib/prompts/fragments.js` | 56 + 343 | Companion to `lib/agent.js`. The chat-loop prompt assembly goes away with the chat loop. A much smaller `lib/prompts/author-template.md` replaces. |

## Disposition: KEEP AS-IS (orthogonal, no architectural change)

| Source | LOC | Why keep |
|---|---:|---|
| `scripts/seed-domains.js`, `scripts/sync-domains.js`, `scripts/guess-bank-in.js` | (lookup) | Bank discovery from RBI master list. Orthogonal to extraction. |
| `scripts/run-domain-discovery.js` | (lookup) | The Azure OpenAI Responses-API domain discovery path — different concern from rate extraction. |
| `scripts/azops/*` | (lookup) | Cloud orchestration (Azure Container Apps job dispatch). Sprint 005 is local-first; cloud is out of scope. |
| `scripts/utils/load-cohort.js`, `scripts/build-cohort*.js` | 93 + (lookup) | Cohort definition loading. Orthogonal. |
| `scripts/utils/parse-csv.js`, `scripts/utils/config-defaults.js` | 107 + 90 | Generic helpers. |
| `scripts/refresh/*` | (lookup) | Re-extraction loop with cached body + sanity gate. Sprint 005 doesn't touch this; will be revisited in Sprint 006 if needed. |
| `scripts/heal_rates_schema.js`, `scripts/reconcile-runs.js` | (lookup) | Operational tools used between sprints; not part of the runtime pipeline. |
| `scripts/utils/trace-parser.js`, `scripts/utils/extract-bank-fragment.js` | 392 + 62 | Diagnostic tools — useful in Sprint 005 work itself for parsing the per-bank manifest. |

## Disposition: TEST FIXTURES TO HARVEST (Phase 0.4 input)

| Source | Use |
|---|---|
| `tmp/baseline-pre-reset/output-latest/<bank>_rates.json` × 633 | Golden `expected.json` files for the top-50 banks by slab count. |
| `tmp/baseline-pre-reset/output-latest/<bank>_config.json` × 513 | Reference configs; the new `template` block is added on top. |
| `tmp/baseline-pre-reset/quality-report.json` 33 regressions | Each regression-list bank gets a captured-HTML fixture under `tests/golden-html/regression-cases/`. The Phase C extractor for that template MUST produce the pre-regression slab values against this fixture. |

## Cross-cutting notes

1. **Anti-fabrication is the load-bearing contract.** It currently lives implicitly inside `extract_html_table.js` (every emitted slab carries `source_row_text` lifted from the actual DOM `<tr>` textContent). When that file splits in Phase C, the contract gets pulled into `lib/extractors/_assert_traceability.js` as a hard assertion shared across every extractor. **Failing the assertion must throw, not warn** — silent drops are how this got broken in the first place.

2. **The `_cheerio_tables.js` table-picker scoring heuristic is the most reusable single piece of logic in the codebase.** It picks the rate table out of 3-8 candidate tables using bounded scoring. Lift it as-is into `_helpers/cheerio-table-picker.js` and call it from every HTML-based extractor.

3. **The `failure-classifier.js` two-tier taxonomy is the manifest's failure_class field already.** Don't re-design — re-use its `WEBSITE_OUTCOMES`, `RATE_PAGE_OUTCOMES`, `EXTRACTION_OUTCOMES` enums verbatim.

4. **The 1,870-LOC `extract_html_table.js` is the single biggest refactor target.** It carries the anti-fabrication contract, the multi-table picker integration, the cheerio extraction, the LLM fallback, and the schema enforcement. The split is non-trivial — the design doc for `lib/extractors/_generic-html-3col.js` should walk through which lines move where, line-by-line, before any code lands.

5. **Skip-gate logic in `lib/tier-router.js` is mandatory infrastructure** under the reset — without it, the dispatcher would re-run discovery on every bank every cycle, defeating the registry-skip optimization. The tier-1/tier-2 model routing is the only part that goes away; the skip-gate stays.

## Open follow-ups

- Phase A design doc must specify the exact line-by-line split of `extract_html_table.js` before any code touches it (1870 LOC is too big for an ad-hoc split).
- The `extract_via_vision.js` vs `extract_via_ocr.js` distinction needs to be documented in the Phase C extractor-registry README — they look similar but use different Azure services and have different cost profiles.
- Cloud-side migration (`scripts/azops/`) is explicitly out of scope for Sprint 005 but must be revisited in Sprint 006 — the per-bank manifest schema needs to be cloud-blob-compatible.
