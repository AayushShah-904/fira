# Phase C — Per-template deterministic extractors

**Phase:** C (Sprint 005)
**Status:** Design — to be implemented in Phase C code drops.
**Predecessor:** `./template-fingerprinting.md` (Phase A)
**Plan:** `../plan/sprint-005-scope.md` — exit criterion 4: one mega-cluster extractor + ≥20 banks.

## Context

Phase A produced the template fingerprint primitive. Phase C produces the first per-template extractor: `coop-bankin-3col-tenure-general-senior`. This extractor covers the highest-leverage cluster from Phase 0.1 — the top 6 success clusters (~100 banks) all share `html_static / .bank.in / regular-only / has-senior / 3-column`.

A single well-engineered extractor for this cluster unblocks ~100 banks at once — more than the 12-PSB exit criterion would deliver and with a smaller surface area to test.

## Goals

- One module: `lib/extractors/coop-bankin-3col-tenure-general-senior.js` implementing the extractor contract.
- One dispatcher entry point: `lib/extractors/dispatch.js` picks the extractor for a bank+kind.
- One traceability assertion helper: `lib/extractors/_helpers/_assert_traceability.js` (anti-fabrication contract enforcement — every slab carries source-row text proving it came from the page).
- One test framework: `tests/extractors/golden.test.js` runs the extractor against the Phase 0.4 fixtures and asserts slab parity.
- The extractor is exercised against at least 3 synthetic fixtures and a regression-case smoke from `tests/golden-html/regression-cases/`.

## Non-goals (deferred)

- Live HTML capture for real banks (Phase A.3 follow-up).
- Other extractors (PSB PDF, AEM FCNR matrix, Kotak multi-table, ...) — those land in subsequent Phase C drops.
- Per-bank `template` block authoring in `data/bank-domains.json` — Phase E migration.
- Cloud-side integration — Sprint 006.

## The extractor contract (every `lib/extractors/<id>.js` exports this)

```js
module.exports = {
  template_id: '<kebab-case slug>',
  applies_to: {
    kinds: ['html_static', 'html_js'],            // which fetch kinds this can extract
    framework_hints: ['wordpress', 'jquery', null], // optional — accept anything if absent
    bank_types: ['DCCB', 'SUCB', 'NSUCB', 'SSCB', 'RRB'], // optional
  },

  /**
   * @param {object} ctx
   * @param {string} [ctx.html]                  rendered HTML (for kind=html_*)
   * @param {string} [ctx.pdfText]               extracted text (for kind=pdf-text)
   * @param {object} [ctx.docintelLayout]        layout-API tables (for kind=docintel-layout)
   * @param {object} ctx.templateExtract         template.extract block from bank-domains.json
   *                                              (may carry table_selector, column_map, header_row,
   *                                              tenure_cap_days, etc.)
   * @param {object} [ctx.productContext]        { bank_code, bank_name, bank_type, variant, ... }
   * @returns {{
   *   slabs: Slab[],
   *   effective_date: string | null,
   *   warnings: string[],
   *   diagnostics: {
   *     table_used_index: number,
   *     header_row_text: string,
   *     rows_seen: number,
   *     rows_kept: number,
   *     rows_dropped_reasons: { [reason: string]: number },
   *   }
   * }}
   */
  extract(ctx) { /* ... */ }
};
```

Every slab in `slabs` MUST include `source_row_text` lifted from the actual DOM `<tr>` textContent (HTML extractors) or text line (PDF extractors). `_assert_traceability.js` checks the invariant; extractors that fail throw rather than silently drop the field.

## The dispatcher (`lib/extractors/dispatch.js`)

```js
function pickExtractor({ bankCode, templateId, kind, html, fingerprint }) {
  // Order:
  // 1. If templateId is given (from bank-domains.json template.extract.extractor),
  //    require that module and verify applies_to matches kind.
  // 2. Else if fingerprint provided and template_hash matches an extractor's
  //    registered hash, suggest reuse — return extractor + needs_confirmation: true.
  // 3. Else if kind is html_* and structure is "obviously 3-col", fall back to
  //    _generic-html-3col (NOT shipped in this Phase C drop; placeholder).
  // 4. Else fall back to _llm-fallback (NOT shipped in this Phase C drop;
  //    placeholder — returns a clear error so Phase B knows to wire the LLM path).
}
```

This Phase C drop ships only the `coop-bankin-3col-tenure-general-senior` extractor + a dispatcher that picks it by `templateId`. The fallback chain (`_generic-html-3col`, `_llm-fallback`) is stubbed with explicit errors so callers know where to wire them later.

## The first extractor: `coop-bankin-3col-tenure-general-senior`

### Structural signature

- Single (or first-scoring) `<table>` with 3 columns: `[tenure_text, rate_general_pct, rate_senior_pct]`
- Header synonyms: `Period | Tenor | Period of Deposit | Tenure` × `Rate | Rate of Interest | General | Non-Senior` × `Senior | Sr Citizen | Senior Citizen`
- Optional 4th column for `rate_super_senior_pct` (some DCCBs publish 80+)
- Domain: `.bank.in` (RBI-mandated co-op portal family)
- Bank types: DCCB / SUCB / NSUCB / SSCB / RRB

### Extraction algorithm

1. Parse HTML via cheerio.
2. Use the shared `lib/templating/_helpers/score-table.js#scoreTable` heuristic (already exists from Phase A) to pick the densest rate `<table>`.
3. If `templateExtract.table_selector` is set, narrow to that selector before scoring.
4. If `templateExtract.column_map` is set, use it directly. Otherwise infer column positions from the header row using the synonym map.
5. For each non-header row:
   - Extract cell text.
   - Run `parseTenure(cellText)` from `scripts/utils/parse-tenure.js` on the tenure cell.
   - Honor `templateExtract.tenure_cap_days` (falls through to parse-tenure's default 3650 if not set).
   - Parse rate cells: strip `%`, trim, `parseFloat`. Reject if outside `rate-bounds.js` bounds.
   - Emit slab with `source_row_text` = joined cell text of the row.
6. Apply `_assert_traceability.js` to every slab before returning.
7. Surface diagnostics: `table_used_index`, `header_row_text`, `rows_seen`, `rows_kept`, `rows_dropped_reasons`.

### Edge cases the extractor must handle (from Phase 0 data)

- **Header in `<th>` vs `<td>`** — some co-op tables use `<td>` with a `class="header"` instead of `<th>`. The `readTableRows` helper already flattens both.
- **Slab cell with parenthetical** — e.g. `7 Days to 45 days(new slab)`. Strip parentheticals before `parseTenure`.
- **Senior column missing rate** — co-op banks often leave senior blank for short tenures. Emit `rate_senior_pct: null` rather than treating the blank as 0.
- **Mixed-unit tenures** — `"181 to 12 months"` is common. `parseTenure` handles this; pass through.
- **Multi-table page with footnote table first** — the table-picker's `NOISE_PATTERNS` (`/w\.?e\.?f\.?/i`, `/comparison/i`) penalize footnotes; the rate table outranks.

### Anti-fabrication contract

Every emitted slab must carry `source_row_text` containing both the tenure text and the rate string. `_assert_traceability.js` enforces this. Failure throws — no silent drops.

The pre-Sprint-005 `extract_html_table.js` had this contract embedded implicitly; Phase C makes it explicit and shared so every extractor (and every future extractor) inherits it.

## The traceability assertion helper

`lib/extractors/_helpers/_assert_traceability.js`:

```js
function assertTraceability(slabs, { strict = true } = {}) {
  const failures = [];
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i];
    if (!s.source_row_text || typeof s.source_row_text !== 'string') {
      failures.push({ index: i, reason: 'missing source_row_text', slab: s });
      continue;
    }
    const lowerRow = s.source_row_text.toLowerCase();
    // Tenure text fragment must appear in source row (normalized)
    if (s.tenure_text && !normalizeForMatch(lowerRow).includes(normalizeForMatch(s.tenure_text))) {
      failures.push({ index: i, reason: 'tenure_text not found in source_row_text', slab: s });
    }
    // Rate must appear as a number in the source row
    const ratesToCheck = [s.rate_general_pct, s.rate_senior_pct, s.rate_super_senior_pct].filter(r => r != null);
    for (const r of ratesToCheck) {
      const asStr = r.toFixed(2).replace(/\.?0+$/, '');
      if (!lowerRow.includes(asStr) && !lowerRow.includes(r.toFixed(2))) {
        failures.push({ index: i, reason: `rate ${r}% not found in source_row_text`, slab: s });
        break;
      }
    }
  }
  if (failures.length > 0 && strict) {
    throw new Error(`assertTraceability: ${failures.length} slabs failed the contract: ${JSON.stringify(failures.slice(0, 3))}`);
  }
  return { passed: failures.length === 0, failures };
}
```

`strict: false` mode is used in golden tests where we want to surface failures as test assertions, not exceptions.

## Golden test framework

`tests/extractors/golden.test.js`:

For each `tests/golden-html/<bank>.expected.json`:
- Load `<bank>.expected.json` (slab_count, key_rates, ...) and `<bank>.expected.meta.json` (bank_type, scraper_type, ...).
- If `<bank>.html` exists, parse it and dispatch through the extractor. Assert slab count matches within ±1; key rates (1y, 2y, 3y, 5y) match within ±5bps.
- If `<bank>.html` does NOT exist (the case today — Phase A.3 backfills), skip with a clear `tap diagnostic` message saying "html fixture missing".

A synthetic-fixture path also lives in the same test file: for the first 3 representative banks, generate HTML from their `_rates.json` `source_row_text` fields, run the extractor against it, assert round-trip identity. This proves the extractor works without waiting on Phase A.3.

## Files modified / created

**Created:**

- `lib/extractors/dispatch.js` — extractor picker
- `lib/extractors/coop-bankin-3col-tenure-general-senior.js` — first extractor
- `lib/extractors/_helpers/_assert_traceability.js` — anti-fabrication contract enforcement
- `tests/extractors/golden.test.js` — golden test framework
- `tests/extractors/coop-bankin.test.js` — unit tests for the first extractor
- `tests/extractors/_assert_traceability.test.js` — unit tests for the contract helper

**Modified:** none. Phase C is additive; no production code under `lib/actions/` or `lib/orchestrator.js` is touched. Integration into the runtime path happens in Phase B/F when the dispatcher replaces the legacy two-path orchestrator.

## Verification

### Unit tests

- `assertTraceability` correctly accepts well-formed slabs and rejects slabs missing source_row_text / with tenure not in source.
- `coop-bankin` extractor against 3 synthetic fixtures (small co-op, mid co-op with 12 slabs, co-op with super-senior column).
- `coop-bankin` extractor handles the Phase 0 edge cases: parenthetical in tenure, blank senior cell, multi-table page with footnote table first.

### Integration (golden tests)

- For each top-50 bank with a matching template_id of `coop-bankin-3col-tenure-general-senior` and a captured HTML fixture, assert slab count parity. Today: 0 fixtures (HTML capture pending). Test framework skips with a diagnostic — green pass with N skips is the expected baseline.
- When Phase A.3 backfills `tests/golden-html/<bank>.html`, the same tests run automatically.

### Synthetic round-trip

For 3 hand-picked top-cluster banks (e.g., `abhyudaya-co-operative-bank-ltd-mumbai`, `apna-sahakari-bank-ltd`, `the-andhra-pradesh-state-co-operative-bank-ltd`):
- Read `<bank>_rates.json` from `tmp/baseline-pre-reset/`.
- Synthesize a 3-column `<table>` HTML from `source_row_text` of each slab.
- Run the extractor against the synthetic HTML.
- Assert the output slab count matches the input slab count exactly.
- Assert each output slab's `rate_general_pct` and `tenure_min/max_days` match the input.

This is a strong end-to-end test: it proves the extractor can reconstruct what the legacy extractor produced, against fixtures derived from real production data.

## Risks and assumptions

1. **Risk: round-trip synthesis hides bugs the real HTML would expose.** Synthetic HTML is too clean — no nested tables, no header drift, no footer noise. Mitigation: at least one regression-case fixture must use real captured HTML once Phase A.3 lands. For now, mark this as a documented gap.

2. **Assumption: `parseTenure` handles all co-op tenure patterns.** Phase 0 data shows ~40 patterns; `parse-tenure.js` claims preset support for most. Spot-check against a sample of `source_row_text` values during testing.

3. **Assumption: `rate-bounds.js` is correctly calibrated for the .bank.in co-op cluster.** Co-op banks publish rates up to ~12%; the bounds (0.1-15%) accommodate this. No change expected.

4. **Risk: the synthetic-fixture round-trip becomes a tautology.** If the synthesis logic mirrors the extractor logic, both bugs compensate and the test passes spuriously. Mitigation: the synthesis uses raw `source_row_text` from real `_rates.json` files (not from re-running the extractor) — it can only collapse with a real production bug.

## Open follow-ups (deferred from Phase C)

- `_generic-html-3col.js` fallback for banks without a template_id but obviously 3-column structure.
- `_llm-fallback.js` for banks where deterministic extraction fails (lifts the existing LLM path from `extract_html_table.js`).
- Per-bank `template` block authoring + verification trace (Phase E).
- Real HTML capture for golden fixtures (Phase A.3 — `scripts/analysis/harvest-golden-html.js`).
- Additional extractors: `psb-pdf-rate-card-3col`, `aem-tabbed-fcnr-currency-matrix`, `bootstrap-multitable-with-merged-headers` (Sprint 006).
