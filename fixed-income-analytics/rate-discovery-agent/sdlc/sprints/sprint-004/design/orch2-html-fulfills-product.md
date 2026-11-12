# Orch-2 — HTML `fulfills_product` hints (M2.6 PDF mechanism, HTML edition)

## Context

M2.6 (commit `817d936`) added a registry hint mechanism that lets one PDF URL fulfill multiple variants. For Axis, a single NRI PDF (`nri-fixed-deposits-21-may-26.pdf`) is declared as fulfilling both `fd_nre` and `fd_nro` via:

```jsonc
"extraction": {
  "fd_pdf_nri": {
    "type": "pdf",
    "fulfills_product": ["fd_nre", "fd_nro"],
    "pages": [ ... ]
  }
}
```

The orchestrator's `findHintedPdfUrl(bankEntry, product)` then routes NRE and NRO product iterations to that same PDF URL — both variants extract from one source.

**The HTML side has no equivalent.** When HDFC publishes domestic + NRE + NRO rates on the same `/fixed-deposit/fd-interest-rate` HTML page (operator confirmed 2026-05-21), the orchestrator's `fd_nre` and `fd_nro` product iterations still go to the separate `nre-fixed-deposit/rates` and `nro-fixed-deposit/rates` URLs — which serve no rate data, leaving the variants empty. Orch-1 closed the multi-table extraction gap for the domestic iteration; HDFC NRE/NRO remain at 2-month-stale aggregator data (12 and 19 slabs from sbnri.com) because nothing tells the orchestrator that the domestic URL fulfills the NRI products too.

Orch-2 extends the M2.6 mechanism to HTML. A single helper `findHintedHtmlUrl(bankEntry, product)` mirrors `findHintedPdfUrl`. The orchestrator checks both. The HDFC registry gains:

```jsonc
"extraction": {
  "fd": {
    "type": "html",
    "fulfills_product": ["fd", "fd_nre", "fd_nro"]
  }
}
```

With that hint, NRE and NRO iterations route to the domestic URL. Orch-1's section-context interpretation handles the per-variant rules (senior excluded for NRIs, NRE 1-year minimum tenor) from the page's notes. Outcome: HDFC NRE and NRO commit freshly-extracted slabs from `hdfc.bank.in` with the correct rule overrides applied — replacing the aggregator-sourced stale data.

## Design

### `findHintedHtmlUrl` helper

New export from `lib/extraction-hint.js`, parallel to `findHintedPdfUrl`:

```js
function findHintedHtmlUrl(bankEntry, product) {
  // Iterate bankEntry.extraction entries; return the first whose
  //   - type === 'html'
  //   - fulfills_product (string or array) includes `product`
  // Resolve the URL via rate_pages[key] + domain just like findHintedPdfUrl.
  // Returns { url, key, hint } or null.
}
```

Same shape as `findHintedPdfUrl`. The only difference is the `type === 'html'` filter. Could be factored into a shared `findHintedUrl(bankEntry, product, type)` but the type-specific functions keep call-sites self-documenting.

### Orchestrator integration

In `lib/orchestrator.js`, the M2.6 PDF override block lives between the `cachedPath` lookup and the `find_rate_page` call. Orch-2 adds an HTML check alongside, with the PDF taking priority when both are declared (rare but possible — a bank could declare PDF AS THE PRIMARY and HTML as a fallback):

```js
let cachedPath = hints.cached_rate_pages?.[product];
const hintedPdf = findHintedPdfUrl(bankEntryForHint, product);
const hintedHtml = !hintedPdf ? findHintedHtmlUrl(bankEntryForHint, product) : null;
const hinted = hintedPdf || hintedHtml;
if (hinted) {
  log.info(`[orchestrator] product=${product}: using hinted ${hintedPdf ? 'PDF' : 'HTML'} URL ${hinted.url} (extraction.${hinted.key}) — overriding default`);
  cachedPath = hinted.url;
}
```

PDF preference rationale: PDFs are deterministic (parse text directly); HTML can be flaky (JS rendering, WAF). When both exist, PDF is the safer source. In practice no current bank declares both; this is just a future-proofing detail.

### HDFC registry hint

The minimum hint for HDFC:

```jsonc
"hdfc-bank-limited": {
  "domain": "hdfc.bank.in",
  "rate_pages": {
    "fd": "/fixed-deposit/fd-interest-rate",
    "fd_nre": "/nri-banking/fixed-deposit-rupee-account/nre-fixed-deposit/rates",
    "fd_nro": "/nri-banking/fixed-deposit-rupee-account/nro-fixed-deposit/rates",
    "fd_fcnr": "/nri-banking/fixed-deposit-foreign-currency-account/fcnr-deposit/rates",
    ...
  },
  "extraction": {
    "fd": {
      "type": "html",
      "fulfills_product": ["fd", "fd_nre", "fd_nro"]
    }
  },
  ...
}
```

When the orchestrator iterates products and hits `fd_nre`, `findHintedHtmlUrl` returns `https://hdfc.bank.in/fixed-deposit/fd-interest-rate`. The orchestrator replaces the `nre-fixed-deposit/rates` URL with that one. Classification returns `html_static`. `extract_html_table` runs with `variant: 'nre'`. Orch-1's section-context interpretation reads the page's heading + notes:

- **If** the page's section heading actually carries "Domestic / NRO / NRE" tokens AND the notes carry the "Senior...do not apply to NRIs" + "min tenor for NRE is 1 year" patterns → variant filtering + senior-nulling + min-tenor-filtering all fire automatically.
- **Else** (the operator couldn't structurally find them in real-time DOM, or HDFC's rendered HTML differs from expectations): the iteration variant 'nre' is used via `fulfills_variants_is_default` fallback. NRE pages get committed with all the same slabs as domestic — senior still populated, all tenures.

The second scenario is the failure mode to watch. If HDFC's actual page doesn't expose the section-context structure correctly, NRE files would commit *with* senior populated — which the operator says is wrong per RBI rules.

**Fallback option** if Orch-1's section-context interpretation doesn't catch HDFC's note patterns: add an explicit per-variant override block in the hint, like:

```jsonc
"extraction": {
  "fd": {
    "type": "html",
    "fulfills_product": ["fd", "fd_nre", "fd_nro"],
    "variant_overrides": {
      "fd_nre": { "senior_excluded": true, "min_tenor_days": 365 },
      "fd_nro": { "senior_excluded": true }
    }
  }
}
```

This would be a small extension to `interpretSectionContext` (or applied by `extract_html_table` directly). **Defer to the verification phase** — only build the override if the page's notes don't auto-parse cleanly.

### Files modified

| File | Change |
|---|---|
| `lib/extraction-hint.js` | NEW export `findHintedHtmlUrl(bankEntry, product)` |
| `lib/orchestrator.js` | Add HTML hint check beside the existing PDF hint check; either-or selection with PDF priority |
| `data/bank-domains.json#hdfc-bank-limited` | Add `extraction.fd` block |
| `tests/lib/tools-extraction-hints.test.js` | Add tests for `findHintedHtmlUrl` paralleling the M2.6 PDF tests |
| `sdlc/sprints/sprint-004/design/orch2-html-fulfills-product.md` | NEW (this doc) |
| `sdlc/sprints/sprint-004/implementation/engine-fixes-orch2.md` | NEW (implementation notes after verification) |
| `sdlc/sprints/sprint-004/implementation/items-to-verify.md` | HDFC subsection update — close domestic + NRE + NRO |

### Reusable utilities

- `findHintedPdfUrl` (`lib/extraction-hint.js`) — sister function; `findHintedHtmlUrl` shares ~all its structure
- `resolveExtractionHint` (`lib/extraction-hint.js`) — already accepts any type; unchanged
- Orch-1's `captureSectionContext` + `interpretSectionContext` — handles per-variant rule overrides if HDFC's section notes are structurally accessible
- Orch-1's multi-table accumulator in `extract_html_table.js` — produces correct per-variant pages without further changes

## Verification

1. **Unit tests** — `findHintedHtmlUrl`:
   - Returns null when no extraction block
   - Returns null when type is 'pdf', not 'html'
   - Returns the URL when `fulfills_product` includes the product (single value or array)
   - Returns null when `fulfills_product` doesn't include the product
   - Returns null when `fulfills_product` is missing
   - Handles absolute URLs in `rate_pages`
   - Handles relative URLs by joining with `domain`
2. **Full suite stays green** — 745+ pass / 1 skip / 0 fail
3. **End-to-end on HDFC**: `node run-discovery.js "HDFC Bank Limited" --category "Private Sector Bank (Indian)" --state "Maharashtra" --path orchestrator`. Expect:
   - HDFC domestic: 34+ slabs (Orch-1 baseline preserved)
   - **HDFC NRE: ≥ 30 slabs sourced from `hdfc.bank.in/fixed-deposit/fd-interest-rate`** (overwrites the 12-slab aggregator file)
   - **HDFC NRO: ≥ 30 slabs sourced from `hdfc.bank.in/fixed-deposit/fd-interest-rate`** (overwrites the 19-slab aggregator file)
   - HDFC FCNR: unchanged at 24 slabs aggregator-sourced (FCNR is a different page; out of Orch-2 scope)
4. **If senior is populated on NRE/NRO files** (auto-rule-detect didn't fire): apply the `variant_overrides` fallback in the hint, re-run, verify senior is nulled.
5. **Axis regression check** — 570 slabs unchanged (the PDF route is untouched)
6. **Pack quality-gate** — regressions count drops by 3+ (HDFC NRE/NRO/FCNR variant shifts now align closer to what the May 14 baseline expected)

## Acceptance

- ≥ 30 NRE slabs from `hdfc.bank.in` (replacing aggregator)
- ≥ 30 NRO slabs from `hdfc.bank.in` (replacing aggregator)
- Senior column null on NRE + NRO (per the page's note; or via variant_overrides fallback if auto-detect fails)
- NRE slabs all ≥ 1y tenure (per the page's note; or fallback)
- Axis still 570 slabs
- Full suite green

## Out of scope

- HDFC FCNR — the FCNR rates are published on a separate URL with different schema (currency-keyed columns). Closing FCNR is a follow-up.
- Multi-variant fulfillment for OTHER unhinted PVBs (ICICI, SBI, Kotak) — same mechanism applies; authoring those hints is a separate per-bank task once the mechanism is verified on HDFC.
- Bank-domains.json hint authoring tool / UI. The hint authoring is operator-driven for now.

## Stop conditions

- If HDFC NRE/NRO extraction yields fewer slabs than the existing aggregator-sourced files (12 / 19), investigate why before declaring success — could be a section-context bug or a deposit_range-filter mismatch.
- If the orchestrator routes NRE iteration to the domestic URL but the resulting file labels senior incorrectly, do NOT ship with senior-populated NRE/NRO data. Either fix via section-context tuning or the `variant_overrides` fallback in the registry hint.
