# Item 18 — Variant coverage guarantee (Track A / A1)

Date: 2026-07-06
Status: implemented (working tree, not committed)

## Root cause

Two compounding defects in the orchestrator path — neither is the "LLM stops
after first PDF" behaviour the scope doc assumed (that control loop was
retired in Sprint 010 A1).

**RC1 (primary) — bank_type collapses to UNKNOWN, product list collapses to `['fd']`.**
`node run-discovery.js "Axis Bank Limited" --rates-only` without `--category`
runs the Sprint 010 A2 derivation, which reads
`data/bank-domains.json[<slug>].category`. **Zero of 1,037 registry entries
carry `category`** (verified 2026-07-06), so the derivation never fires;
`bankType = null` reaches `orchestrate()`, whose own defensive fallback reads
the same missing field and lands on `'UNKNOWN'`
(lib/orchestrator.js, Sprint 010 A2 block). `shouldQueryNri('UNKNOWN')` is
false → `productsForBank()` returns `['fd']` → NRE/NRO/FCNR are never
attempted, even though `rate_pages.fd_nre/fd_nro/fd_fcnr` sit curated in the
registry.

Evidence: `output/runs/2026-06-15T1114_axis-bank-limited/axis-bank-limited.summary.json`
shows `"category": null` and tool_calls containing exactly one product
sequence (`find_rate_page:fd` → `extract_pdf_table:fd` →
`commit_rates:regular@pages[1,2,3]`); no `find_rate_page:fd_nre/nro/fcnr`
events at all. Same picture in the 1112/1113 (`--rates-only`) runs.

**RC2 (latent) — CLI mode strings leak into actions that reject them.**
`orchestrate()` computed `effectiveMode = cachedPath ? 'recheck' : mode` and
passed `mode` verbatim. `run-discovery.js` passes `"rates-only"` /
`"expand-nri"`, but `lib/actions/find_rate_page.js:102` and
`lib/actions/classify_rate_page.js:52` validate against
`VALID_MODES = {discover, recheck}` and **throw**. `runStep` converts the
throw into a failed phase event → the product dies as `rate_page_not_found`.
Didn't bite Axis (every product had a cached path → recheck), but kills any
product without a cached path on every `--rates-only`/`--expand-nri` run.

## What changed

### lib/orchestrator.js
1. **Product union** (fixes RC1 at the orchestrator level): the Phase 3
   product list is now `productsForBank(bank_type)` ∪ registry-configured
   products (`configuredProductsFromHints()` — truthy `rate_pages.<product>`
   or an `extraction.<key>.fulfills_product` naming the product). IBUs stay
   `fd_gift`-only; non-IBU banks never pick up `fd_gift`.
2. **Mode normalisation** (fixes RC2): `actionMode = mode === 'recheck' ?
   'recheck' : 'discover'` computed once; both `effectiveMode` sites use it.
3. **Phase 3.5 coverage loop** (belt-and-braces): after the product loop,
   any expected variant that did not commit ≥1 slab and whose resolved URL is
   PDF/image gets a direct deterministic extraction
   (`extractViaOcr` for `image_ocr` hints / image extensions,
   `extractPdfTable` otherwise — mirrors
   `scripts/recovery/axis-fcnr-direct-2026-06-15.js`) committed through the
   same safe-write-protected `commitRates`. Guards: skips variants
   `deferred_to_pending` (curated targets), skips URLs the main loop already
   ran with the same engine yielding 0 slabs (deterministic → same output),
   never overwrites a variant the main loop landed. Emits
   `[variant-coverage]` log lines; recovered variants get
   `variantSummary[v] = { status: 'committed_via_coverage_loop', slabs, extractor }`.
4. **`input.only_products` allowlist** for targeted refreshes (used by
   `--variant`). Bookkeeping added: `committedVariants` set +
   `mainLoopExtractions` map; `bankEntryForHint` hoisted out of the loop
   (loop-invariant). New helpers `countExtractionSlabs()`,
   `resolveCoverageTarget()`; both exported with `_` prefix for tests.

### run-discovery.js
1. **`--variant <regular|nre|nro|fcnr|gift>`** flag → validated early, mapped
   via `VARIANT_TO_PRODUCT`, plumbed as `only_products` into `orchestrate()`;
   drift-gate `expectedVariants` narrowed to the one variant; help text and
   run header updated.
2. **bank_type fallback from existing config** (fixes RC1 at the CLI level):
   when neither `--category` nor the registry yields a category, read
   `output/latest/<bank_code>_config.json` (`category`, else `bank_type`) —
   the file `--rates-only`/`--expand-nri` already require to exist. Axis's
   config carries `bank_type: "PVB"`.

## Files touched
- `lib/orchestrator.js`
- `run-discovery.js`
- `tests/lib/orchestrator-variant-coverage.test.js` (new)
- `sdlc/sprints/sprint-011/implementation/item-18-variant-coverage.md` (this note)

Not touched (concurrent ownership): `lib/actions/extract_via_ocr.js`,
`lib/safe-write.js`. The item-19 `regulatory_constraints` forwarding that
landed concurrently in `buildRatesPayload` is preserved and threaded through
the coverage loop's payloads too.

## Test evidence

New: `tests/lib/orchestrator-variant-coverage.test.js` — 8 tests, all via the
`input.actions` DI seam, temp dirs only, no network/Azure:
1. UNKNOWN bank_type + configured rate_pages → all 4 products attempted (RC1 regression).
2. `mode="rates-only"` without cached paths → actions receive `discover`;
   mocks replicate the real VALID_MODES throw (RC2 regression).
3. (a) coverage loop recovers `fcnr` after a missed commit (PDF path) —
   `committed_via_coverage_loop`, `[variant-coverage] recovered` logged.
4. (a) OCR-hinted Axis shape (`fd_image_ocr_fcnr`) recovers via
   `extractViaOcr`; `ocr_pages` accounted for both passes.
5. (b) shared-URL HTML bank fully covered → coverage loop no-op (4 HTML
   extracts, 0 PDF/OCR, exactly 4 commits).
6. (b2) zero-slab URL already tried by the main loop → coverage loop skips
   the duplicate deterministic attempt.
7. (c) `only_products: ['fd_fcnr']` runs exactly one product.
8. (d) two identical runs through the REAL `commitRates`/safe-write into a
   temp output dir → stable file, no slab duplication, no ghost files.

Results: 8/8 new tests pass; full suite `npm test` — see run log
(pass counts recorded in the PR/handoff message; suite green at
implementation time).

## Not verified
- No live re-run against axis-bank-limited (network + Azure DI cost); the
  2026-06-15 failure is reproduced by the mocked RC1/RC2 regressions instead.
- HDFC/ICICI/SBI live regressions (scope-doc test plan items 1–2) remain an
  operator smoke once this lands.
