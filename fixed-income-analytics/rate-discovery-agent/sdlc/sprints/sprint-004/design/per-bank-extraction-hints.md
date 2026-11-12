# M2 design — per-bank extraction hints + variant-scoped partial_silent

## Context

M1 (commit `cb0718a`) fixed the PDF-fetch infrastructure (`fetch_pdf` headers, redirect resolution, two-stage timeout) and recovered 217 slabs across 4 banks. But output verification surfaced a class of failures M1 cannot address:

1. **Multi-column PDF tables not captured.** Axis's domestic PDF has 4 rate columns on page 1 (`general < 3 cr`, `general 3-5 cr`, `senior < 3 cr`, `senior 3-5 cr`) and pages 2-3 carry 7 bulk-deposit amount tiers (5-25 cr, 25-50, 50-100, 100-200, 200-500, 500-1000, > 1000 cr). The current `RATE_LINE_PATTERN` regex in `scripts/extract_rates_pdf.mjs` captures at most 3 rate values per line and slots them into `(general, senior, super_senior)` — so 3 of the 4 columns on page 1 are dropped, and all 14 columns on pages 2-3 are mislabelled. Net: 18 slabs ship for Axis where the PDF actually contains ~324 rate cells (18 tenures × 18 columns across the 3 pages, minus a few non-existent senior/general combinations).
2. **JS-rendered non-table layouts.** HDFC, DCB, IDFC-First NRI pages render successfully under Playwright but `extract_html_table` can't find slabs because rates live in `<div>` / card / shadow-DOM components, not in `<table>`. Documented in M1 cohort report + the original Sprint-004 op-guide.
3. **Whole-bank exclusion when one variant drifts.** Citibank shipped 51 slabs across 3 variants but `regular` came in at 17 vs operator-set floor 34. The `partial_silent` marker excluded the whole bank — Citibank's NRE + NRO (34 healthy slabs) ship out alongside the drifted regular. Same pattern hit Ujjivan: 25 healthy slabs (regular + NRE + NRO) excluded because FCNR drifted to 0.

The plan at `~/.claude/plans/pivot-to-engine-failure-lovely-wombat.md` allocates M2 to "per-bank selector / interaction hints". This design doc expands M2 to cover all three issues above because they share a common shape — telling the extractor *something specific about this bank or this URL* that the heuristic cannot infer alone.

## Decisions

| # | Decision | Operator confirmed |
|---|---|---|
| 1 | `partial_silent` marker excludes only the **drifted variant(s)**, not the whole bank | 2026-05-21 |
| 2 | Per-bank extraction hints live in `data/bank-domains.json#<bank>.extraction.*` keyed by the same variant key as `rate_pages.*` | new this doc |
| 3 | Hints cover both HTML (CSS selector, click-to-reveal, tab nav) and PDF (column layout, deposit_range mapping per page/column) | new this doc |
| 4 | The `deposit_ranges` enum is extended with the bulk buckets Axis/HDFC/ICICI publish | new this doc — **needs BIRD-side coordination before merge** |
| 5 | No backwards-incompatible breakage: absence of hint = today's heuristic path | new this doc |

## Architecture

### 5a. Variant-scoped `partial_silent` marker

**File: `lib/tier-router.js`**

Today's marker payload (written around line ~715 of `run-discovery.js` which calls into tier-router):

```json
{
  "bank_code": "ujjivan-small-finance-bank-limited",
  "reason": "slab drift on fcnr: 0 < 0.8 * 6 (prior)",
  "detected_at": "2026-05-21T05:41:13.393Z",
  "attempts": 3
}
```

New payload:

```json
{
  "bank_code": "ujjivan-small-finance-bank-limited",
  "reason": "slab drift on fcnr: 0 < 0.8 * 6 (prior)",
  "drifted_variants": ["fcnr"],
  "healthy_variants": ["regular", "nre", "nro"],
  "detected_at": "2026-05-21T05:41:13.393Z",
  "attempts": 3,
  "marker_schema_version": 2
}
```

`tier-router.js#checkQuality` already knows which variants drifted (it iterates them in `expectedByVariant` and detects per-variant). The new emit list comes free.

**File: `pack/build-pack.js`**

`loadPartialSilentSlugs` becomes `loadPartialSilentVariants`:

```js
function loadPartialSilentVariants() {
  const map = new Map(); // bank_code → Set<variant>  ('*' = all variants, legacy)
  for (const f of fs.readdirSync(LATEST_DIR)) {
    if (!f.endsWith('.partial_silent.json')) continue;
    const slug = f.slice(0, -'.partial_silent.json'.length);
    const marker = tryParse(path.join(LATEST_DIR, f));
    if (marker && Array.isArray(marker.drifted_variants) && marker.drifted_variants.length) {
      map.set(slug, new Set(marker.drifted_variants));
    } else {
      // Legacy marker (no drifted_variants field) → whole-bank exclude (back-compat).
      map.set(slug, new Set(['*']));
    }
  }
  return map;
}
```

Per-file skip in `loadLatest`:

```js
const variantsToSkip = partialSilent.get(r.slug);
if (variantsToSkip && (variantsToSkip.has('*') || variantsToSkip.has(r.key))) {
  silentSkipped++;
  continue;
}
```

The config-file branch stays whole-bank: if any variant drifts and the bank has a config file, the config still ships. Only the rate files for the drifted variants are skipped.

**Migration**: existing markers in `output/latest/` (5 of them as of this writing) lack `drifted_variants`. They get treated as whole-bank exclusion (legacy back-compat). When those banks are re-run, the new marker shape is written and the variant-scoped path takes effect.

**Tests** (add to `tests/lib/tier-router-drift.test.js`):
- marker written by checkQuality contains `drifted_variants` array when drift on one variant
- legacy marker (no field) → loaded as `{'*'}` set
- `pack/build-pack.js` test fixture: bank with marker `{drifted_variants:['fcnr']}` → regular/nre/nro included, fcnr excluded

### 5b. Per-bank extraction hints — schema

**File: `data/bank-domains.json`**

Add an optional `extraction` object alongside `rate_pages`. Keys mirror `rate_pages` exactly (so `extraction.fd` controls extraction for `rate_pages.fd`, `extraction.fd_pdf_domestic` for `rate_pages.fd_pdf_domestic`, etc.).

```jsonc
{
  "axis-bank-limited": {
    "domain": "axis.bank.in",
    "rate_pages": {
      "fd": "/deposits/fixed-deposits/fd-interest-rates",
      "fd_pdf_domestic": "/docs/.../domestic-fixed-deposits-21-may-26.pdf",
      "fd_pdf_domestic_plus": "/docs/.../domestic-fixed-deposits-plus-21-may-26.pdf",
      "fd_pdf_nri": "/docs/.../nri-fixed-deposits-21-may-26.pdf",
      "fd_pdf_nri_plus": "/docs/.../nri-fixed-deposits-plus-21-may-26.pdf",
      "fd_pdf_fcnr": "/docs/.../fcnr-rfc-deposits-02-march-26.pdf",
      // ...
    },
    "extraction": {
      // HTML hint — used when fetching an HTML rate page
      "fd": {
        "type": "html",
        "wait_for_selector": "table.fd-rates",
        "extract_selector": "table.fd-rates",
        "click_to_reveal": null,
        "tab_selector": null
      },
      // PDF hint — used when fetching a PDF
      "fd_pdf_domestic": {
        "type": "pdf",
        "pages": [
          {
            "page": 1,
            "columns": [
              { "name": "general_below_3cr",   "age_tier": "general", "deposit_range": "below_3cr" },
              { "name": "general_3cr_to_5cr",  "age_tier": "general", "deposit_range": "3cr_to_5cr" },
              { "name": "senior_below_3cr",    "age_tier": "senior",  "deposit_range": "below_3cr" },
              { "name": "senior_3cr_to_5cr",   "age_tier": "senior",  "deposit_range": "3cr_to_5cr" }
            ]
          },
          {
            "page": 2,
            "columns": [
              { "age_tier": "general", "deposit_range": "5cr_to_25cr" },
              { "age_tier": "general", "deposit_range": "25cr_to_50cr" },
              { "age_tier": "general", "deposit_range": "50cr_to_100cr" },
              { "age_tier": "general", "deposit_range": "100cr_to_200cr" },
              { "age_tier": "general", "deposit_range": "200cr_to_500cr" },
              { "age_tier": "general", "deposit_range": "500cr_to_1000cr" },
              { "age_tier": "general", "deposit_range": "above_1000cr" }
            ]
          },
          {
            "page": 3,
            "columns": [
              { "age_tier": "senior", "deposit_range": "5cr_to_25cr" },
              { "age_tier": "senior", "deposit_range": "25cr_to_50cr" },
              { "age_tier": "senior", "deposit_range": "50cr_to_100cr" },
              { "age_tier": "senior", "deposit_range": "100cr_to_200cr" },
              { "age_tier": "senior", "deposit_range": "200cr_to_500cr" },
              { "age_tier": "senior", "deposit_range": "500cr_to_1000cr" },
              { "age_tier": "senior", "deposit_range": "above_1000cr" }
            ]
          }
        ]
      }
    }
  }
}
```

**Key shape rules:**
- `type` is `"html"` or `"pdf"` (required when `extraction.<key>` is present)
- For `type: "html"`: optional `wait_for_selector`, `extract_selector`, `click_to_reveal`, `tab_selector` strings. Absence = current heuristic.
- For `type: "pdf"`: optional `pages` array; each entry has `page` (1-indexed) and `columns[]`. Each column declares `age_tier` (`general` / `senior` / `super_senior`) and `deposit_range` (enum value). Absence of `pages` = current single-column-per-line heuristic.
- An empty `extraction.<key>` object is legal and equivalent to absence (operator can scaffold the structure without yet authoring values).

**Authoring rule** (will land in op-guide): when adding a hint, the operator must record the source — open the page, identify the columns, screenshot or paste-quote the header row in the commit message.

### 5c. PDF parser — honor per-page column hints

**File: `scripts/extract_rates_pdf.mjs`**

Add a `--hint <path-to-hint.json>` CLI option. The hint file is the value of the per-bank `extraction.<key>` object, serialised to a temp file by `lib/tools.js#fetchPdf` before spawning the child.

In `parseRateLines` (or a sibling per-page function called from `pages_data.map`), when a hint is supplied for the current page:

1. Build a wider regex that captures up to `columns.length` numeric values (current regex caps at 3). Use `(\d+\.\d+)\s*%?` repeated `columns.length` times, with tab/space tolerance.
2. For each matched line, emit one slab **per column**, with `rate_general_pct` / `rate_senior_pct` / `rate_super_senior_pct` set according to the column's `age_tier`, and `deposit_range` set from the column declaration.
3. Tenure text is normalised once per line (current `normalizeTenureText` path).

When no hint is supplied for a page, fall back to current 3-column regex behaviour — no regression for the 99 banks already passing.

**Output shape change**: `pages_data[].slabs` may now contain N×M rather than N slabs (N tenures × M columns). The flat `rate_slabs` array still merges them. Dedup behaviour in the LLM/orchestrator should not interfere because slabs differ on `deposit_range` and/or age column population.

**Tests** (add to `tests/scripts/parse-tenure.test.js` or new `tests/scripts/extract-rates-pdf-hints.test.js`):
- A synthetic 4-column PDF text input with a hint → 4 slabs per tenure, correct deposit_range / age_tier
- Same input, no hint → 3-column heuristic still emits old behaviour
- Hint mismatch (declares 4 columns, PDF has 3) → emit warning, fall back per-line

### 5d. HTML extractor — honor selector / click / tab hints

**File: `lib/actions/extract_html_table.js`** (orchestrator path) and `lib/actions/fetch_page.js` / the Playwright session module (used by `run_playwright` tool in the LLM path).

For `extract_html_table.js`:
- When hint exists with `extract_selector`, narrow cheerio scope to that selector before running the table picker. Falls back to current heuristic if selector matches nothing.
- When hint has `wait_for_selector`, the Playwright fetch (upstream) waits for that selector before snapshotting.

For Playwright runner:
- When hint has `click_to_reveal`, after page load click the matching element (e.g., a "View Rates" button), then snapshot.
- When hint has `tab_selector`, click each tab in sequence and emit one snapshot per tab.

**LLM-path integration** (`prompts/discover.md`):
Append a short paragraph: "If `data/bank-domains.json#<bank_code>.extraction.<key>` exists, you must honor it. Read it via `read_file`. For HTML hints, pass `wait_for_selector` to `run_playwright`. For PDF hints, the `fetch_pdf` tool reads them automatically — don't paraphrase the columns yourself."

### 5e. `deposit_ranges` enum extension

**File: `pack/build-pack.js`** (the `enums.deposit_ranges` literal) and `pack/dist/rates-pack.schema.json` (regenerated by build-pack).

Current enum:
```
below_3cr, 3cr_to_5cr, 5cr_to_25cr, 25cr_to_100cr, above_100cr,
below_15l, 15l_to_1cr, 1cr_to_10cr, above_10cr, below_1m_usd
```

Proposed additions (driven by Axis pages 2 & 3, likely also relevant for HDFC/ICICI/SBI bulk tiers):
```
25cr_to_50cr, 50cr_to_100cr, 100cr_to_200cr, 200cr_to_500cr,
500cr_to_1000cr, above_1000cr
```

Note: `25cr_to_100cr` (existing) is now coarser than what Axis actually publishes. Keep both — existing coarse value still applies to banks that publish at that coarseness; new fine values for banks that publish more granular tiers.

**Coordination required** before this enum change merges to main:
- BIRD ingestion side (the consuming UI / DB / Mastra agents) must accept the new values
- Existing BIRD seed data won't have the new values; ingestion should not fail on unknown values (forwards-compat)
- If BIRD side isn't ready, the M2 first cut can leave Axis-page-2/3 slabs as `above_100cr` (the existing coarsest bucket) — uglier but unblocks shipping

**Recommendation**: ship enum extension in M2 because the fine-grained tiers are semantically real. Communicate the new values to BIRD before pack publish.

### 5f. Telemetry

`lib/tier-router.js` already emits `[METRIC] slab_drift` lines. Extend to also emit:
- `[METRIC] hint_applied bank=<slug> key=<rate_page_key> type=<html|pdf>` — when a hint is honored
- `[METRIC] hint_missed bank=<slug> key=<rate_page_key> reason=<no_selector_match|column_count_mismatch>` — when hint declared but didn't apply

These let us measure adoption + diagnose stale hints once authored.

## Critical files (M2 lands changes to all of these)

| File | M2 change |
|---|---|
| `lib/tier-router.js` | emit `drifted_variants` array in marker payload; bump `marker_schema_version` to 2 |
| `pack/build-pack.js` | `loadPartialSilentSlugs` → `loadPartialSilentVariants`; per-file skip honours variant set; extend `enums.deposit_ranges` |
| `pack/dist/rates-pack.schema.json` | regenerated by build-pack with new enum values |
| `scripts/extract_rates_pdf.mjs` | new `--hint` flag; per-page column emission when hint present |
| `lib/tools.js` | `fetch_pdf` writes per-bank hint to a temp file and passes `--hint <path>` to the child |
| `lib/actions/extract_html_table.js` | honour `extract_selector` from hint |
| `lib/actions/fetch_page.js` (or playwright session) | honour `wait_for_selector`, `click_to_reveal`, `tab_selector` |
| `prompts/discover.md` | append hint-awareness paragraph for LLM path |
| `data/bank-domains.json` | author hints for cohort: Axis (full PDF schema), HDFC NRI variants, DCB NRI variants, IDFC-First NRI variants, RBL (where applicable) |
| `tests/lib/tier-router-drift.test.js` | tests for variant-scoped marker shape |
| `tests/scripts/extract-rates-pdf-hints.test.js` (new) | tests for `--hint` flag + column emission |
| `tests/pack/build-pack-variant-scoped.test.js` (new) | fixture: marker with `drifted_variants:['fcnr']` → only fcnr excluded |

## Verification

Per the master plan, M2 has both unit and end-to-end gates:

1. **Synthetic unit tests** (no network): all green via `node --test`
2. **Variant-scoped exclusion smoke**: with Citibank's current `partial_silent` marker rewritten to include `drifted_variants: ["regular"]`, build pack → confirm Citibank now ships with `nre` and `nro` (34 slabs) and `regular` held back
3. **Per-bank hint cohort re-run**: HDFC (all 4 variants), DCB (NRE/NRO), IDFC-First (NRE/NRO), RBL (where applicable), Axis (re-run after PDF column hint authored). Expected: HDFC + IDFC-First recover ≥5 NRI slabs each; Axis grows from 18 → ~324 cells when full hint set lands
4. **No-regression cohort**: 5 currently-passing PVBs of similar shape (Kotak, Federal-IBU?, IndusInd, J&K-Bank, others) re-run with `extraction` absent → slab counts within 0.95× baseline
5. **Pack-level quality gate**: post-M2 pack vs `pack/history/rates-pack-2026-05-14.json` → regressions count strictly decreases vs post-M1 pack (28 → fewer)
6. **Cost telemetry**: per-bank `total_cost_usd` recorded in `engine-fixes-m2.md`
7. **Full test suite**: stays green via `node --test --test-force-exit`

## Phased execution within M2

M2 is large. Execute in 4 commits to keep each reviewable:

| Commit | Scope | Verifiable by |
|---|---|---|
| M2.1 | Variant-scoped marker (tier-router + build-pack) + tests + back-compat for legacy markers | Variant-scoped exclusion smoke (Citibank passes through with regular held back) |
| M2.2 | `extraction.*` schema in bank-domains.json + HTML selector honor in extract_html_table + Playwright runner click/tab hooks + prompt update + tests | Synthetic html-fixture test; targeted re-run of one PVB with a hint authored |
| M2.3 | `--hint` flag in extract_rates_pdf.mjs + column-emission engine + `deposit_ranges` enum extension + tests | Synthetic 4-column-PDF test; Axis cohort re-run with hint authored ⇒ all 18 columns emit |
| M2.4 | Author hints for HDFC + DCB + IDFC-First + RBL + cohort re-run + pack rebuild + quality-gate + impl doc | End-to-end: pack regressions count drops vs post-M1; M2 impl doc lands |

## Out of scope

- OCR fallback (M3) — Ujjivan FCNR, Equitas, Unity, Odisha SSCB, Rajasthan SSCB
- Network/WAF bypass (Federal GCLB, Yes Akamai, Suryoday) — needs residential proxy, not an engine fix
- Slug-drift duplicate resolution (the-ahmedabad-mercantile vs ahmedabad-mercantile-co-op-bank-ltd type pairs) — separate registry-hygiene task
- Tamilnad rates-as-JPEG — M3 OCR
- Drift-floor recalibration after multi-column extraction lands — sprint-005, once we have multi-column data to calibrate from
