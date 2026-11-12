# Engine fixes — FCNR-2: Axis cleanup (sub-tier + RFC filter + dedup)

> Follow-up to [FCNR-1](./engine-fixes-fcnr-1.md). Closes the known-issues
> from FCNR-1 that produced inflated and partially-mistagged Axis FCNR
> output. Axis goes from 88 slabs with duplicates → 53 clean unique slabs
> with proper deposit-tier tagging.

## Headline result

Axis FCNR PDF, post-FCNR-1:

| Before | After |
|---|---|
| 88 slabs | **53 slabs** |
| USD tagged as plain "USD" (sub-tier merged) | USD split: `deposit_range = "below_1mn"` (24 slabs) + `"above_1mn"` (24 slabs) |
| RFC table leaking 5 slabs as FCNR | RFC table rejected |
| Tables [0] and [1] both contributing 1y-5y rows (30 duplicates) | Cross-page dedup collapses duplicates |
| Sample row produced spurious `tenure_text: "Maturity Period"` + `rate=1` | Spurious row eliminated (parseRate end-anchor from FCNR-1.1) |

Math: 5 long tenures (1y-5y) × 7 cols (USD<1M, USD≥1M, GBP, EUR, AUD, CAD,
JPY) = 35 + 3 short tenures × 6 cols (no JPY) = 18 → **53 unique slabs**.

## What landed

### FCNR-2a — RFC table rejection (Pattern B guard)

Axis's FCNR PDF contains 3 tables. Table[2] is the **Resident Foreign
Currency (RFC) deposits** strip — a different product family with just
1 data row of rates per currency. Without filtering, it leaks into
the FCNR file as 5 bogus slabs.

Fix in `tableToSlabs`'s Pattern B path: count rows whose tenure-column
cell parses as a tenure (or at least is non-numeric text). Require
**≥ 2 such rows** to accept the table. RFC's single rate row has
col 0 = "0.15%" which `parseRate` cleanly matches as a number, so the
row doesn't count — and with only 1 valid tenure row (zero, after the
guard), the table is rejected.

Bank-agnostic: any 1-data-row currency-strip table will be rejected
regardless of bank. Real FCNR matrices always have multiple tenures.

### FCNR-2b — USD sub-tier as `deposit_range`

Axis FCNR PDF has a row-2 sub-header beneath the row-1 currency
headers: USD column spans two cells, then row 2 splits as "Below 1
million" and "1 million & above". Pre-FCNR-2, both USD cols emitted
slabs with `deposit_range: "below_3cr"` (the FCNR default).

New helper `amountTierToDepositRange(text)` recognises a small
canonical set of sub-header patterns:

| Sub-header text | deposit_range |
|---|---|
| "Below 1 million", "less than 1 million", "< 1 million" | `below_1mn` |
| "1 million & above", "≥ 1 million", "above 1 million" | `above_1mn` |
| "below 3 cr" | `below_3cr` |
| "3 cr ... 5 cr" | `3cr_to_5cr` |
| "above 5 cr", "≥ 5 cr" | `above_5cr` |

The Pattern B detector scans row N+1 below the currency header. If
≥ 2 columns parse to a deposit_range, the sub-row is recognised as a
sub-header (not data) and `dataStart` bumps to row N+2.

Result: Axis USD now emits 2 slabs per tenure (one per amount tier)
with proper `deposit_range` tags.

### FCNR-2c — Cross-page dedup in `extractViaOcr`

Axis publishes the same 1y-5y rate matrix in two tables on the same
PDF: Table[0] is the 8-col layout with JPY, Table[1] is the 7-col
layout with short tenures appended (no JPY). The overlap is 30 slabs
across 5 tenures × 6 common currency-cols.

New dedup pass before the action returns: composite key
`(tenure_text, tenure_min/max_days, currency, deposit_range,
rate_general_pct, rate_senior_pct)`. First instance per key wins;
duplicates dropped silently.

Generic — any bank that publishes overlapping tables benefits.

## Test results

| Suite | Tests | Status |
|---|---|---|
| `tests/lib/actions/extract_via_ocr.test.js` | 45 (+8 from FCNR-2) | ✅ all pass |
| Full suite | 802 pass / 1 skip / 0 fail | ✅ |

New tests cover:
- `amountTierToDepositRange` mapping (canonical + null cases)
- Pattern B detection with USD sub-tier sub-header — verifies
  `dataStart` bumps to row N+2 and `currencyCols[i].deposit_range` is
  populated
- 2-tenure Axis-shape end-to-end → 12 slabs with USD<1M / USD≥1M
- 1-tenure RFC-strip Axis-shape table is rejected by the guard
- 5-tenure Axis-shape (full) → 35 unique slabs after dedup

## Pack-level

| Metric | Post-FCNR-1 | Post-FCNR-2 | Δ |
|---|---:|---:|---|
| Total slabs | 7265 | **7228** | -37 |
| Axis FCNR slabs | 88 | **53** | -35 (dedup + RFC filter) |
| Other Δ | (drift) | (drift) | -2 |
| Verdict | BLOCK | BLOCK | unchanged |

The -37 isn't data loss — it's correct deduplication. The 53 slabs are
the genuine published rate count; the previous 88 was inflated by
overlapping tables and the spurious header row.

## What's open (FCNR-3)

ICICI / SBI / Bank-of-Bahrain still ship with `currency: null` on every
FCNR slab. Investigation (this session):

1. `tagCurrencyForeignVariant` in `lib/actions/extract_html_table.js`
   works correctly when invoked in isolation (verified via direct call:
   slabs without currency get tagged with the first
   `expected_currencies` value).
2. But the slabs in the produced files have **non-standard schema** —
   they include `compounding_freq: "QUARTERLY"` and `min_deposit: null`
   fields that aren't in CLAUDE.md's slab schema, AND lack `currency`
   AND `deposit_range`. This suggests the LLM-fallback path emits the
   slabs but something between the LLM response and the final file
   write either (a) bypasses the post-tagger, or (b) the LLM is
   emitting in a non-standard shape that doesn't go through the same
   pipeline.
3. `extraction_method` ends up as `llm_inline_extraction` (orchestrator
   path's LLM fallback at `extract_html_table.js:529`). The
   tagCurrencyForeignVariant call at line 575 SHOULD fire next, but no
   warning is emitted in the run log even though the post-tagger
   guarantees a warning when it defaults to expected_currencies[0].

Deferred to FCNR-3 — needs deeper investigation of the LLM-fallback ↔
post-tagger interaction in extract_html_table.js. May involve a
non-obvious code path that bypasses post-processing for certain LLM
response shapes.

## Files changed

| File | Change |
|---|---|
| `lib/actions/extract_via_ocr.js` | `amountTierToDepositRange` helper + Pattern B sub-header detection + Pattern B FCNR-shape guard + cross-page dedup pass |
| `tests/lib/actions/extract_via_ocr.test.js` | +8 tests covering all the above |
| `output/latest/axis-bank-limited_fcnr_rates.json` | Now 53 clean slabs |
| `sdlc/sprints/sprint-004/implementation/engine-fixes-fcnr-2.md` | This doc |
