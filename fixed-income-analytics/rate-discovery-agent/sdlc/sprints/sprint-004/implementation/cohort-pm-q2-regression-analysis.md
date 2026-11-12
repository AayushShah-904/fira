# Cohort 2026-05-23 — full regression analysis: causes & strategy per bucket

> Supersedes `cohort-pm-q2-rerun-triage.md` (which was the inventory).
> Adds: ROOT CAUSE per regression class + FIX STRATEGY per bucket.
> Decision (operator 2026-05-23): **fix-first** — do not ship until engine
> issues addressed. This doc is the engineering roadmap for that fix work.

## Cohort recap

| Metric | Apr 16 (PM floor) | May 14 | New 2026-05-23 | Δ vs Apr 16 |
|---|---:|---:|---:|---:|
| Banks | 261 | 292 | 513 | +252 |
| Banks with any variant | 194 | 222 | 386 | +192 |
| Total slabs | 4,507 | 4,806 | 8,269 | +3,762 (+83%) |
| Banks improved (gains) | — | — | 364 | — |
| Banks regressed | — | — | 48 | — |

48 regressions surfaced. Below, each bucket's findings with **root cause analysis + fix strategy**.

---

## Bucket A — Engine bug, complete or near-complete extraction failure (12 banks)

### Sub-category A1: IBU GIFT extraction collapse (4 banks)

| Bank | Baseline → New |
|---|---:|
| idbi-bank-ibu | 48 → 0 |
| indusind-bank-ibu | 24 → 0 |
| bank-of-india-ibu | 8 → 0 |
| punjab-national-bank-ibu | 10 → 5 |

**Diagnosis** (verified from summary files):
- `find_rate_page:fd_gift` succeeded
- `fetch_page:fd_gift` succeeded
- `extract_html_table:fd_gift` **FAILED** (`is_error: true`) for all four
- All four are classified `html_js` (JS-rendered SPA pages)
- variantSummary: `{"gift": {"status": "extraction_failed", "kind": "html_js"}}`

**Root cause**: IBU GIFT pages are JS-rendered SPAs (e.g., `pnb.bank.in/pnb-giftcity-InterestRate.aspx`) where the orchestrator's `html_js` Playwright path either times out or returns content that the table extractor can't parse. The LLM path previously handled this via its rendered-DOM extraction; the orchestrator's deterministic Cheerio path can't.

**Fix strategy (1 fix, 4 banks)**:
- **Option A (preferred)**: extend the orchestrator's `extract_html_table.js` to honour `kind === "html_js"` by falling back to the LLM-fallback chunked extraction when Cheerio's deterministic path produces 0 slabs. This already exists for non-IBU banks but is not firing on IBU pages — likely because the page-fetch returns content but no `<table>` elements (rates in styled `<div>`s).
- **Option B**: author per-IBU OCR hints — point `extraction.<key>` to an image_ocr URL if the bank publishes a PDF rate card. Smaller scope but only solves IBU-by-IBU.
- **Investigation needed**: 30 min — inspect what content `fetch_page:fd_gift` actually returns for IDBI-IBU and IndusInd-IBU. If the rates are in `<div>` styled tables, this is the same class as the Equitas FD case (already handled by `automatic_text_pattern` fallback in `extract_html_table.js`); the text-pattern path may just not be firing for GIFT variant. Fix would be small.

### Sub-category A2: NRO extraction skipped (3 banks)

| Bank | Variant | Baseline → New |
|---|---|---:|
| bank-of-india | nro | 11 → 0 |
| idfc-first-bank-limited | nro | 13 → 1 |
| idfc-first-bank-limited | nre | 5 → 1 |

**Diagnosis**:
- BoI NRO: `find_rate_page:fd_nro` returned no URL → orchestrator skipped NRO entirely
- IDFC-First NRE/NRO: extraction ran but only captured 1 slab — likely Playwright snapshot truncation or table-selection picked the wrong table

**Root cause**:
- BoI NRO: `find_rate_page` couldn't locate the NRO-specific URL. The registry's `rate_pages.fd_nro` may be null or stale.
- IDFC-First: per `output/latest/idfc-first-bank-limited_nro_rates.json`, the new file has 1 slab with non-canonical tenure text. Likely the NRE/NRO page is JS-rendered and the Cheerio path is grabbing a "1 year only" preview cell.

**Fix strategy**:
- BoI NRO: registry hint — check `bankofindia.bank.in/interest-rates-on-deposit` for NRO section; add to `rate_pages.fd_nro` if separate URL exists.
- IDFC-First: author Orch-2 HTML hint similar to HDFC. The combined NRI page likely has all variants together.

### Sub-category A3: Source page fetch / page-not-found (3 banks)

| Bank | Baseline → New |
|---|---:|
| chennai-central-co-operative-bank-ltd | 11 → 0 |
| tamil-nadu-grama-bank | 10 → 0 |
| nabard | 5 → 0 |

**Diagnosis**: `fetch_page:fd` failed or returned a page with no rate data. Likely sources have changed structure since the May 14 run.

**Root cause**: Bank-side URL/structure change OR Playwright timeout. Per-bank investigation needed.

**Fix strategy**: per-bank registry refresh (check source URL, update `rate_pages.fd` if changed). Each takes ~5 min.

### Sub-category A4: Partial extraction (2 banks)

| Bank | Baseline → New |
|---|---:|
| barclays-bank-plc | 26 → 5 |
| bhatinda-central-co-operative-bank-ltd | 12 → 1 |

**Diagnosis**: Engine fetched page successfully but extracted only a fraction of the actual content. Likely table-selection chose wrong table OR table layout changed.

**Root cause**: same class as Bucket B (wrong-table selection — see below).

**Fix strategy**: covered by the Bucket B systemic fix.

### Sub-category A5: Bucket-D engine fails (2 banks moved here)

| Bank | Baseline → New |
|---|---:|
| bangalore-district-and-bangalore-rural-district-co-op-central-bank-ltd | 6 → 0 |
| societe-generale | 6 → 0 |

**Diagnosis**: in cohort, but `fetch_page:fd` errored (bangalore) OR extraction returned 0 from fetched page (societe).

**Fix strategy**: per-bank investigation (URL update or registry adjustment).

---

## Bucket B — FCNR moderate drops; SYSTEMIC ENGINE BUG (12 banks)

### Root cause analysis (the big finding)

**Inspection of 8 affected `_fcnr_rates.json` files reveals a consistent pattern**: the engine selected the WRONG table for FCNR variant, then defaulted-tagged everything to USD:

| Bank | Slabs in file | currencies in file | first tenure_text |
|---|---:|---|---|
| canara-bank | 14 | `{USD: 14}` | "7 Days to 14 Days" |
| punjab-national-bank | 21 | `{USD: 21}` | "7 days to 14 days" |
| city-union-bank-limited | 16 | `{USD: 16}` | "7 days to 14 days" |
| dhanlaxmi-bank-limited | 12 | `{USD: 12}` | "7 Days to 14 Days" |
| punjab-sind-bank | 7 | `{USD: 7}` | "Up to 1.00 Crore" (deposit-range table!) |
| idbi-bank-limited | 17 | `{USD: 17}` | "1 Year" |
| karnataka-bank-limited | 10 | (similar) | (similar) |
| indian-bank | 30 | `{USD: 5, GBP: 5, EUR: 5, JPY: 5, CAD: 5, AUD: 5}` | "1 Yr to <2 Yrs" ← CORRECT |

**Two distinct sub-issues:**

**B1 — Wrong-table selection (7 banks)**

These banks have a page with multiple tables: (a) a regular INR FD table with 11+ columns showing deposit-amount tiers, (b) a separate FCNR currency-keyed matrix. The Cheerio table-picker scored the INR bulk table higher (more columns, more numbers) and picked it. Then the post-tagger noticed all slabs lacked `currency`, and the `tagCurrencyForeignVariant` default-fill assigned `expected_currencies[0]` = "USD" to every slab.

Evidence from canara warnings:
```
"cheerio_multi_table: picked table[2] (14 slabs) from 9 table(s); signals={...colCount:11}",
"llm_errors_present: keeping deterministic (LLM reported: chunk[2]: No FCNR foreign currency columns found in the selected table)",
"chunk[0]: table does not list FCNR foreign currency rates; it lists bulk deposit slabs in INR crores",
"currency_hint: no slab carried a currency; defaulted to USD"
```

The LLM correctly diagnosed the wrong-table problem; the deterministic Cheerio path won the picker contest anyway.

**B2 — FCNR matrix correctly extracted but missing currency columns (1 bank)**

- indian-bank: source has 8 currencies (USD/GBP/EUR/JPY/CAD/AUD/CHF/SGD); engine got 6 (USD/GBP/EUR/JPY/CAD/AUD). Pattern-B currency-cols detector recognized 6 of 8; missed CHF and SGD likely because their header text isn't recognized by `normaliseCurrency`'s canonical map.

### Fix strategy (Bucket B)

**Fix #1 — Variant-aware table picker (covers B1, 7 banks)**

In `lib/actions/extract_html_table.js`'s multi-table accumulator, when `variant === "fcnr"` or `"gift"`:

- Require the selected table to PROVE it's a currency-bearing table by:
  - Pattern A check: at least 2 distinct currency codes recognizable in the first-data-column cells (currency-rows layout), OR
  - Pattern B check: at least 2 distinct currency codes recognizable in the header-row cells (currency-cols layout)
- If NO scored table satisfies this, return null (let LLM fallback handle it) — do NOT pick the highest-scoring INR table and default-tag it

The currency-code recognition reuses `normaliseCurrency` from `scripts/utils/normalise-currency.js` and the `Pattern A` / `Pattern B` detectors from `lib/actions/extract_via_ocr.js` (functions: `detectCurrencyKeyedTable` for Pattern A, `detectCurrencyColumnsLayout` for Pattern B).

**Fix #2 — Disable the missing-currency USD default for fcnr/gift variants (covers B1)**

In `tagCurrencyForeignVariant` (`lib/actions/extract_html_table.js` ~line 1258), when ALL slabs lack currency AND `expectedCurrencies.length ≥ 2`, REJECT instead of default-filling with `expectedCurrencies[0]`. The current default-fill turns a missing-data bug into a silent wrong-data bug. Better: emit zero slabs + warning so the cohort `partial_silent` gate catches it.

**Fix #3 — Extend `normaliseCurrency` canonical map (covers B2, indian-bank case)**

Already-present codes get accepted; CHF and SGD are already in the alias table. The reason indian-bank missed them is more subtle — likely the LLM extractor's chunk processing dropped 2 columns. Investigate the indian-bank-specific chunking after Fix #1 lands.

**Impact estimate of Fix #1 + #2**:
- Affected banks: canara, PNB, idbi, city-union, punjab-sind, dhanlaxmi, karnataka (7 banks) — expect their FCNR files to revert to "0 slabs + warning" rather than "wrong N slabs"
- These banks will then need either an OCR hint (per FCNR-1/4 mechanism) OR an LLM-fallback fix to actually capture the FCNR data
- Cleaner failure mode immediately; full restoration is follow-up

---

## Bucket C — Regular/NRE/NRO moderate drops, INVESTIGATED (13 banks)

### Sub-category C1: Verified-OK (bank-side shrinkage) — 4 banks

| Bank | Variant | Baseline → New | Source page |
|---|---|---:|---|
| cosmos-co-operative-bank-ltd | nre | 8 → 6 | **6 rows** |
| hoogly-district-central-co-operative-bank-ltd | regular | 13 → 9 | **9 rows** |
| shikshak-sahakari-bank-ltd-nagpur | regular | 16 → 8 | **8 rows** |
| bank-of-india | nre | 11 → 7 | (probable match per Playwright) |

**Strategy**: accept with `Verified-OK 2026-05-23: source page publishes <N> rows`.

### Sub-category C2: Real engine regressions (5 banks)

| Bank | Variant | Baseline → New | Source page | Engine ratio |
|---|---|---:|---:|---:|
| citizen-credit-co-operative-bank-ltd-mumbai | regular | 14 → 8 | 17 | 47% |
| sbpp-co-operative-bank-ltd-killa-pardi | regular | 13 → 5 | 15 | 33% |
| the-district-co-operative-central-bank-ltd-srikakulam | regular | 7 → 3 | 25 | 12% |
| the-uttarakhand-state-co-operative-bank-ltd | regular | 7 → 3 | 7 | 43% |
| akola-district-central-co-operative-bank-ltd | regular | 10 → 8 | 9 | ~89% (borderline) |

**Root cause**: Same class as Bucket B — these pages have multiple tables (main FD table + special-scheme tables like 400-day URP, NAVATHI 900-day, MIS schemes). The engine picked one main table and skipped the special-scheme tables that should be emitted as separate slabs with distinct `deposit_range` or as part of the same product.

**Fix strategy**: Orch-1 already added multi-table accumulator (`extract_html_table.js`#scoredTables loop). But for these banks, the scored-tables filter is dropping the special-scheme tables — likely because their rows look like "400 Days | 7.50%" and the tenure parser doesn't recognise short rate-card formats consistently. Fix in `_cheerio_tables.js`'s scoring algorithm: lower the rate-row threshold for tables with 4-10 rows (small special-scheme tables).

**Impact estimate**: 4 banks recover slabs after fix; 1 (akola) is borderline and accept-eligible.

### Sub-category C3: Verified-OPS-REVIEW (URL unreachable) — 4 banks

| Bank | Variant | Issue |
|---|---|---|
| karur-vysya-bank-limited | nre | JS-rendered, static fetch returns no content |
| united-overseas-bank-limited | regular | Source URL returns 404 |
| g-p-parsik-janata-sahakari-bank-ltd-thane | regular | TLS cert verification failed (Norton MITM) |
| bank-of-nova-scotia | regular | PDF URL returns 404 |

**Strategy**: operator-task to refresh registry URLs. Accept-with-note in this cohort; investigate URL drift in a follow-up "registry-hygiene" pass.

---

## Bucket D — Pack-metadata drops, INVESTIGATED (11 banks)

### Sub-category D1: Already accepted 0→0 (4 banks)

amravati / dhule-nandurbar / shri-kadasiddeshwar / sriramnagar — keep existing accepts.

### Sub-category D2: Slug drift (4 banks)

Same bank, different canonical slug between baseline (May 14) and new cohort:

| Baseline slug | Current slug |
|---|---|
| `nkgsb-co-operative-bank-ltd` | `nkgsb-co-operative-bank-ltd-mumbai` |
| `the-zoroastrian-co-operative-bank-ltd` | `zoroastrian-co-operative-bank-ltd` (no "the-") |
| `the-ahmedabad-mercantile-co-operative-bank-ltd` | `ahmedabad-mercantile-co-op-bank-ltd` |
| `sri-potti-sriramulu-nellore-district-cooperative-central-bank-ltd` | `nellore-district-co-operative-central-bank-ltd` |

**Root cause**: registry hygiene — operator(s) renamed banks at different times without back-mapping in `data/cohorts/pm-refresh-2026-q2.json`. Pack-builder reads from `output/latest/<canonical-slug>_rates.json`; baseline was built with prior slugs; diff reports the bank as "dropped" even though it's still present under a new name.

**Fix strategy**:
- Short-term (this triage): accept with `Verified-SLUG-CHANGED <date>: see <current-slug>` reason
- Long-term (separate work): build a slug-alias table OR back-fill the baseline pack with the canonical slug to make future diffs accurate

### Sub-category D3: Not in cohort (1 bank)

`sri-lakshminarayana-co-operative-bank-ltd-bangalore` — registry has it, cohort doesn't.

**Fix strategy**: accept; if operator wants to include, add to `pm-refresh-2026-q2.json` and re-run that single bank.

### Sub-category D4: Real engine fails (2 banks — moved to Bucket A5)

bangalore-district-rural / societe-generale — covered above.

---

## Cross-cutting strategy: priority order for engine fixes

| Priority | Fix | Banks affected | Effort | Risk |
|---|---|---:|---|---|
| P0 | Bucket B Fix #1+#2 — variant-aware FCNR table picker + reject-not-default | 7 | 2-3 hr | LOW (additive) |
| P0 | Bucket A1 — IBU GIFT text-pattern fallback wire-up | 4 | 1-2 hr | LOW |
| P1 | Bucket C2 — small-table scoring tweak for special-scheme tables | 4 | 1-2 hr | MED (could regress other banks) |
| P2 | Bucket A2 — IDFC-First Orch-2 HTML hint | 1 | 15 min | LOW |
| P2 | Bucket A3 — per-bank registry URL refresh | 3 | 30 min each | LOW |
| P2 | Bucket A5 — investigate page-fetch failures | 2 | 30 min each | LOW |
| P3 | Bucket B B2 — debug indian-bank's missing 2 currencies | 1 | 1 hr | LOW |
| P3 | Bucket D2 — slug-alias table (long-term hygiene) | 4 | 2-3 hr | MED |
| P3 | Bucket C3 — registry URL refresh for unreachable | 4 | 1-2 hr total | LOW |

**Recommended fix-first sequence (1 day of engineering)**:

1. **Morning**: Land Bucket B Fix #1+#2. Re-run the 7 affected FCNR banks individually to confirm the wrong-table problem is gone (they'll likely return 0 slabs + warning until step 4).
2. **Mid-day**: Land Bucket A1 IBU GIFT fix. Re-run 4 IBU banks.
3. **Mid-day**: Land Bucket C2 small-table scoring tweak. Run 5-bank regression check (control banks must not regress).
4. **Afternoon**: Author OCR hints / Playwright tweaks for the Bucket B banks that need them to actually capture FCNR rates after Fix #1.
5. **End of day**: Re-run the 513-bank pm-refresh-2026-q2 cohort. Expect: most of the 27 OPEN-ENGINE-REGRESSION items cleared; new pack passes April-16 floor with `PASS_WITH_WARNINGS` after the Verified-OK / Verified-OPS-REVIEW accepts.

## Code locations for the fixes

| Bug | File | Function |
|---|---|---|
| B1 wrong-table picker | `lib/actions/extract_html_table.js` | the multi-table accumulator loop (Orch-1 introduced); add variant-aware filter that rejects scored tables not exhibiting currency markers |
| B1/B2 currency default-fill | `lib/actions/extract_html_table.js:~1258` | `tagCurrencyForeignVariant` — change "default-fill with expected_currencies[0]" to "reject + warning" when 2+ expected currencies but none found in slabs |
| A1 IBU GIFT html_js fallback | `lib/actions/extract_html_table.js:~545-574` | the text-pattern fallback block; check why it doesn't fire for variant=gift |
| C2 small-table scoring | `lib/actions/_cheerio_tables.js` | `extractScoredTables` row-count threshold |

## Risk register

- **Fix #1 might regress banks that are CURRENTLY correctly extracting FCNR** (e.g., axis-bank, hdfc-bank). Mitigation: add unit tests that pin the current correct extraction for these banks BEFORE landing the fix; run them after each change.
- **Cohort re-run cost**: ~$2.50 + ~2 hr wall time per full re-run. Budget for 2 re-runs (initial + after refinement).
- **PM delivery delay**: fix-first defers the new baseline by ~1 day. Acceptable per operator decision (2026-05-23) since net coverage is +83% vs PM floor anyway.

## What we are NOT doing pre-PM

- ICICI LLM under-extraction follow-up (FCNR-3 partial fix)
- Bucket D2 slug-alias table (long-term hygiene, separate work)
- Registry-wide URL refresh sweep (Bucket C3 + A3)
- TMB LLM truncation fix
- Yes Bank / Federal Bank infrastructure blocks
