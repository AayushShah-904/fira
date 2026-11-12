# Orch-1 — Multi-table HTML extraction with section-context awareness

## Context

The M4 probe (commit `2072cdc`, `sdlc/sprints/sprint-004/probe/engine-tier-routing-probe.md`) confirmed that the orchestrator path is dramatically cheaper than the LLM path on banks where it works (HDFC: 74 slabs at $0.014 via orchestrator vs $0.73 via LLM). The strategic direction now is to **improve the orchestrator action-by-action** until it covers the cases the LLM-path historically handled, rather than tuning the legacy LLM-path.

Operator investigation 2026-05-21 on HDFC's `https://www.hdfc.bank.in/fixed-deposit/fd-interest-rate` page surfaced the next concrete gap. The page renders **8 `<table>` elements**:

| Table | Header | What it actually contains |
|---|---|---|
| `[0]` | `< ₹3 Crore` | **Rate data** (21 rows × 3 cols: Tenure / General / Senior) |
| `[1]` | `< 3 Crore` | Near-duplicate of [0] in a 2-col layout |
| `[2]` | `≥ ₹3 Crore To < ₹5 Crores` | **Rate data** (17 rows × 3 cols) |
| `[3]`–`[7]` | various | **Purely textual** — definitions, premature-withdrawal terms, interest-calculation methods, NRI notes |

The current orchestrator at `lib/actions/extract_html_table.js` (lines 208–225) walks scored tables and picks **one** by slab count — keeps table[0]'s 19 slabs, drops everything else. Two consequences:

- The `3cr_to_5cr` bucket (~17 slabs) is silently lost on HDFC and any similarly-structured PVB
- The page has rates that apply to NRE and NRO too (operator confirmation 2026-05-21), but those variant files currently carry stale aggregator-sourced data (sbnri.com, scraped 2026-03-30) — a separate data-quality concern

`extractScoredTables` is text-heuristic-based and over-marks textual tables as "rate-bearing" (8 vs the actual 2). Scoring is not changed in this design; the post-extraction zero-slab filter handles the over-scoring naturally.

### Page-level structure carries variant + rule signals

Operator-supplied 2026-05-21:

> Each HDFC rate table sits under a common section heading like `Domestic / NRO / NRE FIXED DEPOSIT RATE`, followed by an effective-date stamp and a per-section note like `*Note: Senior Citizen rates do not apply to NRIs | The minimum tenor for NRE Deposit is 1 year`, before the actual rate table.

The "/"-separated heading list declares the variants this section's tables fulfill. The notes are not decorative — they encode real schema-affecting rules:

- `"Senior Citizen rates do not apply to NRIs"` → when a table is replicated to NRE / NRO / FCNR slab files, drop the senior column
- `"Minimum tenor for NRE Deposit is 1 year"` → filter NRE-bound slabs to `tenure_min_days >= 365`

Similar note patterns appear across other Indian banks: `"FCNR has no senior premium"`, `"NRE-rate = domestic rate"`, etc. The fix must interpret these notes — without bank-specific code.

### Relation to A4 (`tier-header-propagation.md`)

A4 partially shipped: `extractTableTierLabel` (in `lib/actions/_cheerio_tables.js:334-361`) returns the single closest heading. The LLM-path's `tier_hint` chunk backfill is gated behind `RDA_TIER_AWARE_DEDUP` (default off). Orch-1 takes the orchestrator's deterministic path the rest of the way: multi-table extraction with heading-derived `deposit_range` and note-derived variant rules, no env-flag.

## Design

### High-level approach

Restructure `lib/actions/extract_html_table.js` so it returns the same `{ ok: true, pages: [...] }` shape that `lib/actions/extract_pdf_table.js` returns. Each "page" entry is a (table × variant) pair that passed scoring AND yielded ≥1 slab AND was selected by section-context interpretation. The orchestrator's existing M2.6 multi-page-by-variant aggregation (`lib/orchestrator.js` lines 420–437) absorbs the HTML output unchanged.

### New pure helpers

**`lib/cheerio/heading-to-deposit-range.js`** — Pure function mapping heading text → `deposit_range` enum value:

```js
function headingToDepositRange(heading: string|null): string|null
```

Recognised heading shapes:
- `below_3cr` ← `< ₹3 Cr`, `< 3 crore`, `below 3 cr`, `less than 3 cr`, etc.
- `3cr_to_5cr` ← `≥ 3 cr to < 5 cr`, `3 cr to 5 cr`, `3 crore to 5 crore`
- `5cr_to_25cr` ← `≥ 5 cr to < 25 cr`
- (similar for `25cr_to_50cr`, `50cr_to_100cr`, `100cr_to_200cr`, `200cr_to_500cr`, `500cr_to_1000cr`, `above_1000cr`)
- `null` when ambiguous — caller decides default

Bank-agnostic. Pure. Easy to unit-test exhaustively.

**`lib/cheerio/section-context.js`** — Two exports:

```js
function captureSectionContext($, $table, lookbackChars): {
  section_heading: string|null,         // e.g. "Domestic / NRO / NRE FIXED DEPOSIT RATE"
  effective_date_text: string|null,     // raw "w.e.f. ..." line if present
  notes: string[],                       // each "*Note: ..." or footnote line in section
}

function interpretSectionContext(context): {
  fulfills_variants: string[],          // ["regular","nre","nro"] from section_heading "/"-split
  senior_excluded_for: string[],        // variants where senior column should be dropped
  min_tenor_days_by_variant: object,    // { nre: 365 } from "minimum tenor ... 1 year" notes
  raw_notes: string[],                  // unrecognised notes echoed for warnings
}
```

`captureSectionContext` walks upward from a table to gather the section's heading + effective-date + notes (siblings between the heading and the table). `interpretSectionContext` applies a small set of regex patterns:

| Rule | Pattern (case-insensitive) | Effect |
|---|---|---|
| Variant fulfillment | `\b(Domestic\|NRE\|NRO\|FCNR\|GIFT\|Senior\s*Citizen)\b` in `section_heading` | "/"-split tokens populate `fulfills_variants` (Domestic → regular). Default `["regular"]` when none recognised. |
| Senior exclusion | `senior\s*(citizen)?\s*rates?\s*(do\s*not\|don't)\s*apply\s*to\s*(NRI\|NRE\|NRO\|FCNR)` | Adds matched variants to `senior_excluded_for` |
| Minimum tenor | `min(imum)?\s*tenor\s*for\s*(NRE\|NRO\|FCNR)\s*(deposits?\|FDs?)?\s*is\s*(\d+)\s*(day\|month\|year)s?` | Populates `min_tenor_days_by_variant[variant]` (years × 365, months × 30) |

Unrecognised notes go to `raw_notes` so the operator sees them in the run report. **All rules degrade gracefully**: a missed pattern means the safe default (no exclusion, no filter) — never an unintended data deletion.

Both helpers are pure (no I/O), bank-agnostic.

### `extract_html_table.js` restructure

Replace the single-winner loop at lines 208–225 with a multi-table accumulator. For each scored table with `score > 0`:

1. Run `extractSlabsFromTable` — keep only if ≥1 slab (drops the 6 textual tables on HDFC)
2. Capture nearest heading via `extractTableTierLabel` → map to `deposit_range_hint` via `headingToDepositRange`
3. Capture section context via `captureSectionContext` → interpret via `interpretSectionContext`
4. For each variant in `fulfills_variants`, emit a page entry:
   - Slabs: start from the full table slab list
   - If `senior_excluded_for.includes(variant)` → set `rate_senior_pct = null` on this variant's copy
   - If `min_tenor_days_by_variant[variant]` is set → drop slabs where `tenure_min_days < that_value`
   - Tag every emitted slab with `deposit_range_hint` (if it doesn't already have a `deposit_range` from column mapping)
   - Entry: `{ variant, slabs, deposit_range_hint, section_heading, notes, table_index, signals }`
5. Dedupe pages with identical (variant, heading, first-data-row) tuples — prefer the one with more columns

Returns:

```js
{
  ok: true,
  pages: [ /* one entry per (table × fulfilled-variant) */ ],
  slabs: /* concatenated for back-compat */,
  effective_date: ...,
  warnings: [ ...existing..., ...raw_notes from interpretSectionContext ],
  extraction_method: ...,
}
```

When a single page is produced (the common case), `pages` has length 1 — orchestrator handles fine. **No regression risk** for banks already extracting cleanly via the single-winner path because their pages will be a 1-element list with the same slabs.

### Orchestrator aggregation

The existing M2.6 aggregation (`lib/orchestrator.js` lines 420–437) groups by `page.variant` and concatenates slabs. It checks `extraction.pages || null` and falls back to the legacy single-payload path when `pages` is absent.

- **HTML path will now produce `pages` too**: existing aggregation handles it without code change
- The orchestrator currently iterates `for (const product of products)` and calls extraction once per product. When an HTML extraction returns pages for multiple variants in a single call (e.g., regular + nre + nro from HDFC's one URL), subsequent product iterations should NOT re-fetch the same URL and clobber. A small guard: track which (URL, variant) pairs have been committed; skip duplicate iterations.

### File layout summary

| File | Modification |
|---|---|
| `lib/cheerio/heading-to-deposit-range.js` | NEW — pure helper, ~50 LOC |
| `lib/cheerio/section-context.js` | NEW — capture + interpret helpers, ~150 LOC |
| `lib/actions/extract_html_table.js` | Restructure picker loop (~lines 208–225) → multi-table accumulator + variant fan-out. ~80–120 LOC change. Keep flat `slabs` field for back-compat. |
| `lib/orchestrator.js` | Optional small guard to skip duplicate variant iterations when one HTML extraction has already populated multiple variants. Otherwise unchanged. |
| `lib/actions/_cheerio_tables.js` | No change — `extractTableTierLabel` already exists, reused. |
| `tests/lib/actions/extract_html_table.test.js` | Add 5 new fixtures (multi-table, near-dup, textual-table filtering, no-heading, HDFC-style multi-variant) |
| `tests/lib/cheerio/heading-to-deposit-range.test.js` | NEW — exhaustive mapper tests |
| `tests/lib/cheerio/section-context.test.js` | NEW — DOM walker + note parser tests |

## Reusable existing utilities

- `extractTableTierLabel($, $table, lookbackChars)` in `lib/actions/_cheerio_tables.js:334-361` — reused as-is for nearest-heading capture
- `extractScoredTables(html)` in `lib/actions/_cheerio_tables.js:61-80` — reused without scoring changes (post-extraction filter handles over-scoring)
- `extractSlabsFromTable(rows, columnMapping)` — per-table slab extractor, reused unchanged
- `buildRatesPayload(bank_code, variant, slabs, ...)` — reused for commit payload construction
- `normaliseDepositRange` — keeps slabs differing only on `deposit_range` from being collapsed by dedup
- `extractEffectiveDateFromHtml(html)` — reused to populate section context's `effective_date_text`

## Acceptance / verification

1. **Unit tests** all green:
   - `tests/lib/cheerio/heading-to-deposit-range.test.js`
   - `tests/lib/cheerio/section-context.test.js`
   - `tests/lib/actions/extract_html_table.test.js` (updated)
2. **Full suite** `node --test --test-force-exit` stays ≥ 678 pass / 1 skip / 0 fail
3. **End-to-end on HDFC** (`node run-discovery.js "HDFC Bank Limited" --category "Private Sector Bank (Indian)" --state "Maharashtra" --path orchestrator`):
   - Domestic: ≥ 35 slabs across two `deposit_range` buckets, senior column populated
   - NRE: ≥ 16 slabs (≥1y tenures only), `rate_senior_pct = null` on every slab
   - NRO: ≥ 35 slabs (all tenures), `rate_senior_pct = null` on every slab
   - All sourced from `hdfc.bank.in/fixed-deposit/fd-interest-rate` (overwrites aggregator-sourced NRE/NRO files)
4. **Regression smoke**:
   - Axis via orchestrator path still produces 570 slabs (324 dom + 72 NRE + 162 NRO + 12 FCNR) — unchanged from M2.6
   - One LLM-path bank (e.g., Kotak) unchanged — Orch-1 doesn't touch the LLM-path
5. **Pack-level quality-gate**: regressions count drops by 1+ or stays stable
6. **Note-interpretation correctness** (spot-checked in produced rate files):
   - HDFC NRE — every slab has `rate_senior_pct = null` and `tenure_min_days >= 365`
   - HDFC NRO — every slab has `rate_senior_pct = null`, tenures span all values
   - HDFC domestic — senior populated where source has it, all tenures
7. **Conservative defaults**: unrecognised heading → `fulfills_variants = ["regular"]` (never an unintended NRE/NRO write)

## Out of scope

- Bank-specific hint authoring in `data/bank-domains.json` (Orch-2 follow-up if needed)
- M2.6-style multi-variant fulfillment via PDF hints for HTML URLs (already covered by the section-context approach above; no `bank-domains.json` schema change needed for the HDFC case)
- Scoring tightening in `extractScoredTables` — post-extraction zero-slab filter handles it
- LLM-fallback prompt changes — deterministic Path A handles multi-table directly now
- Axis `_plus_` variant schema, FCNR currency-keyed columns, floating-rate deposits — backlogged in `items-to-verify.md`
- M3 OCR fallback for image PDFs — still pending separately
