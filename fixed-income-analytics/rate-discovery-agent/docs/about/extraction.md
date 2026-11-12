# Extraction

**Read [overview.md](overview.md) first** if you haven't — this page assumes you know the pipeline shape, the `bank_code`/slug rule, and safe-write. This page goes one level deeper into the middle of the pipeline: turning a *classified, fetched* page into validated rate slabs.

> **Framing:** extraction is `(classified page + family extractor) → rate slabs → validate → commit to per-bank JSON`. The classification and fetch stage (finding the right URL, deciding `html_static` / `html_js` / `pdf` / `image`) is covered in `crawling.md` (sibling doc — not yet written; see `docs/agent/discovery-workflow.md` for the interactive-agent version of that step today). This page starts where that stage hands off: a URL + a `kind` + (usually) a cached page body.

A **slab** is the atomic output unit: **one bank · one variant · one currency · one tenure band**. Everything downstream (pack build, quality gate, PM UI) counts slabs.

---

## 1. The rate slab & config schemas

**Authoritative source: [`docs/agent/schemas.md`](../agent/schemas.md).** `lib/prompts/fragments.js` reads that file's anchored sections directly — it is the single copy, not a spec that this page restates in full. Below is only the shape you'll touch constantly while reading extractor code.

### Rate file (`<bank_code>_rates.json`, and the four variant files)

```json
{
  "bank_code": "state-bank-of-india",
  "product_type": "FD",
  "variant": "regular",
  "effective_date": "2026-03-01",
  "source_url": "https://...",
  "scraped_at": "<ISO-8601 UTC>",
  "extraction_confidence": "high",
  "rate_slabs": [
    {
      "tenure_text": "7 days to 45 days",
      "tenure_min_days": 7,
      "tenure_max_days": 45,
      "rate_general_pct": 3.50,
      "rate_senior_pct": 4.00,
      "rate_super_senior_pct": null,
      "deposit_range": "below_3cr"
    }
  ],
  "special_schemes": [],
  "warnings": [],
  "errors": []
}
```

Field names are **strict** — downstream silently drops anything misnamed. The ones you'll see referenced constantly in extractor code:

| Field | Notes |
|---|---|
| `tenure_text` | Verbatim (or near-verbatim) label from the source, e.g. `"1 year to less than 2 years"`. Kept even when parsing fails. |
| `tenure_min_days` / `tenure_max_days` | Parsed day-bounds from `tenure_text` (see `scripts/utils/parse-tenure.js`, §5). `null` when unparseable — the slab still ships (e.g. named special schemes). |
| `rate_general_pct` | Number, not string (`6.50`, never `"6.50%"`). |
| `rate_senior_pct` / `rate_super_senior_pct` | `null` when the bank doesn't offer that tier. Always `null` for FCNR/GIFT (no senior premium on foreign-currency deposits). |
| `currency` | **Required** on FCNR/GIFT slabs (e.g. `"USD"`, `"GBP"`); **absent** on regular/NRE/NRO (see §7). |
| `deposit_range` | `below_3cr` (default) / `3cr_to_5cr` / `5cr_to_25cr` / `25cr_to_100cr` / `above_100cr`; co-ops use `below_15l` / `15l_to_1cr` / `1cr_to_10cr` / `above_10cr`. |

`variant` is one of `regular` / `nre` / `nro` / `fcnr` / `gift` and must match the file suffix (`_nre_rates.json`, etc. — bare `_rates.json` is `regular`).

**The empty-output contract (non-negotiable, per `CLAUDE.md`):** if nothing readable was found, still write the file — `rate_slabs: []`, `extraction_confidence: "none"`, and a `warnings` entry explaining why. Never fabricate a slab to fill a gap. Every extractor and action in this codebase returns `null`/`{ok:false}` on failure rather than inventing data; the *caller* is responsible for turning that into the honest empty-file write.

### Config file (`<bank_code>_config.json`)

Carries `bank_code`, `bank_name`, `bank_type` (see the classification table below), `website`, `scraper_type`, `rate_page_urls` (one URL per product/variant — savings/RD/current-account rates live here as URLs, never as their own rate files), `column_mapping`, and `discovery_metadata`. Full field list and defaults: `docs/agent/schemas.md` § Config File Schema.

**`bank_type` → family** (RBI category → code; also drives which extractor family applies — see §4):

| Category | `bank_type` |
|---|---|
| Public Sector Bank | `PSB` |
| Private Sector Bank (Indian) | `PVB` |
| Small Finance Bank | `SFB` |
| Foreign Bank | `FB` |
| Scheduled/Non-Scheduled Urban Co-op, State Co-op, DCCB, RRB | `SUCB`/`NSUCB`/`SSCB`/`NSSCB`/`DCCB`/`RRB` |
| IFSC Banking Unit (GIFT City) | `IBU` |
| (Payments Bank / Local Area Bank / Financial Institution / Housing Finance Co.) | `PB`/`LAB`/`FI`/`HFC` |

---

## 2. Where extraction fits

```
crawling (classify + fetch) ──► kind: html_static | html_js | pdf | image
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    │      lib/actions/extract_*.js              │  ← generic, kind-driven actions
                    │  (HTML table / PDF table / vision / OCR)   │     (used by the interactive agent
                    └─────────────────────┬─────────────────────┘      and the orchestrator directly)
                                          │  OR, in the deterministic
                                          │  orchestrator path:
                    ┌─────────────────────┴─────────────────────┐
                    │        lib/extractors/dispatch.js           │  ← bank_type/template_id-driven
                    │   (routes to a family-specific extractor)   │     routing (§4)
                    └─────────────────────┬─────────────────────┘
                                          │
                                     rate slabs
                                          │
                          post-processing (dedup, currency tag,
                          non-FD filter, malformed-slab filter)
                                          │
                    scripts/utils/validate-rates.js  (bounds check)
                                          │
                    lib/actions/commit_rates.js / commit_config.js
                              (filter invalid slabs → safe-write)
                                          │
                    output/latest/<bank_code>_{,nre_,nro_,fcnr_,gift_}rates.json
```

There are **two parallel routing layers** in this codebase, and it's easy to conflate them:

- **`lib/actions/extract_html_table.js` / `extract_pdf_table.js` / `extract_via_vision.js` / `extract_via_ocr.js`** — the generic, *kind*-driven extraction actions (§3). These are what the interactive Claude-Code agent and the orchestrator call directly; they contain their own internal deterministic-parser + LLM-fallback logic and don't care about bank family.
- **`lib/extractors/` + `dispatch.js`** — a newer, *template/bank-type*-driven registry (§4) that routes to a small family-specific module (e.g. co-op 3-column, PSB PDF). Several of these modules internally delegate back into `_generic-html-3col.js` or reuse helpers shared with the actions above (`currency-matrix.js`, `docintel-grid.js`). Think of `lib/extractors/` as a thinner, more targeted layer sitting in front of (or beside) the actions in §3 for banks that have an authored `template_id`.

---

## 3. Extraction paths (`lib/actions/`)

### `extract_html_table.js` — the main HTML path

Layered priority order, all inside one action:

1. **Deterministic (cheerio)** — `extractScoredTables` picks and scores every `<table>` on the page, `extractSlabsFromTable` maps columns (via `config.column_mapping`, default `{0: tenure_text, 1: rate_general_pct, 2: rate_senior_pct}`). Multi-table pages get one page-entry per rate-bearing table, each tagged with a `deposit_range` (from the nearest heading) and a set of `fulfills_variants` inferred from section headings. No LLM cost.
2. **LLM fallback (`extractViaLlmFromHtml`)** — fires when the deterministic pass returns 0 slabs, or `hints.prefer_llm`, or the picker itself signaled ambiguity (`multi_table` warning, too-few-slabs vs. `expected_slab_count`, or a multi-currency FCNR/GIFT page that cheerio structurally can't unpivot).
3. **Text-pattern fallback** — last resort scan of visible page text for `(tenure, rate%)` sequences; covers React/SPA pages with zero `<table>` elements or cell-mashed markup.
4. Returns `null` when everything fails — per `CLAUDE.md`, the caller then writes the empty-slab file.

**Per-chunk LLM extraction (`extractViaLlmFromHtml`).** Rather than sending the whole page body to the model, the HTML is split into per-`<table>` chunks (`extractTableChunks`, capped at 30k chars each, top 6 by score) and each chunk gets its own concurrent LLM call. This closed a silent-truncation class that used to hallucinate output on large consolidated pages. Two defenses ride along:
- **Traceability check** — every emitted slab's source text must appear verbatim in its own chunk; slabs that don't trace back are dropped (anti-fabrication, not just anti-noise).
- **Currency-aware chunk selection** for FCNR/GIFT (`filterChunksForCurrencyVariant`) — on consolidated all-variant pages the generic top-6-by-score cap used to feed the LLM the dominant INR tables and starve the actual currency matrix; chunks are now ranked by distinct currency-token count first.

### `extract_pdf_table.js` — PDF rate cards

Downloads the PDF (browser UA, WAF-tolerant), spawns `scripts/extract_rates_pdf.mjs` (pdfjs-dist based), and groups the result into `pages: [{page_number, variant, slabs, ...}]` — PDFs frequently bundle multiple variants across pages (a "Domestic Rates" PDF, or a combined NRI PDF with NRE/NRO/FCNR sections). Returns a **typed failure envelope** (`{ok:false, failure_class:"fetch", http_status}`) when the *download* fails (so a hinted, rolled dated-PDF URL can be retried un-hinted) versus plain `null` when the PDF downloaded fine but parsed to zero slabs (a parse failure must not look fetch-failed, or the orchestrator would re-extract for no new information).

### `extract_via_vision.js` — image-only rate cards

For scanned/image rate cards. Sends the image URL straight to a vision-capable Azure OpenAI deployment (`AZURE_OPENAI_VISION_DEPLOYMENT`, falling back to the FULL deployment — **never MINI**, which has no image input) with a short schema-explicit JSON prompt. Emits `extraction_method: "vision_model"` (note: not `"automatic_vision"` — an intentional naming quirk from the original contract). Fires when `classify_rate_page` marks the page/PDF as image-based.

### `extract_via_ocr.js` — Azure Document Intelligence fallback

For image/scanned-PDF cases where vision-model JSON extraction isn't reliable enough, or as a structured alternative: calls DI's `prebuilt-layout` model and walks the returned table cells into slabs (`cellsToGrid` → `classifyColumns`/`detectCurrencyColumnsLayout`/`detectCurrencyKeyedTable` → `tableToSlabs`). This is also where **per-table variant classification** and **effective-date capture** live (Sprint 011 additions) — see §6 for why per-table classification matters.

**When each path fires, in one line:** HTML page → `extract_html_table`; PDF (text-extractable) → `extract_pdf_table`; image or scanned PDF → `extract_via_vision` first, `extract_via_ocr` as the structured fallback. The upstream `classify_rate_page` step (crawling stage) sets the `kind` that drives this choice.

---

## 4. Family extractors (`lib/extractors/`)

`lib/extractors/dispatch.js#pickExtractor` resolves a bank's `template_id` (from `bank-domains.json`) to a concrete extractor module. When no `template_id` is set, it falls back through a chain: `_generic-html-3col` (for `html_static`/`html_js`) → `_llm-fallback` (last resort, any kind) — and flags `needs_template_authoring: true` so the operator knows this bank hasn't had a template written for it yet (via `scripts/author-template.js`).

| Family module | `template_id` | Targets | Approach |
|---|---|---|---|
| `coop-bankin-3col-tenure-general-senior.js` | `coop-bankin-3col-tenure-general-senior` | `DCCB`/`SUCB`/`NSUCB`/`SSCB`/`RRB` on `.bank.in` domains | Highest-leverage cluster (103 banks) — cheerio table scoring + 3-column (tenure/general/senior, optional super-senior) mapping. |
| `psb-pdf-rate-card-3col.js` | `psb-pdf-rate-card-3col` | `PSB` | PDF text path via `parseRateLines`, or DocIntel grid path for matrix-shaped cards; anti-fabrication traceability check on every slab. |
| `pvb-multi-variant.js` | `pvb-multi-variant` | `PVB` (HDFC, ICICI, Axis, Kotak, IndusInd, YES, Federal, RBL, IDFC First, Bandhan) | Delegates `regular`/`nre`/`nro` to `_generic-html-3col`; routes `fcnr`/`gift` to the shared currency-matrix helper (`_helpers/currency-matrix.js`). |
| `fb-multi-variant.js` | `fb-multi-variant` | `FB` (non-WAF foreign banks — DBS, Citi, SBM, Emirates NBD, MUFG, StanChart, HSBC India) | Same split as PVB: generic 3-col for INR variants, currency-matrix for FCNR/GIFT. WAF-blocked FBs (Amex, Barclays, Nova Scotia, Fino) are out of scope — manual curation via `bin/approve-accept.js`. |
| `ibu-static-pdf-quarterly.js` | `ibu-static-pdf-quarterly` | `IBU` (GIFT City) | Quarterly PDF rate cards, foreign-currency only. DocIntel grid path takes precedence for currency×tenure matrices (the deterministic line parser can't unpivot them); falls back to text-line parsing for single-currency PDFs. |
| `_generic-html-3col.js` | `_generic-html-3col` | Fallback for any `html_static`/`html_js` bank with no template | Same shape as the co-op extractor but without the `.bank.in`/bank-type filter — looser thresholds, broader applicability. |
| `_llm-fallback.js` | `_llm-fallback` | Last resort, any HTML kind | Lifts the chunked-LLM scaffolding from `extract_html_table.js` (`buildHtmlExtractionPrompt`, `callLlmOnChunk`, `validateSlabAgainstChunk`, `dedupSlabs`) rather than duplicating it — "lift without moving." |

All family extractors return the same shape: `{ slabs, effective_date, warnings, diagnostics }`. Most run `assertTraceability()` (`lib/extractors/_helpers/_assert_traceability.js`) before returning — the same anti-fabrication defense as the chunked LLM path in §3, applied to deterministic PDF-line parsing too (a regex mis-mapping a cell into a slab is still fabrication if it doesn't trace to real text).

---

## 5. Post-extraction validation & normalization

### Tenure parsing (`scripts/utils/parse-tenure.js`)

Converts `tenure_text` into `{minDays, maxDays}`. Recognizes a table of common Indian-banking tenure presets (`"7 days to 14 days"`, `"1 year to less than 2 years"`, etc.) plus a general compound-expression parser (`"2 Years 1 Day"` → summed days) using a unit table (`day/week/month/year` + abbreviations). This is a CommonJS port of the canonical `packages/shared/src/constants/tenure-maps.ts` — keep both in sync (see ADR-014, §8).

### Currency normalization (`scripts/utils/normalise-currency.js`)

Maps free-text currency mentions to canonical 3-letter ISO codes so dedup and pack-build treat synonyms as one currency: `EURO → EUR`, `YEN → JPY`, plus tier-suffix stripping (`"USD (Above 5L)" → USD`). Used by both the HTML currency-matrix picker and the OCR grid classifier.

### Variant-specific bounds (`scripts/utils/validation-constants.js`, mirrored by `lib/rate-bounds.js`)

Two bound tables exist at different strictness, by design:

- **`validation-constants.js` (`VARIANT_RATE_RANGES` / `VARIANT_TENURE`)** — the *tight* band `validate-rates.js` uses to emit **warnings** (not necessarily drop). Regular FD: 1.5–9.5%; NRE/NRO: 2.0–9.5%; FCNR/GIFT: 0.5–8.0% (with a `LOW_YIELD_CURRENCIES` override for JPY/CHF down to 0–3.0%, since real Axis JPY FCNR(B) rates print near 0.00–0.01% and the flat floor was collapsing them wholesale).
- **`lib/rate-bounds.js` (`PACK_FILTER_BOUNDS`)** — the *loose* sanity band used to silently **drop** obvious extraction-error slabs at pack-build and extraction time (e.g., a tenure cell like `"15 days to 100 days"` mis-mapped into `rate_general_pct` becoming `15100`). Deliberately wider than the validation band so a legitimate 12% promotional FD ships with a warning instead of vanishing.

**Tenure bounds differ meaningfully by variant** (`VARIANT_TENURE`): NRE is 365–3650 days; **FCNR is 365–1825 days** (RBI's 1-year floor for onshore foreign-currency deposits); **GIFT is 7–1825 days**. The GIFT floor was dropped from 365 to 7 days in a Sprint 011 fix (`sdlc/sprints/sprint-011/BACKLOG.md` item #30, 2026-07-09) — the rationale: **GIFT-City IBU deposits are offshore, IFSCA-regulated instruments, not subject to the RBI's domestic-FCNR 1-year minimum**, so genuine short-tenor (7-day, 1-month) offshore FCY deposits were being wrongly rejected as garbage rows. The fix recovered RBL-IBU from 18 → 63 slabs; `fcnr` deliberately kept its 365-day floor unchanged.

**Lesson for future validation work:** a bound tightened to catch a real error class (garbage tenures, mis-mapped columns) can just as easily discard a legitimate but unusual slab from a *different* product shape. When you see coverage regress after a validation change, check whether the dropped rows are a distinct, legitimately-different variant rather than noise — GIFT-vs-FCNR is the canonical example here.

---

## 6. Design lesson: per-chunk error scoping

`extract_html_table.js`'s `extractViaLlmFromHtml` calls the LLM once per rate-bearing HTML chunk (§3) and merges the per-chunk results. Early on, the merge treated **any** chunk's `errors[]` (the model self-reporting "no rate table here" / "truncated" / "ambiguous dates") as a **global** blocker — one bad chunk poisoned the whole result and discarded every slab, even from other chunks that had extracted correctly.

This surfaced concretely on RBL's GIFT page (`rbl-gift-2026-07-08`): chunk 0 was a fees table that correctly reported "no rates table found"; chunk 1 held 60 valid FCNR-matrix slabs. The old logic let chunk 0's harmless "nothing here" error nuke chunk 1's good output.

**The fix, still in the code today:** `errors[]` is scoped per chunk. An error from a chunk that also produced ≥1 usable (traceability-validated) slab is treated as blocking — those specific slabs are untrustworthy and the whole LLM adoption for that call is skipped in favor of deterministic output. An error from a chunk that yielded **zero** slabs is downgraded to an informational warning, because "nothing extractable here" is not the same claim as "what I extracted is wrong." See the code comment block at `lib/actions/extract_html_table.js` around the `chunkValidSlabs` check for the exact logic.

**The general lesson:** when a pipeline stage batches independent units of work (chunks, pages, tables) and merges their results, a per-unit failure signal must not automatically fail the whole merge — scope the blast radius to the unit that actually produced the bad output.

---

## 7. NRE/NRO vs FCNR/GIFT — currency dimension

- **NRE and NRO are INR-denominated** — same as domestic FD. Slabs carry **no `currency` field**. Rate bounds and tenure bounds are still variant-specific (see §5), but there's no currency dimension to extract or normalize.
- **FCNR and GIFT carry a `currency` field on every slab** (`USD`/`GBP`/`EUR`/`JPY`/`CAD`/`AUD`/...). Their source tables are frequently **matrices** — tenure × currency, or currency × tenure — which is why cheerio's flat column-mapping approach structurally can't read them and both the LLM-fallback and the dedicated `currency-matrix.js` helper exist. No senior/super-senior premium applies to either variant (`NO_SENIOR_VARIANTS` in `validation-constants.js`) — those fields stay `null`.

---

## 8. Pointers

| Doc | Read for |
|---|---|
| [`docs/agent/schemas.md`](../agent/schemas.md) | Authoritative STRICT field names, full config schema, bank_type table, output-file naming/slug rule |
| [`docs/agent/nri-gift-ibu.md`](../agent/nri-gift-ibu.md) | How the interactive agent finds NRE/NRO/FCNR/GIFT pages in the first place (discovery, not extraction) |
| [`sdlc/decisions/ADR-014-shared-validation-package.md`](../../sdlc/decisions/ADR-014-shared-validation-package.md) | Why validation constants exist as a CJS/TS twin pair and how the drift-check test keeps them in sync |
| `quality-checks.md` (sibling — not yet written) | Safe-write rules, the quality gate, confidence scoring, signed accepts — what happens *after* `commit_rates.js`/`commit_config.js` write the file |
| `crawling.md` (sibling — not yet written) | Discovery/classification/fetch — what happens *before* extraction; sets the `kind` this page's paths dispatch on |
| [`agent-design.md`](agent-design.md) | The LLM agent side of this system: prompt fragments, orchestrator, tier-router, the three run modes |
| [`overview.md`](overview.md) | The whole pipeline in one sitting — start here if you haven't |

---

*Written for handover, 2026-07-09. Extraction code moves fast (Sprint 011 alone added GIFT-tenure, per-chunk error scoping, and currency-aware chunk selection) — when in doubt, the code comments in `lib/actions/extract_html_table.js` and `lib/extractors/*.js` carry more recent rationale than any doc, including this one.*
