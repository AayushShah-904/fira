# Engine fixes — FCNR-5: text-pattern fallback guard for multi-currency variants

> Follow-up to [FCNR-4.1](./engine-fixes-fcnr-3.md) (revert). Closes the
> regression class that forced the FCNR-4.1 revert: the
> `automatic_text_pattern` fallback path was free to overwrite a clean
> upstream extraction with regex-noise slabs when extracting FCNR
> variants for banks the LLM-fallback couldn't reach.

## Context

This session's FCNR-4 commit (`a7c3d07`) ended up capturing 143 noisy
text-pattern slabs for south-indian-bank-limited's FCNR file, all
tagged `CAD` or `JPY` only — instead of the LLM-extracted 33-slab
7-currency clean version that had been on disk. The cause was timing:
a late background re-run completed in the window between FCNR-4a's
in-place normaliser and my `git add`, and the `automatic_text_pattern`
fallback in `lib/actions/extract_html_table.js` accepted its own
extraction without any sanity check against the operator's declared
`expected_currencies` hint.

The fix lives in the **orchestrator code path** (extract_html_table's
text-pattern fallback adoption gate) — not in a per-bank registry hint.
Generic safety rail for the whole pipeline.

## What landed

### New helper: `textPatternMultiCurrencyGuard`

```js
function textPatternMultiCurrencyGuard(textSlabs, variant, expectedCurrencies) {
  // Returns { rejected: false } unless ALL of:
  //   - variant ∈ {fcnr, gift}
  //   - expectedCurrencies declared, with length ≥ 3
  //   - text-pattern captured fewer than 3 distinct currencies
}
```

Lives next to `tagCurrencyForeignVariant` in `extract_html_table.js`.
Pure function; exported as `_textPatternMultiCurrencyGuard` for unit
testing.

### Wiring

The text-pattern adoption block calls the guard before accepting:

```js
const textSlabs = extractViaTextPattern(bodyForFallback, v, hints?.expected_currencies);
const guard = textPatternMultiCurrencyGuard(textSlabs, v, hints?.expected_currencies);
if (guard.rejected) {
  warnings.push(guard.reason);
} else if (textSlabs.length > 0) {
  slabs = textSlabs;
  pathUsed = 'text_pattern_fallback';
  extractionMethod = 'automatic_text_pattern';
  ...
}
```

When the guard rejects, the action falls through with the existing
empty/upstream `slabs`. If both deterministic AND LLM-fallback returned
nothing usable, the action ultimately returns `null` (line 576's
`if (slabs.length === 0) return null;`) — the orchestrator then leaves
the variant file untouched, which is exactly what we want: better
"keep the prior file" than "overwrite with noise".

### Decision parameters

- **Variant filter**: fcnr + gift only. Regular/NRE/NRO variants don't
  declare `expected_currencies`, so the guard never fires for them.
- **Threshold**: ≥ 3 expected, < 3 captured. A bank declaring 6
  currencies but only getting 2 is the case we're protecting against;
  a bank declaring 2 currencies and getting 1 might be a legitimate
  partial extraction.
- **Reason string**: includes captured currency list for operator
  triage — `"text_pattern_fallback_rejected: variant=fcnr expected 6
  currencies but text-pattern captured only 2 (CAD,JPY); refusing..."`

## Files changed

| File | Change |
|---|---|
| `lib/actions/extract_html_table.js` | New `textPatternMultiCurrencyGuard` helper; text-pattern adoption block calls it; export added. |
| `tests/lib/actions/extract_html_table.test.js` | +7 tests: rejection on south-indian regression case (80 slabs CAD+JPY only, 6 expected); acceptance on 3+ captured; no-op for regular variant; no-op when hint absent or hint < 3; empty-slabs no-op. |
| `sdlc/sprints/sprint-004/implementation/engine-fixes-fcnr-5.md` | This doc. |

## Test results

| Suite | Tests | Status |
|---|---|---|
| `tests/lib/actions/extract_html_table.test.js` | 71 (+7 from FCNR-5) | ✅ all pass |
| Full suite | 813 pass / 1 skip / 0 fail | ✅ |

## Why a generic guard, not a config knob

Two alternatives I considered:

1. Add `disable_text_pattern_fallback: true` per bank in
   `bank-domains.json`. Rejected: per-bank toggle is operator overhead
   for every bank that publishes multi-currency FCNR, and easy to
   forget on new banks.
2. Disable text-pattern fallback for fcnr/gift variants entirely.
   Rejected: text-pattern is the right answer for SOME single-currency
   small-bank cases (e.g., a co-op bank that only offers USD FCNR);
   blanket-disabling would hurt those.

The currency-spread guard threads the needle: text-pattern stays
available for low-currency-count banks, but refuses to overwrite when
the operator's hint says "expect many currencies" and the text-pattern
output doesn't match.

## What this does NOT prevent

- **PDF parser overwriting with noisy data**: BoB FCNR before the
  OCR hint went through `automatic_pdf` path with mashed columns and
  null currencies. The PDF parser has its own gates; FCNR-5 doesn't
  touch them. PDF banks need column hints or OCR hints to get clean
  output.
- **LLM-fallback under-extracting**: ICICI FCNR's LLM only captured 2
  of 6 currencies — but those slabs WERE tagged with the correct
  currencies (USD, GBP), so the operator's expectation is partially
  met. FCNR-5's guard fires on `< 3` regardless of operator hint size;
  ICICI's 2 currencies would NOT be rejected because they're real
  data not regex noise. Separate fix (LLM prompt or render-to-PDF +
  OCR) needed.

## Companion design decision

When I tried to author an OCR hint for ICICI FCNR directly, the DI
Layout call failed with "Invalid request" because the URL is HTML and
DI Layout accepts only image/PDF content types. Routing ICICI through
OCR would need a Playwright render-to-PDF intermediate step. Captured
as FCNR-6 in the task list, deferred — not blocking.
