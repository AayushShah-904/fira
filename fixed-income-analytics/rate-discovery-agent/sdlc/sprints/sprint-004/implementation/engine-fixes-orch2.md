# Engine fixes — Orch-2: HTML `fulfills_product` hints

> Design ref: [`../design/orch2-html-fulfills-product.md`](../design/orch2-html-fulfills-product.md)
> Builds on Orch-1 (multi-table extraction + section-context interpretation).

## What landed

Orch-2 extends M2.6's PDF-side `fulfills_product` mechanism to HTML. A new helper `findHintedHtmlUrl(bankEntry, product)` lets a single HTML rate page declare which products it fulfills — so HDFC's `/fixed-deposit/fd-interest-rate` page (which publishes domestic + NRE + NRO rates in shared tables under a "Domestic / NRO / NRE FIXED DEPOSIT RATE" heading) now serves all three variants instead of the orchestrator routing NRE/NRO to dedicated URLs that carry no rate data.

A second fix landed in `interpretSectionContext`: the rule-extraction loop now applies note rules against `section_heading` itself, not just the `notes[]` array. HDFC's page concatenates the section title, effective-date stamp, and notes into a single `<h2>` element — `captureSectionContext` correctly classifies that blob as a heading, so the notes-only loop never saw the embedded "Senior Citizen rates do not apply to NRIs | The minimum tenor for NRE Deposit is 1 year" rules. Applying the same `|`-aware rule scan to `section_heading` closes the gap. The fix is general (any bank that packs notes into the heading benefits).

Together these two changes deliver HDFC's NRE/NRO acceptance criteria from the Orch-1 plan:

| Variant | Pre-Orch-2 | Post-Orch-2 | Notes |
|---|---:|---:|---|
| Domestic | 34 (Orch-1) | **34** | Unchanged; below_3cr + 3cr_to_5cr; senior populated |
| NRE | 12 (separate URL, stale aggregator-shaped) | **18** | Now sourced from `hdfc.bank.in/fixed-deposit/fd-interest-rate`; senior null on all; all tenures ≥ 365 days (1-year min-tenor rule applied automatically from the page's section heading) |
| NRO | 19 (separate URL) | **34** | Same source as NRE; senior null on all; both deposit_ranges |
| FCNR | 24 (separate URL) | 24 | Unchanged; out of scope for Orch-2 (FCNR is a different page with different schema) |

## Files changed

| File | Change |
|---|---|
| `sdlc/sprints/sprint-004/design/orch2-html-fulfills-product.md` | NEW — design doc landed before code |
| `lib/extraction-hint.js` | Added `findHintedHtmlUrl(bankEntry, product)` export. Refactored common loop into shared `findHintedUrlByType(bankEntry, product, type)`; `findHintedPdfUrl` and `findHintedHtmlUrl` are thin wrappers. |
| `lib/orchestrator.js` | Added HTML hint check beside the existing PDF hint check. PDF takes priority when both declared; either-or selection. Log line distinguishes "PDF" vs "HTML" override. |
| `lib/actions/_cheerio_section_context.js` | `interpretSectionContext` now scans `section_heading` for `|`-separated rule substrings (senior-exclusion + min-tenor patterns) using the same `applyNoteRules` pipeline. Closes the case where banks pack the heading + effective-date + notes into one heading-tagged element. |
| `data/bank-domains.json#hdfc-bank-limited` | Added `extraction.fd = { type: "html", fulfills_product: ["fd", "fd_nre", "fd_nro"] }`. Notes field expanded to document the section heading + rule patterns relied on. |
| `tests/lib/tools-extraction-hints.test.js` | +8 Orch-2 tests covering `findHintedHtmlUrl` (null bank, multi-variant array, type filtering, missing `fulfills_product`, absolute vs relative URL handling). |
| `tests/lib/actions/_cheerio_section_context.test.js` | +4 Orch-2 tests covering rule extraction from `section_heading` itself (HDFC-shape concatenated h2, with/without `*Note:` prefix, heading without rules stays empty, heading+notes union). |
| `scripts/analysis/debug-hdfc-section-context.js` | NEW analysis script — fetches HDFC's page via Playwright and dumps what `captureSectionContext` + `interpretSectionContext` actually extract. Used to root-cause why senior-exclusion didn't fire on the first Orch-2 run; preserved for future debugging of similar section-context issues. |

## Test results

| Suite | Tests | Status |
|---|---|---|
| `tests/lib/tools-extraction-hints.test.js` | 31 | ✅ all pass (was 23 pre-Orch-2) |
| `tests/lib/actions/_cheerio_section_context.test.js` | 30 | ✅ all pass (was 26 pre-Orch-2) |
| Full suite (`node --test --test-force-exit`) | **757 pass / 1 skip / 0 fail** in 41s | ✅ |

Full suite was 745 pre-Orch-2 → 757 post-Orch-2, a +12 net.

## End-to-end verification

### HDFC (`orchestrator` path)

```
$ node run-discovery.js "HDFC Bank Limited" --category "Private Sector Bank (Indian)" --state "Maharashtra" --path orchestrator
[2026-05-21T17:51:47.958Z] [WARN ]   OK 1m43s | html_static | 34 domestic, 18 nre, 34 nro | https://hdfc.bank.in | $0.042 | 24 tool calls
```

Per-variant verification:

| Variant | Source URL | Slabs | Senior populated | Deposit ranges | Min tenure |
|---|---|---:|---|---|---|
| domestic | `hdfc.bank.in/fixed-deposit/fd-interest-rate` | 34 | 34 / 34 | below_3cr, 3cr_to_5cr | 7d |
| nre | `hdfc.bank.in/fixed-deposit/fd-interest-rate` | 18 | 0 / 18 (all null) | below_3cr, 3cr_to_5cr | 365d (all ≥ 1y) |
| nro | `hdfc.bank.in/fixed-deposit/fd-interest-rate` | 34 | 0 / 34 (all null) | below_3cr, 3cr_to_5cr | 7d |

All three variants now sourced from HDFC's official rate page — no aggregator references.

Cost: $0.042, 24 tool calls, 1m43s wall clock. 1 LLM call inside `extract_html_table` for ambiguous chunks (otherwise deterministic Cheerio).

### Axis (regression check, `orchestrator` path)

```
OK 15s | pdf | 324 domestic, 72 nre, 162 nro, 12 fcnr | $0.000
```

Unchanged from M2.6 / Orch-1: 570 total slabs, $0.00 (deterministic PDF parser). Orch-2 only adds an HTML check; PDF path untouched.

### Pack-level

| Metric | Post-Orch-1 | Post-Orch-2 | Δ |
|---|---:|---:|---|
| Banks | 471 | 471 | 0 |
| Total slabs | 7005 | **7026** | +21 |
| Regressions | 33 | 33 | 0 |
| Anomalies | 88 | 88 | 0 |
| Warnings | 189 | 189 | 0 |
| Verdict | BLOCK | BLOCK | unchanged |

HDFC variant shifts: domestic 19→34 and nro 19→34 now appear in the GAINS list (was in regressions when the May 14 baseline carried higher slab counts that turned out to be aggregator-sourced and stale). NRE moved from 12 (baseline aggregator) → 18 (real source, filtered to ≥ 1y per the page's stated rule).

## Design decisions

| Question | Decision | Why |
|---|---|---|
| Where does `findHintedHtmlUrl` live? | Same file as `findHintedPdfUrl` (`lib/extraction-hint.js`), with a shared `findHintedUrlByType` helper underneath | Co-locates the two type-specific functions; one source of truth for the iteration + URL-resolution logic; no risk of behaviour drifting between PDF and HTML. |
| Priority when both PDF and HTML declared? | PDF wins | PDFs parse deterministically; HTML can be flaky (JS rendering, WAF). When both exist, PDF is the safer source. No current bank declares both — future-proofing only. |
| Where to fix the HDFC section_heading concatenation? | In `interpretSectionContext` (apply rules to section_heading), not in `captureSectionContext` (don't split the heading) | The capture function correctly classifies HDFC's `<h2>` as a heading — splitting it would corrupt the `nearest_heading_text` semantics and break the `deposit_range` fallback chain. Letting the interpreter scan the heading for rule substrings is a less invasive, more general fix. |
| Add the `variant_overrides` fallback hint? | Not needed — the section_heading rule-scan handles HDFC's case automatically | The fallback was design contingency in case auto-detection failed; with the interpreter fix, HDFC works without per-bank override. Keep `variant_overrides` as a documented escape hatch for future banks if needed. |

## What's open after Orch-2

1. **HDFC FCNR** — still aggregator-sourced (24 slabs from sbnri.com). FCNR rates are on a different URL with currency-keyed columns (USD/GBP/EUR/JPY/CAD/AUD), a schema the current `extract_html_table` doesn't handle natively. Closing FCNR is a follow-up that needs either (a) a dedicated FCNR-aware extractor or (b) an operator decision to remove the stale file pending the schema work.

2. **Apply same hint pattern to other large PVBs** — ICICI, SBI, Kotak likely have multi-variant pages where the same rates apply to domestic + NRE + NRO. Authoring `extraction.fd = { type: "html", fulfills_product: [...] }` for each is a few minutes per bank once verified at the page-shape level.

3. **Pages where notes carry the rules but the heading doesn't** — covered by the existing `notes[]` path in `interpretSectionContext`. No additional work.

4. **Pages where the section heading uses a different concatenation pattern than `|`** — e.g., notes joined with `;` or `•` or line-breaks. Could extend the heading scan to split on more separators if a real bank surfaces. Defer until evidence.

## Acceptance criteria vs Orch-2 design doc

| Design criterion | Result | Notes |
|---|---|---|
| ≥ 30 NRE slabs from `hdfc.bank.in` | 18 slabs | The 1-year min-tenor filter (correctly applied from the page's stated rule) trims the 34-row pool to 18 ≥ 365-day slabs. The "≥ 30" estimate in the design doc didn't account for this filter; 18 is the correct count given the rule. |
| ≥ 30 NRO slabs from `hdfc.bank.in` | 34 slabs | ✅ (no min-tenor rule for NRO) |
| Senior column null on NRE + NRO | 0 / 18 NRE + 0 / 34 NRO populated | ✅ — auto-detect via `interpretSectionContext` section-heading scan |
| NRE slabs all ≥ 1y tenure | min = 365d, all-pass = true | ✅ |
| Axis still 570 slabs | 324 + 72 + 162 + 12 = 570 | ✅ |
| Full suite green | 757 pass / 1 skip / 0 fail | ✅ |

The "≥ 30 NRE" estimate from the design was off; 18 is the correct outcome given the rule the page itself states. All other criteria met.
