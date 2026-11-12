# Item 19 — Per-table variant classification + footnote capture (Sprint 011 Track A / A2)

**Date:** 2026-07-06
**Scope ref:** `sdlc/sprints/sprint-011/plan/sprint-011-scope.md` § "Item 19 — Per-table variant + footnote"
**Status:** implemented, tests green; NOT committed (per handoff instruction)

## Problem recap

`extract_via_ocr.js` applied the single input `variant` to every DI Layout table in a
PDF. Axis's `fcnr-rfc-deposits-13-june-26.pdf` bundles FCNR(B) (35 slabs), RFC Term
(36 slabs) and RFC Savings (0 rows) on one page → 71 slabs all tagged `fcnr`; 36
wrong slabs shipped on 2026-06-15 (patched post-hoc by
`scripts/recovery/axis-fcnr-purify-2026-06-15.js`). The RBI lock-in footnote
(8 Jun–30 Sep 2026 window, `#`-marked 3–5y tenures) was dropped entirely.

## What changed

### `lib/actions/extract_via_ocr.js`

1. **Per-table variant classification** (`classifyTableVariant`, fix (a)):
   - **Heading match** — nearest preceding DI paragraph on the same page, restricted
     to the y-band between the previous table's bottom and this table's top
     (so table N never claims section N−1's heading), matched against
     `VARIANT_HEADING_MAP`: RFC Savings → `rfc_savings`, RFC Term → `rfc_term`,
     FCNR → `fcnr`, NRE → `nre`, NRO → `nro`, Domestic/Regular → `regular`.
     RFC entries are tested before FCNR so combined titles ("FCNR & RFC Deposits")
     can't claim an RFC section. Geometry from `boundingRegions[].polygon` y-coords
     (`regionOf`).
   - **Currency heuristic fallback** — currency-bearing table WITH JPY → `fcnr`,
     WITHOUT JPY → `rfc_term`, no currency column → `rfc_savings`.
     **Deliberately gated** (see "Deviations" below): runs only when the input
     variant is `fcnr` AND the doc shows an RFC signal (`detectRfcSignal`: any
     paragraph mentions RFC, or ≥2 currency-bearing tables with differing JPY
     presence).
   - Otherwise the input variant is kept (existing behaviour).
2. **RFC drop** (fix (c), minimal form): slabs classified `rfc_term`/`rfc_savings`
   are counted and dropped, with the operator-visible log line
   `[ocr] dropped 36 rfc_term slabs (not in pack schema)` and an additive
   `dropped_slab_counts` field on the result for downstream visibility/tests.
3. **Footnote capture** (fix (b), `collectRegulatoryConstraints`): paragraphs that
   start with a footnote marker (`#`/`*`/`†`), contain `/lock-in|RBI|regulatory|note:/i`,
   or sit below the last table with DI `role: "footnote"` are deduped into a
   `regulatory_constraints: string[]` field on the extraction result.
   Page headers/footers/page numbers are always excluded.
4. **Slab flag keys**: footnote markers found in a raw tenure cell are extracted
   (`extractTenureFlagKeys`) into `regulatory_flag_keys` (e.g. `["#"]`) on the slab,
   at all three slab-construction sites (Pattern B currency-cols, Pattern A
   currency-rows, standard tenure-keyed). `cleanTenureText` now also strips
   trailing `#` so markers no longer pollute `tenure_text`.
5. New internals exported for tests: `regionOf`, `matchHeadingVariant`,
   `tableCurrencySet`, `detectRfcSignal`, `classifyTableVariant`,
   `collectRegulatoryConstraints`, `extractTenureFlagKeys`.

### `lib/orchestrator.js` (minimal additive plumbing only)

- Multi-page commit path: `regulatory_constraints` from the extraction result is
  forwarded in the `ctx` passed to `buildRatesPayload` (the single-payload
  HTML/vision path already passes the whole extraction object as ctx).
- `buildRatesPayload`: emits `regulatory_constraints` on the rates payload **only
  when present and non-empty** — payload shape unchanged otherwise. `commit_rates`
  / `safe-write` / `validate-rates` are field-tolerant (verified), so the field
  flows into the written `_fcnr_rates.json` untouched.

No other orchestrator changes; `lib/safe-write.js` and `run-discovery.js` untouched.

## Files touched

| File | Change |
|---|---|
| `lib/actions/extract_via_ocr.js` | classification + drop + footnote + flag keys |
| `lib/orchestrator.js` | 2 additive edits (ctx forward + conditional payload field) |
| `tests/fixtures/di-axis-fcnr-rfc-2026-06-13.synthetic.json` | **new** golden fixture |
| `tests/lib/actions/extract_via_ocr.item19.test.js` | **new** 13 tests |

## Golden fixture: SYNTHETIC

Searched for a captured AnalyzeResult from the 2026-06-15 Axis session
(`output/runs/2026-06-15T111*_axis-bank-limited/`, `output/`, `scripts/recovery/`,
`*analyzeResult*`, `*.di.json`) — **none survived**; the run dirs hold only
log/summary/trace/rates files and the recovery scripts called DI live without
persisting the response.

The fixture is therefore a clearly-commented **synthetic** reconstruction of DI
prebuilt-layout output for the Axis PDF: 3 tables with `boundingRegions`
(FCNR(B) 5 tenures × 7 currency cols incl. JPY and the USD below/above-1mn split
= 35 slabs; RFC Term 6 tenures × 6 cols, no JPY = 36 slabs; RFC Savings rate strip
= 0 rows), section-heading paragraphs, `#` markers on the three 3–5y FCNR tenure
rows (21 flagged slabs — matches the scope doc's count), and the lock-in footnote
paragraph. Rate **numbers are placeholders** (labeled in the fixture `_comment`);
the footnote text is the real regulatory wording quoted in the scope doc. No
fabricated data can ship: the fixture lives under `tests/fixtures/` and is only
read by tests.

## Test evidence

- `node --test tests/lib/actions/extract_via_ocr.item19.test.js tests/lib/actions/extract_via_ocr.test.js`
  → **58/58 pass** (13 new + 45 pre-existing OCR tests unchanged).
- Full suite `node --test --test-force-exit` → **1605 tests, 1561 pass, 0 fail,
  44 skipped** (pre-existing skips; ~168s).
- `npm test` currently fails in **pretest** (`check-write-discipline`) on 11
  violations in untracked `scripts/{analysis,azops,cohort,pack,recovery}` files
  from the 2026-06-15 recovery workstream — pre-existing, unrelated to this item.

Golden assertions: exactly 35 slabs returned, all `variant: fcnr`, JPY present, no
RFC tenures leaked; `dropped_slab_counts.rfc_term === 36` + exact log line; footnote
in `regulatory_constraints` (headings not captured); 21 slabs carry
`regulatory_flag_keys: ["#"]` with `#` stripped from `tenure_text`. Negative tests:
FCNR-only doc stays `fcnr` with no drops/constraints; non-JPY menu without RFC
signal stays `fcnr` (heuristic gate); unlabelled two-table doc with differing JPY
presence triggers the heuristic.

## Deviations / decisions

1. **Heuristic gate** — the scope doc's raw heuristic ("currency table without
   JPY ⇒ RFC Term") applied unconditionally would demote and DROP the entire FCNR
   table of any legitimate FCNR-only bank whose currency menu lacks JPY
   (USD/GBP/EUR-only menus are common in the 2026-06-15 cohort). Gated on
   `inputVariant === 'fcnr'` + an RFC signal in the document. Also not applied to
   `gift` input (GIFT menus are USD-heavy and JPY-free — would always misroute).
2. **Footnote predicate** — implemented as marker-start OR regulatory keyword OR
   (below-last-table AND DI `role:"footnote"`), rather than capturing *everything*
   below the last table, to keep addresses/footers out of `regulatory_constraints`.
3. **`regulatory_constraints` scoping** — attached doc-level (every variant payload
   committed from that PDF), not per-variant as the scope doc's stretch wording
   suggests; acceptable for the minimal ship since the Axis footnote is FCNR-wide.
4. **Generalised flag** — used `regulatory_flag_keys: ["#"]` (scope doc's
   generalised option) instead of the hardcoded `lock_in_2026_jun_sep: true` the
   purify script used.

## Open items / follow-ups

- Document `regulatory_constraints` (rates file) and `regulatory_flag_keys` (slab)
  as optional additive fields in `docs/agent/schemas.md` — not edited here to avoid
  colliding with concurrent sprint-011 doc work.
- Pack schema decision on `rfc_term`/`rfc_savings` variants (scope fix (c) full
  form) still pending PM demand; today they are dropped with a log.
- Re-run the Axis bank live (or via `scripts/recovery/axis-fcnr-direct-2026-06-15.js`)
  after merge to confirm 35/36/0 on the real PDF and retire the purify script.
- When a real DI capture next flows through, persist the AnalyzeResult and replace
  the synthetic fixture with a trimmed real one.
