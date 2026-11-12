# Item 20 — Cohort UNION rule + gap audit (Track A / A4)

**Date:** 2026-07-06
**Scope ref:** `sdlc/sprints/sprint-011/plan/sprint-011-scope.md` § "Item 20 — Cohort builder UNION rule"
**Status:** implemented, tests green (not committed — operator review pending)

## What was built

New reusable builder **`scripts/cohort/build-variant-cohort.js`** replacing the
single-source filter pattern of `scripts/cohort/build-fcnr-2026-06-11.js` (which
selected "pack HAS variant slabs" and silently dropped the 13 publish-but-never-
extracted banks, incl. yes-bank-limited).

### Rule

`cohort = inPack ∪ inDomains`, where:

- **inPack** — `pack.banks` where `products.fd[<variant>].slabs.length > 0`
  (pack variant keys: `regular | nre | nro | fcnr | gift`).
- **inDomains** — `data/bank-domains.json` entries that *declare a source* for
  the variant:
  - `rate_pages[<fd key>]` is a non-null URL — key mapping is
    `regular → fd`, else `fd_<variant>` (`fd_nre` / `fd_nro` / `fd_fcnr` /
    `fd_gift`). The scope doc's reference snippet
    (`` `fd_${variant === 'regular' ? '' : variant}` ``) would have produced the
    key `fd_` for regular; corrected to `fd`.
  - **OR** any extraction-hint block whose `fulfills_product` (array *or* bare
    string) names the fd key. Verified against the real registry: this is how
    Axis declares its FCNR PDF (`extraction.fd_image_ocr_fcnr.fulfills_product =
    ["fd_fcnr"]`); registry-wide, `fulfills_product` values seen are
    `fd`, `fd_nre`, `fd_nro`, `fd_fcnr`.

### Gap audit (the operator-visible signal)

`gap = inDomains − inPack`. When non-empty, emitted in the exact scope-doc style:

```
[cohort-audit] N banks publish <variant> per bank-domains but have no pack data:
  - <bank_code>
```

The warning lives inside `buildVariantCohort()` (injectable `warn` sink,
default `console.warn`) so any future caller of the util gets the audit for
free — not just the CLI.

### Interface

- CLI: `node scripts/cohort/build-variant-cohort.js --variant fcnr [--out <file>]`
  - Default out: `data/cohorts/<variant>-refresh-<YYYY-MM-DD>.json` (dated).
  - **Refuses to overwrite** an existing file (exit 2) — existing cohort
    artifacts are never clobbered.
  - Output file shape matches existing cohorts
    (`[{ bank_code, category, state }]`, cf.
    `data/cohorts/fcnr-refresh-2026-06-11.json`) so `scripts/utils/load-cohort.js`,
    run-batch and `scripts/cohort/split.js` consume it unchanged. Category/state
    enrichment reuses the 06-11 builder's approach (output/latest summaries +
    `pm-refresh-2026-q2` backfill).
- Exported: `buildVariantCohort({ variant, pack, domains, warn? })` →
  `{ cohort, inPack, inDomains, gap }` (all sorted bank_code arrays). Also
  exports `domainsKeyFor`, `entryPublishesVariant`, `enrichCohortEntries`,
  `parseArgs`, `VARIANTS`.

## Real-data measurement (variant = fcnr, 2026-07-06, read-only)

Run against the live `pack/dist/rates-pack.json` (578 banks) +
`data/bank-domains.json` (1037 entries):

| set | count |
|---|---|
| inPack (pack has FCNR slabs) | **44** |
| inDomains (registry declares FCNR source) | **54** |
| **cohort (union)** | **57** |
| **gap (publish, no pack data)** | **13** |

Matches the scope doc's 2026-06-16 prediction (44 + 13 = 57) exactly — the gap
has not moved since the audit. Note inDomains (54) < cohort (57): 3 banks have
FCNR slabs in pack without a registry `fd_fcnr` declaration (union keeps them):
barclays-bank-plc, cosmos-co-operative-bank-ltd, natwest-markets-plc — the
reverse gap; candidates for registry backfill.

Gap banks (13):

```
bank-of-ceylon
bank-of-india
cooperatieve-rabobank-ua
dcb-bank-limited
equitas-small-finance-bank-limited
keb-hana-bank
kookmin-bank
nainital-bank-limited
nonghyup-bank
pt-bank-maybank-indonesia-tbk
shinhan-bank
united-overseas-bank-limited
yes-bank-limited
```

Cohort by category: Private (Indian) 21, Foreign 17, PSB 12, SFB 4, NSUCB 3.

For this measurement the output file was written to the session scratchpad,
not `data/cohorts/` — no repo data files were touched. When the operator wants
the real refresh cohort, run the CLI with the default out (or `--out`).

## Tests

`tests/scripts/build-variant-cohort.test.js` — 12 tests, all synthetic
in-memory fixtures (real pack/registry untouched):

- (a) scope-doc synthetic: 5 pack FCNR banks ∪ 7 domains fd_fcnr entries →
  cohort 7, gap lists the 2 extras, warning text asserted verbatim; plus
  pack-only / no-gap / null-URL variants.
- (b) extraction-hint-only bank (`fulfills_product: ["fd_fcnr"]`, no
  `rate_pages.fd_fcnr`) is included; bare-string form honoured; hints for a
  different variant do not leak in.
- (c) variant `regular` maps to `rate_pages.fd` (and does not match
  `fd_fcnr`-only banks).
- Guards: empty `slabs` ≠ pack data; unknown variant throws; malformed
  registry entries; arg parsing.

Results: new file 12/12 pass. Full suite (`node --test --test-force-exit`):
**1521 pass, 0 fail, 44 skipped**.

Known pre-existing issue (not introduced here): `npm test`'s `pretest`
(`scripts/check-write-discipline.js`) fails on 10 exemption-comment violations
in 8 older scripts (e.g. `scripts/cohort/build-fcnr-2026-06-11.js:49`,
`scripts/pack/build-fcnr-only-pack-2026-06-15.js`) — all present at HEAD
before this change. The new builder carries the required
`// safe-write-exempt:` comment and is not flagged.

## Follow-ups (out of scope here)

- Add the gap check to `pack/quality-gate.js` as a soft gate (warn, don't
  block), per the scope doc.
- Retire `build-fcnr-2026-06-11.js` for future refreshes in favour of
  `build-variant-cohort.js --variant fcnr` (kept per keep-useful-scripts
  practice as the 06-11 historical artifact's provenance).
- Sweep the 10 pre-existing write-discipline violations so `npm test` runs
  end-to-end again.
