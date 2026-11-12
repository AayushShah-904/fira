# Engine fixes — FCNR-3: HTML LLM-fallback path syncs htmlPages

> Follow-up to [FCNR-2](./engine-fixes-fcnr-2.md). Closes the ICICI/SBI
> currency-tagging gap by syncing `htmlPages` with the post-processed
> `slabs` array in `lib/actions/extract_html_table.js`. Currency
> tagging now applies to LLM-fallback output the same way it applies
> to the deterministic path.

## Root cause

In `extract_html_table.js`, the action builds a top-level `slabs` array
at line 389 as a flat view of `htmlPages` (the per-table page array
that the orchestrator's M2.6 aggregation actually commits):

```js
slabs = htmlPages.flatMap((p) => p.slabs);
```

When the LLM-fallback path fires (line 520), `slabs` is replaced with
the LLM's output:

```js
slabs = llmResult.slabs;  // disconnects from htmlPages
```

The post-tagger at line 575 then operates on the (LLM) `slabs`:

```js
const tagged = tagCurrencyForeignVariant(slabs, hints?.expected_currencies, warnings);
slabs = tagged.slabs;
```

But `htmlPages` still holds the pre-LLM (often-empty) deterministic
slabs. The action returns `pages: htmlPages` at line 655. The
orchestrator commits from `extraction.pages`, NOT from `extraction.slabs`,
so the post-tagger's currency assignment never reaches the file.

Effect: ICICI/SBI/BoB FCNR slabs landed with `currency: null` (or
no `currency` field at all) and a non-standard slab shape that
inherited LLM-emitted fields like `compounding_freq`.

## The fix

After `tagCurrencyForeignVariant` runs, sync `htmlPages` with the
tagged slabs. Two cases:

1. **LLM-fallback / text-pattern fallback path**: replace `htmlPages`
   with a single synthetic page wrapping the tagged slabs. The
   pre-LLM page entries weren't usable anyway (the LLM fired because
   the deterministic path produced 0 or suspect output).

2. **Deterministic Path A**: the tagger creates new slab objects via
   spread copy, so the per-page slab arrays in `htmlPages` still
   reference the old (untagged) objects. Re-slice `tagged.slabs` back
   into the per-page arrays in order (one-to-one preservation, no
   reordering).

## Headline results

| Bank | Pre-FCNR-3 | Post-FCNR-3 | Currencies tagged |
|---|---:|---:|---|
| state-bank-of-india | 6 slabs, all `currency: null` | **36 slabs** | USD, GBP, EUR, CAD, AUD, JPY (all 6) |
| icici-bank-limited | 10 slabs, all `currency: null` | **17 slabs** | USD, GBP (LLM only captured 2/6 — separate issue) |
| bank-of-bahrain-and-kuwait-bsc | 4 slabs, all `currency: null` | 18 slabs, still null | Now routed via `automatic_pdf` path (different code path; needs PDF column hint per FCNR-1 mechanism) |

SBI is the clean win (+30 slabs, all 6 currencies tagged). ICICI shows
the fix works but the LLM is under-extracting (likely a prompt issue
where the LLM stops after the first currency or two). BoB has shifted
to a different extraction path entirely; needs a PDF column hint to
close.

## Pack-level

| Metric | Post-FCNR-2 | Post-FCNR-3 | Δ |
|---|---:|---:|---|
| Total slabs | 7228 | **7325** | +97 |
| FCNR (audit) | ~1019 | ~1116 | +97 from SBI+ICICI+BoB |
| Verdict | BLOCK | BLOCK | unchanged |

## Files changed

| File | Change |
|---|---|
| `lib/actions/extract_html_table.js` | New post-tagger sync block. LLM-fallback / text-pattern fallback paths replace `htmlPages` with synthetic single-page wrapping the tagged slabs. Deterministic Path A re-slices the tagged slabs back into per-page arrays. |
| `output/latest/state-bank-of-india_fcnr_rates.json` | 6 → 36 slabs across 6 currencies |
| `output/latest/icici-bank-limited_fcnr_rates.json` | 10 → 17 slabs, USD + GBP tagged |
| `output/latest/bank-of-bahrain-and-kuwait-bsc_fcnr_rates.json` | 4 → 18 slabs, still null currency (separate path) |

## Test results

| Suite | Tests | Status |
|---|---|---|
| `tests/lib/actions/extract_html_table.test.js` | 60 | ✅ all pass (no regression) |
| Full suite | 802 pass / 1 skip / 0 fail | ✅ |

## What's still open

1. **ICICI LLM under-extraction**: 17 slabs vs the ~36 SBI gets. ICICI's
   FCNR page may use a different table layout that confuses the LLM
   chunk extractor — only USD and GBP show up. Two angles:
   - LLM prompt tightening (instruct it to enumerate ALL currency columns)
   - Author an OCR hint (Pattern B) for ICICI's FCNR HTML page if the
     LLM proves unreliable
2. **BoB FCNR PDF currency tagging**: now hitting `automatic_pdf` path
   instead of LLM-fallback. Needs the FCNR-1 mechanism — author a
   PDF column hint with `currency` per column, OR re-route through
   the OCR-via-DI-Layout path.
3. **Other banks with `currency: null` FCNR slabs**: the audit's
   "currency null" list was 4 banks (axis closed by FCNR-2, sbi
   closed here, icici partially closed, BoB still null). The Axis
   PDF text-extractor's mashed-rate-into-tenure_text bug also still
   affects banks that have PDF FCNR sources without column hints.
4. **Non-canonical currency codes**: the audit showed
   south-indian-bank, city-union, cosmos, natwest emit "EURO" / "YEN" /
   "USD (Above 5L)". The `normaliseCurrency` helper in
   `extract_via_ocr.js` handles these, but the HTML extractor doesn't
   use it. Porting that helper to extract_html_table is a small follow-up.
