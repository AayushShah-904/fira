# Item 21 — LLM extraction QC: dedup + effective-date sanitisation + ISO normalisation (Track A / A3)

**Date:** 2026-07-06
**Scope ref:** `sdlc/sprints/sprint-011/plan/sprint-011-scope.md` § "Item 21 — LLM extraction QC"
**Status:** implemented, tests green (not committed — operator review pending)

## What was built

New pure module **`lib/rates-qc.js`**, wired into **`lib/safe-write.js`** so every
`kind: 'rates'` write passes through a deterministic QC pass before the ADR-012
rejection rules run. QC is *cleaning only* — it never blocks a write on its own;
the existing rules (curated-overwrite, empty-overwrite, garbage-overwrite) are
untouched and now judge the cleaned payload.

### Rules (in application order)

| Rule | Applies to | Behaviour |
|---|---|---|
| **Q1 — ISO date normalisation** | ALL extraction methods | `effective_date` parsed → `"YYYY-MM-DD"`. Unparseable → `null` + warning appended to `payload.warnings`. |
| **Q2 — slab dedup** | `llm_inline_extraction` only | Composite key `tenure_text\|currency\|deposit_range\|scheme_subtype`, first wins. |
| **Q3 — stale-year sanitisation** | `llm_inline_extraction` only | Parsed year < (currentYear − 2) **and** original string was not already ISO → `null` + warning. The ISO exemption follows the scope doc's "reject if year < (current_year - 2) AND no ISO format match" — a date the LLM emitted in structured ISO form is unlikely to be page legalese. Catches the BoB `"1st July 1995"` FCNR(B)-introduction-date class. |
| **Q4 — under-extraction flag** | `llm_inline_extraction` only | When prior slab count is known and new (post-dedup) count is > 0 but < 50 % of prior → append `quality_warning: under_extraction_suspected — …` to `payload.warnings`. Never blocks. Zero-slab incoming is deliberately excluded — safe-write Rule 2 (`empty_overwrite_blocked`) owns that case. |

**Curated bypass:** any curated `extraction_method` (`manual_data_entry`,
`manual_*`, `pending_*` per `lib/extraction-methods.js#CURATED_EXTRACTION_METHODS`)
bypasses QC entirely — operator data is authoritative as entered, including its
`effective_date` spelling.

### `normalizeEffectiveDate(str)` — exported for reuse

Formats accepted (all seen in the wild):

- `2026-06-09` — ISO (also unpadded `2026-6-9` → canonical)
- `01.07.2025` / `15/08/2025` / `15-08-2025` — numeric **day-first**; dotted
  dates are ambiguous (D.M vs M.D) and are treated as **DD.MM.YYYY, the Indian
  convention**. A true M.D input with month-slot > 12 (e.g. `12.25.2025`) fails
  validation and returns `null` rather than a silently wrong date.
- `01-Jun-2026`, `8th June 2026`, `1st July 1995` — day-first with month word
- `June 8, 2026` — month-first with month word
- Leading `w.e.f.` prefix stripped (common on Indian rate pages)

Impossible dates (`31.02.2026`, `2026-13-01`), 2-digit years, unknown month
words, non-strings → `null`. Years outside 1900–2100 → `null`.

### safe-write integration

`lib/safe-write.js#safeWriteArtifact`: QC block inserted after
extraction_method validation / lazy-tagging and **before** the rejection rules,
so (a) rules judge the cleaned payload, (b) a rejected payload's `.pending.json`
sidecar carries the cleaned version too. `priorSlabCount` for Q4 comes from
reading the existing file at the target path. Return contract gains an optional
`qcChanges` field (`{ dupes_removed, date_normalised, date_rejected,
under_extraction_suspected }`; `null` when QC didn't run — non-rates kind or
curated bypass); it also rides the rejection-path return. Provenance history
(`_safe_write_history`) conventions unchanged; header doc updated from "three
jobs" to four.

## Fixture provenance — REAL copies, not synthetic

`tests/fixtures/rates-qc/` holds **verbatim copies** (taken 2026-07-06) of:

- `output/latest/bank-of-baroda_fcnr_rates.json` — 41 slabs / 5 duplicates
  (5-Year tier ×2 for GBP/EUR/CAD/AUD class), `effective_date: "1st July 1995"`
- `output/latest/idfc-first-bank-limited_fcnr_rates.json` — 18 slabs /
  6 duplicates (`1 Yr < 15 Months` repeats), `effective_date: "2026-02-26"`

Both live files still exhibited the 2026-06-16 audit defects at copy time (the
"manual cleanup script" workaround from the scope doc was evidently only applied
to the PM zip, not `output/latest/`). Originals untouched; tests write only to
`fs.mkdtempSync` temp dirs.

## Tests

- **`tests/lib/rates-qc.test.js`** (new, 21 tests): table-driven
  `normalizeEffectiveDate` accept/reject matrix; BoB fixture 41→36 +
  date→null; IDFC fixture 18→12 + date unchanged; non-LLM = normalise-only
  (no dedup, no stale-year null); LLM ISO-form old date kept (Q3 exemption);
  `manual_data_entry` + other curated methods full bypass; Q4 at <50 %,
  exactly-50 % boundary, post-dedup comparison, unknown prior, zero-slab and
  non-LLM exclusions; purity (input never mutated); first-wins ordering.
- **`tests/lib/safe-write.test.js`** (+6 integration tests): LLM write deduped
  + date nulled at write time; non-LLM date normalised but dupes kept; curated
  operator write bypasses; under-extraction warns without blocking; config kind
  untouched; rejected write's pending sidecar carries the QC-cleaned payload.

**Results (2026-07-06):** targeted files 64/64 pass; full suite
`node --test --test-force-exit` → **1592 tests, 1548 pass, 0 fail, 44 skipped**
(skips pre-existing). Note: `npm test`'s pretest write-discipline gate currently
fails on 11 pre-existing violations in untracked sprint-010-era scripts
(`scripts/analysis/*`, `scripts/pack/build-fcnr-only-pack-2026-06-15.js`, …) —
unrelated to this change; `lib/rates-qc.js` performs no IO.

## Deliberate decisions / open risks

1. **Q3 ISO exemption** — the task summary said "parsed year < currentYear-2 →
   null" unconditionally; the scope doc adds "AND no ISO format match". The
   scope-doc version is implemented (ISO-form old dates survive). If the
   operator prefers the stricter rule, drop the `wasIso` guard in Q3.
2. **Dedup key ignores the rate value** — per spec. Two slabs with the same
   key but *different* rates collapse to the first. Observed dupes carry equal
   rates, so this is safe today; a differing-rate collision would be silently
   resolved first-wins (logged via `logger.warn`).
3. **Q4 prior source** — `priorSlabCount` is the existing file at the target
   path. First-ever write to a path never flags under-extraction (no prior).
4. **Under-extraction is warn-only** by design; the R3 "clean-but-significant-
   drop" blocking rule remains item 12's territory.
5. **`output/latest/` still dirty** — BoB/IDFC live files retain their dupes +
   garbage date. QC fires on the *next* write through safe-write; a one-shot
   re-run (or a tiny operator script routing the current files through
   `qcRatesPayload`) would clean them in place. Not done here — real scraped
   artifacts are not modified without operator say-so.
