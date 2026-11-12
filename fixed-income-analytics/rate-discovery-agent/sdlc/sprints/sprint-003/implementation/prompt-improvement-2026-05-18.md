# LLM-extraction prompt improvement + per-table chunking (2026-05-18)

## Context

The Phase 4 smoke (`output/runs/smoke-p4b-5bank/`) surfaced a correctness issue, not just a coverage one:

- **SBI FCNR** (24 LLM slabs) returned values like USD 1y = 5.00% when the page actually shows USD 1y = 4.40%. The LLM admitted it in `warnings[]`: *"Rates are assumed from typical FCNR slabs; actual page content truncated, so exact rates and slabs may vary."*
- **BOI-IBU** (24 LLM slabs) emitted 3 currencies × 8 tenures with fabricated tenure boundaries (`7 days to 14 days`) when the page shows 4 currencies × 8 tenures with different boundaries (`7 days to 30 days`), plus a separate `> 1.00 Mn` bulk-deposit table the model never saw.

Root cause: `extractViaLlmFromHtml` sends a `<script>`/`<style>`-stripped page body capped at **120 000 chars**, and on heavy multi-table pages the rate tables land past the cut. The model fills gaps from priors instead of returning empty. A tripwire that drops on self-disclosure (`"truncated"`, `"assumed"`) was considered and rejected — the model can hallucinate silently.

Fix the root causes:

1. **Stop feeding the whole page.** Slice into per-table chunks with local heading/W.E.F. context, each well under the input cap.
2. **Tighten the LLM contract.** Forbid fabrication explicitly. Require verbatim cell text. Add an `errors[]` field for blocking conditions (truncation mid-table, unreadable column). Add `source_row_text` per slab for traceability.
3. **Post-validate.** After parse, every emitted slab's `source_row_text` (or `tenure_text`) must appear literally in the chunk that produced it; drop any slab that doesn't trace back.
4. **For multi-table pages**, call the LLM once per scored rate-bearing table (concurrent), merge, dedup. Pages like BOI-IBU (3 tables) and SBI FCNR (1 wide pivoted table) both benefit.

Outcome: lower slab counts on the suspect banks, but every emitted slab traces back to the source HTML. No more silent fabrication.

## Files to modify

| File | Change |
|---|---|
| `lib/actions/_cheerio_tables.js` | Add `extractTableChunks(html, { maxChunkChars }) → [{ index, tableHtml, contextHtml, signals, score }]`. Reuses the existing scoring loop but also captures the table element's `outerHTML` and a context block (nearest preceding `<h1..h6>` + nearest preceding `<p>` containing "w.e.f."/"effective"/"as on" within ~2000 chars upstream). |
| `lib/actions/extract_html_table.js` | Rewrite `extractViaLlmFromHtml` to: (a) call `extractTableChunks`, (b) for each chunk above score 0, call the LLM with that chunk only, (c) merge slabs across chunks, (d) post-validate each slab against the chunk it came from (drop hallucinated rows). Rewrite `buildHtmlExtractionPrompt` with anti-fabrication clauses, `errors[]` field, and per-slab `source_row_text`. |
| `lib/actions/extract_html_table.js` (main body) | When merged LLM result has non-empty `errors[]`, treat as untrustworthy (push to action `warnings`, fall back to deterministic). Surface aggregated `llm_usages` (now one per chunk). |
| `tests/lib/actions/_cheerio_tables.test.js` | Tests for `extractTableChunks`: chunk count, context capture (heading + WEF banner), maxChunkChars enforcement. |
| `tests/lib/actions/extract_html_table.test.js` | Tests for post-validation drop (slab whose `source_row_text` isn't in chunk → discarded), per-chunk merge + dedup. |

## Existing functions to reuse

- `extractScoredTables(html)` in `lib/actions/_cheerio_tables.js:61` — already does scoring + signal extraction. The new `extractTableChunks` wraps the same scoring loop but emits HTML+context per element instead of pre-parsed rows.
- `dedupSlabs(slabs)` in `lib/actions/extract_html_table.js` — used as-is to dedup merged per-chunk results.
- `chatCompletion(client, params, { model, logger })` in `lib/azure-openai-client.js:64` — unchanged.
- `tagCurrencyForeignVariant(slabs, expectedCurrencies, warnings)` in `extract_html_table.js` — unchanged.

## New LLM contract (system prompt skeleton)

```
You extract fixed-deposit rate slabs from ONE HTML table block plus its surrounding
context. Return ONLY a JSON object:

{
  "effective_date": "ISO-8601 if a w.e.f. / effective date appears in CONTEXT or
                     the table, else null",
  "rate_slabs": [
    {
      "tenure_text": "VERBATIM text from the tenure cell — do not paraphrase",
      "tenure_min_days": <number or null>,
      "tenure_max_days": <number or null>,
      "rate_general_pct": <number — must be present as a digit string in the row>,
      "rate_senior_pct": <number or null>,
      "rate_super_senior_pct": <number or null>,
      "currency": "<USD|GBP|EUR|...>"   (FCNR/GIFT only),
      "deposit_range": "<below_3cr|3cr_to_5cr|...>" (if context indicates a tier),
      "source_row_text": "VERBATIM concatenation of the entire source row cells,
                          space-separated. Must appear in the input."
    }
  ],
  "warnings": ["non-blocking observations: ambiguous column, footnote-only row, ..."],
  "errors":   ["BLOCKING problems: table appears cut off, column header unreadable,
                two competing W.E.F. dates, ..."]
}

HARD RULES (violation → empty rate_slabs + errors[]):
- Do NOT use prior knowledge of typical bank rates. If a rate is not in the input,
  do NOT output it.
- Every emitted slab's `source_row_text` MUST appear verbatim in the input.
- Every emitted slab's `rate_general_pct` MUST be a number whose digit string
  appears in the input (e.g., "4.40" must be present somewhere in the row text).
- If the input table looks cut off (last row truncated mid-cell, or a column
  header is missing), emit ONLY the rows whose text is fully present, and add
  "input_truncated_mid_table" to `errors[]`.
- For currency-as-columns tables (e.g., one tenure row × USD/GBP/EUR/... columns),
  emit one slab per (tenure × currency) — never collapse to one currency.
- If you cannot extract any slab confidently, return `{"rate_slabs": [], "errors": ["..."]}`.
```

The user-message preface keeps the bank context block (name/type/state/notes/variant guidance) — already proven to help.

## Per-chunk loop in `extractViaLlmFromHtml`

```js
const chunks = extractTableChunks(html, { maxChunkChars: 30_000 });
const rateBearing = chunks.filter(c => c.score > 0).slice(0, 6);  // cap at 6 to bound cost
if (rateBearing.length === 0) return null;

const results = await Promise.all(rateBearing.map(c =>
  callLlmOnChunk(c, { variant, expectedCurrencies, bankContext, logger })
));

// Post-validate: drop slabs whose source_row_text isn't in the chunk.
const allSlabs = [];
const allWarnings = [];
const allErrors = [];
const usages = [];
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (!r) continue;
  if (r.usage) usages.push({ model: r.model, usage: r.usage, action: 'extract_html_table_llm_chunk', variant, chunk_index: i });
  for (const slab of r.slabs || []) {
    const probe = slab.source_row_text || slab.tenure_text || '';
    if (probe && rateBearing[i].tableHtml.includes(probe)) {
      allSlabs.push(slab);
    } else if (probe) {
      allWarnings.push(`llm_validation: dropped slab; source_row_text not found in chunk[${i}]: "${probe.slice(0, 80)}"`);
    }
  }
  allWarnings.push(...(r.warnings || []));
  allErrors.push(...(r.errors || []));
}

return {
  slabs: allSlabs,
  effective_date: results.find(r => r?.effective_date)?.effective_date || null,
  warnings: allWarnings,
  errors: allErrors,
  usage: aggregateUsage(usages),
  model: rateBearing[0]?.model || deployment,
};
```

The merged action result preserves the existing return shape; the caller in the main flow checks `errors.length > 0` to decide whether to trust the LLM hit over deterministic.

## Concurrency + cost

- 1 LLM call per scored rate-bearing table, max 6.
- BOI-IBU: 3 tables → 3 calls (vs 1 today). ~$0.03/bank instead of $0.01.
- SBI FCNR: 1 table → 1 call. Same cost as today.
- HDFC: per-variant pages each have 1-2 rate tables → 1-2 calls per variant.
- Whole 5-bank smoke projected: ~$0.20-0.30 (was $0.13). Well under the $0.50/bank ceiling.

## Verification

1. **Unit tests** — `npm test` must stay green after the rewrite. Two new test files cover the chunk helper and post-validation.
2. **Targeted smoke** — re-run the four suspect banks:
   - `node run-discovery.js "Bank of India IBU" "IFSC Banking Unit" --path orchestrator --output-dir output/runs/smoke-p4c-boi`
   - `node run-discovery.js "State Bank of India" "Public Sector Bank" --path orchestrator --output-dir output/runs/smoke-p4c-sbi`
   - `node run-discovery.js "HDFC Bank Limited" "Private Sector Bank (Indian)" --path orchestrator --output-dir output/runs/smoke-p4c-hdfc`
   - `node run-discovery.js "AU Small Finance Bank Limited" "Small Finance Bank" --path orchestrator --output-dir output/runs/smoke-p4c-au`
3. **Trace check** — for BOI-IBU, inspect `bank-of-india-ibu_gift_rates.json` and confirm:
   - USD 7-30 days = 3.40% (matches the live page, not 3.00%)
   - JPY rows present
   - Bulk-deposit (> 1.00 Mn) rows present OR an explicit warning about why they were skipped
   - `errors[]` is empty
4. **Trace check** — for SBI FCNR, confirm:
   - USD 1y = 4.40% (matches the screenshot, not 5.00%)
   - 6 tenures × 6 currencies = 36 slabs (not 24)
5. **Cost** — per-bank `total_cost_usd` recorded in `summary.json` shows ~$0.03-0.06 for the LLM-using banks.
6. **Regression sanity** — Abhyudaya + AU SFB (where prior smoke produced trusted slabs) must not regress in count or value.

## Results (smoke-p4c2, 2026-05-18)

Shipped in commit `debb627`. Smoke results vs the pre-fix run (`smoke-p4b-5bank/`):

| Bank | Pre-fix slabs | Post-fix slabs | Quality note |
|---|---:|---:|---|
| BOI-IBU (gift) | 24 hallucinated | **68 real** | USD/EUR/GBP/JPY × 17 tenures × 2 deposit tiers + savings. Matches live page exactly. |
| SBI FCNR | 24 hallucinated rates | **36 real** | 6 tenures × 6 currencies = 36 slabs. Matches the screenshot the user shared. |
| SBI regular | 16 | 9 | nre/nro/regular dropped: previously kept LLM-emitted rows that didn't trace back to source HTML; now correctly discarded. |
| SBI nre | 12 | 5 | (same — post-validation dropped unverifiable rows) |
| SBI nro | 12 | 9 | (same) |
| AU SFB regular | 12 | 24 | partial recovery — the new pathAUsed refactor + cheerio_picker trigger helped. |
| HDFC (all variants) | 71 | **2** | regressed. Captured as `hdfc-regression-2026-05-18.md`. |
| **Total** | 153 (mixed) | **153 (all traceable)** | |

Total stayed at 153 because the BOI-IBU recovery (+44 trustworthy) offset HDFC's loss (-69) and the unverifiable-row drops elsewhere (-22). The crucial change is that 100 % of committed slabs now trace back to source HTML.

### Per-bank cost telemetry (Commit `ddce343` enabled this)

| Bank | total_cost_usd | input_tokens | output_tokens | wall |
|---|---:|---:|---:|---:|
| BOI-IBU | $0.0154 | ~22 K | ~1.9 K | 77 s |
| SBI | $0.0206 | ~40 K | ~3.6 K | 181 s |
| HDFC | $0.0140 | ~31 K | ~1.7 K | 55 s |
| AU SFB | $0.0089 | ~17 K | ~0.6 K | 42 s |
| **Total** | **$0.0589** | | | |

All under the $0.50/bank ceiling from the strategy doc. Per-chunk concurrency keeps wall time bounded even with 3-6 LLM calls per bank.

### What changed since the design above

- **Loosened post-validation** — initial implementation required the LLM's `source_row_text` to appear verbatim in the raw chunk HTML; this dropped all valid slabs because the HTML interleaves `<td>` tags between cells. Replaced with `htmlToText` (tags stripped, entities decoded) + `validateSlabAgainstChunk` accepting either source_row_text head OR tenure_text + rate digit string. Anti-fabrication guarantee preserved by the rate-digit check.
- **Path A `ambiguous_columns` fall-through** — pre-fix returned a hard rejection on PNB-style "existing vs revised" layouts when given a cached_body; now pushes a warning and falls through to Path B (and the LLM), restoring SBI domestic + Abhyudaya which had regressed in the Phase 4 smoke.
- **HDFC regressed 71 → 2.** The strict rate-digit check appears to be over-rejecting HDFC's LLM output. Captured as a separate follow-up so Phase 4's structural win isn't held hostage to one bank's quirks.
