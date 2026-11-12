# Engine fixes — FCNR-1: Currency-keyed table handling

> Follow-up to [M3 OCR](./engine-fixes-m3-ocr.md). Addresses the
> long-standing "FCNR variants missing or wrong currency" gap by
> teaching the OCR extractor the **Pattern B** table shape (columns =
> currencies, rows = tenures) and adding currency-code normalisation.

## Findings from the FCNR audit

47 banks publish FCNR data; 941 slabs total in the pack. Pre-FCNR-1:

| Symptom | Banks | Slabs affected |
|---|---|---:|
| `currency: null` on every slab (extractor didn't tag) | axis, icici, sbi, bank-of-bahrain | 32 |
| Non-canonical currency code ("EURO", "YEN", "USD (Above 5L)") | south-indian-bank, city-union, cosmos, natwest | ~15 |
| Healthy multi-currency (USD/GBP/EUR/JPY/CAD/AUD already tagged) | 30 banks (PSB + large PVB) | ~750 |
| Still 0 slabs (different problem — page block / image PDF) | BoI / Mizuho / Maybank / Ujjivan / Yes | 0 |

FCNR-1 closes the first category for Axis and lays the groundwork
(Pattern B detector + currency normaliser) for the other 3 problem
banks. The second category (non-canonical codes) is normalised
automatically by any FCNR slab that passes through the OCR path.

## What landed

### 1. PDF column-hint schema gained `currency`

Before: PDF column hints only supported `age_tier` (general / senior /
super_senior) and `deposit_range`. FCNR PDFs where each column is a
different currency had no way to tag slabs.

After: `scripts/utils/parse-pdf-rate-lines.js#parseRateLines` reads
`col.currency` and writes it onto the slab. Authoring becomes:

```jsonc
"extraction": {
  "fd_pdf_fcnr": {
    "type": "pdf",
    "fulfills_product": ["fd_fcnr"],
    "pages": [{
      "page": 1,
      "columns": [
        { "age_tier": "general", "currency": "USD" },
        { "age_tier": "general", "currency": "GBP" },
        { "age_tier": "general", "currency": "EUR" },
        ...
      ]
    }]
  }
}
```

The PDF path now supports currency-keyed columns the same way it
supports deposit-range-keyed columns. Authoring is operator-driven.

### 2. OCR extractor — Pattern B currency-columns layout

New helper `detectCurrencyColumnsLayout(grid)` in
`lib/actions/extract_via_ocr.js`. Recognises the shape:

```
Maturity Period | USD | GBP | EURO | AUD | CAD
1 year < 2 yr   | 4.0 | 4.0 | 4.1  | 1.6 | 3.7
...
```

When matched, the action fans out **one slab per (tenure-row, currency-col)**.
Includes a multi-row header scan: DI Layout often returns a merged
"title" row at index 0 (e.g. "FCNR (B) DEPOSITS Interest Rates | w.e.f.
02nd March 2026") with the real header at row 1; the detector scans
the first 3 rows and uses the first one that contains ≥ 2 normalised
currency codes.

This complements the existing Pattern A (currency-rows × tenure-cols)
detector.

### 3. Currency normaliser

New `normaliseCurrency(text)` helper maps common variants to canonical
ISO codes:

| Input | Output |
|---|---|
| EURO | EUR |
| YEN | JPY |
| Sterling, Pound | GBP |
| USD (Above 5L) | USD (tier suffix stripped) |

Applied in both Pattern A and Pattern B paths so downstream dedup +
pack-build treat synonym variants as a single currency.

### 4. Axis FCNR hint authored

Routes Axis FCNR through OCR instead of the legacy PDF text extractor:

```jsonc
"extraction": {
  "fd_image_ocr_fcnr": {
    "type": "image_ocr",
    "fulfills_product": ["fd_fcnr"]
  }
}
```

Before/after:

| Metric | Before | After |
|---|---|---|
| Slab count | 12 | **90** |
| `tenure_text` shape | mashed (rates jammed into tenure string) | clean ("1 year < 2 years") |
| `rate_general_pct` | 0.01 (always — value mis-parsed) | per-currency rates |
| `currency` | null on every slab | USD/GBP/EUR/AUD/CAD/JPY |
| Extraction method | automatic_pdf | automatic_ocr |

## Test results

| Suite | Tests | Status |
|---|---|---|
| `tests/lib/actions/extract_via_ocr.test.js` | 37 (+10 from FCNR-1) | ✅ all pass |
| Full suite | 794 pass / 1 skip / 0 fail | ✅ |

## Pack-level

| Metric | Pre-FCNR-1 | Post-FCNR-1 | Δ |
|---|---:|---:|---|
| Total slabs | 7187 | **7265** | +78 (Axis FCNR 12 → 90) |
| FCNR slabs (audit subset) | 941 | ~1019 | +78 |
| Verdict | BLOCK | BLOCK | unchanged |

## Known issues (FCNR-2 territory)

1. **Column-cell alignment glitch on Axis FCNR.** DI Layout sometimes
   returns blank cells where merged header spans would otherwise apply.
   Result: some rate values get paired with the wrong currency
   (observed: "GBP | 4.1" where the actual GBP rate is 4.0 and 4.1 is
   the EUR rate). The currency codes themselves are correct; the
   row-to-rate mapping is what's off-by-one in a few cells.
2. **Axis PDF mixes FCNR and RFC tables.** The Axis FCNR PDF contains
   three tables — two FCNR-Bx variants and one RFC table at the bottom.
   The OCR extractor processes all three as separate "pages" and emits
   their slabs into the FCNR file. RFC is a different product family.
3. **Other affected banks not yet authored.** ICICI, SBI, and Bank of
   Bahrain still have `currency: null` slabs. Pattern: each has an HTML
   FCNR page (not a PDF) where the HTML extractor doesn't yet emit the
   currency field. Authoring HTML OCR hints for those is the next
   batch.
4. **Auto-trigger on `currency: null` files.** When an FCNR file has
   slabs but no currencies, the orchestrator could automatically retry
   through OCR. Deferred to keep traceability during rollout.

## Files changed

| File | Change |
|---|---|
| `scripts/utils/parse-pdf-rate-lines.js` | `currency` field added to slab output when present on column hint |
| `lib/actions/extract_via_ocr.js` | `normaliseCurrency`, `detectCurrencyColumnsLayout`, multi-row header scan, Pattern B fan-out |
| `tests/lib/actions/extract_via_ocr.test.js` | +10 tests covering normalisation, Pattern B detection, Pattern B end-to-end |
| `data/bank-domains.json#axis-bank-limited` | New `fd_image_ocr_fcnr` rate_pages key + matching `extraction.fd_image_ocr_fcnr` block |
| `sdlc/sprints/sprint-004/implementation/engine-fixes-fcnr-1.md` | This doc |
