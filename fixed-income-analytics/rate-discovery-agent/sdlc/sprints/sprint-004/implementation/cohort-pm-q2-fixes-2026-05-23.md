# Implementation — pm-q2 cohort #3 prep fixes (2026-05-23)

> Five fixes from `cohort-pm-q2-handoff-2026-05-23.md` shipped in this
> session. Test suite green at 836 pass / 1 skip / 0 fail (was 827). Pack
> rebuilds cleanly; quality-gate's "bank dropped from pack" findings for
> the 4 slug-alias banks have cleared.

## Fix #6 — IDFC-First Orch-2 HTML hint

**Discovery during work**: the handoff assumed `/nri-banking/nri-fixed-deposit/`
was a combined NRE+NRO page. Web verification 2026-05-23 showed that page
is a marketing landing (Playwright found 0 tables); the **main FD page**
`/personal-banking/deposits/fixed-deposit/fd-interest-rates` is the actual
combined source — its table[0] header reads "Interest Rates for Domestic /
NRO / NRE Fixed Deposits of less than ₹3 Crore w.e.f. 18th April 2026".

**Change**: added `extraction.fd` block to `data/bank-domains.json` with
`type: "html"`, `fulfills_product: ["fd", "fd_nre", "fd_nro"]`. Same pattern
as the existing entry at lib/extraction-hint.js's `findHintedHtmlUrl`
consumer.

**Verification**: registry parses; Orch-2 resolver returns the fd URL for
both `fd_nre` and `fd_nro` product iterations.

## Fix #7 — Registry URL refresh

Three banks investigated. Each had a different actual issue, not just a
URL drift:

- **chennai-central-co-operative-bank-ltd** — registry pointed at
  `ccb.bank.in` but that domain actually serves Contai Co-operative Bank
  (verified by fetching the homepage 2026-05-23). The cohort #1 "11 slabs"
  result was Contai's rates mis-attributed to Chennai Central. Real site
  `ccbankchennai.com` is ECONNREFUSED. Registry updated to the correct
  domain, `scraper_type: "manual"`, `status: "site_unreachable"`. The 0
  slabs from cohort #2 is now the correct result, not a regression.

- **tamil-nadu-grama-bank** — registry pointed at
  `/deposits/regular/stda` (a product-description page with zero rates).
  TNGB publishes rates as a dated JPEG image (`Deposit-interest-rate-060526.jpeg`)
  linked from `/interest-rates`, opened in a popup. Registry now has
  `rate_pages.fd = "/interest-rates"` (canonical landing) plus
  `rate_pages.fd_image_ocr = "<jpeg path>"` with an `extraction.fd_image_ocr`
  hint of type `image_ocr`. Caveat: filename is date-stamped, will need
  refresh on each rate revision.

- **nabard** — no change needed. NABARD entry has
  `status: "no_retail_deposits"` and `scraper_type: "manual"`; the 5 slabs
  in cohort #1 were a spurious extraction of refinance/lending rates, the
  0 in cohort #2 is correct.

## Fix #9 — Slug-alias registry layer

Investigation found that **all four** flagged pairs already had alternate
entries in `data/bank-domains.json` (the Nellore alias was the
RBI-official-name form; the others had `the-` prefix or `-mumbai` suffix
duplicates). A bonus fifth alternate was found: a unicode-non-breaking-hyphen
spelling of `nkgsb-co-operative-bank-ltd-mumbai` that would never match an
ASCII-hyphen runtime slug.

**Implemented**:

- New `data/bank-slug-aliases.json` — single source of alternate→canonical
  mappings, plus inline docs about when to add an entry.
- New `lib/slug-aliases.js` — `aliasToCanonical(slug)` resolver with a
  module-level cache and a `resetCacheForTests()` hook.
- `pack/build-pack.js` patched at all four slug-derivation points
  (`slugFromRateFile`, `loadPartialSilent`, `loadLegacy` config/rates
  branches, `toEntry`'s `bank_code` assignment). Added a
  rateSourceIsAlias tiebreaker so a canonical-named file always wins over
  an alias-named file when both exist in `output/latest/`.
- `scripts/quality-gate.js` patched — `canonicalizePackSlugs` rewrites
  `bank_code` on every entry of both new and baseline packs before
  totalsByBank runs; `loadPartialSilentSet` also canonicalizes; accepts
  list keys are canonicalized at load.
- Registry de-duplicated — removed `the-zoroastrian-co-operative-bank-ltd`,
  `the-ahmedabad-mercantile-co-operative-bank-ltd`,
  `nkgsb-co-operative-bank-ltd-mumbai`, and a unicode-hyphen variant.
  NKGSB canonical entry merged in `savings: "/savings-deposit.php"` and
  `fd_nre: "/nre-term-deposit-rates.php"` from the deleted entries.

**Verification**: pack-build emits canonical slugs for all five affected
banks (NKGSB+canonical, zoroastrian, ahmedabad-mercantile-co-op,
sri-potti-sriramulu-nellore-...). Quality-gate output shows the four
"bank dropped from pack" findings are gone; remaining flags
(ahmedabad-mercantile NRE 3→0, NKGSB senior_below_general anomaly) are
real data-quality issues unrelated to the slug problem.

**Tests**: new `tests/lib/slug-aliases.test.js` covering known aliases,
pass-through behaviour, defensive null/undefined handling, and alias-map
load.

## Fix #8 — Small-table scoring tweak (special-scheme tables)

**Root cause**: the gate dropping these tables wasn't a scoring issue but
a downstream filter in `extract_html_table.js` at the multi-table
accumulator — when `withTenure < candidateSlabs.length / 2` the table was
silently dropped. Small special-scheme tables (RAP30 / FD365 / NAVATHI-900 /
400-day-URP) have scheme-name labels in column 0 that don't parse as
tenures, so they always tripped this filter even though they're genuine
rate emissions.

**Change**: added `isSmallSchemeTable` heuristic — a table is kept
through the filter when it has 4–10 candidate slabs, none parse as
tenures, **and** every slab's `tenure_text` contains a digit (the
distinguishing signal vs noisy text-only "Eligibility / Premature
closure / Penalty" callouts). Slabs from these tables emit with
`tenure_min_days: null, tenure_max_days: null` and the scheme label
preserved in `tenure_text`. New warning `special_scheme_table: kept …`
makes the decision visible.

**Tests**: two new fixtures in `tests/lib/actions/extract_html_table.test.js`
— positive case (RAP/FD scheme labels kept) and negative case (text-only
labels still filtered as noise). Smoke-verified against a constructed
Citizen Credit Bank shape (8 standard + 6 scheme rows): now ships 11
slabs total (was 5 in the standard-only path).

## Fix #5 — Mashed-cell FCNR recovery

**Investigation outcome**: the previous FCNR Fix #1 / #1c work
(currency-count-ranked picker + col-0/1 currency scan) already restored
Canara / IDBI / City Union / Punjab-Sind / Dhanlaxmi / Karnataka to baseline
or better — only **PNB** still showed an FCNR regression (current
output/latest/punjab-national-bank_fcnr_rates.json is from 2026-05-22
pre-Fix-#1c with all 21 slabs mis-tagged USD; cohort #2 attempt for the
FCNR variant explicitly marked extraction_failed and left the old file).

The root cause is the one the handoff predicted: cheerio's `readTableRows`
did not expand `rowspan` or `colspan` and treated nested `<table>`
elements as part of the outer table's row list. PNB's FCNR layout uses
rowspan on the currency column ("USD" spans 3 tenure rows) so the
post-extraction picker saw rows of inconsistent length and could not
align cells. The picker's currency check then either missed the currency
markers (mashed cells) or matched only one currency (a stray legend
mention) and selected the wrong table.

**Change**: rewrote `readTableRows` in `lib/actions/_cheerio_tables.js`:

1. Skip trs that belong to a nested `<table>` (closest-table check).
2. Skip th/td that live inside a nested table.
3. Expand `colspan` by writing the cell text into `colspan` consecutive
   grid columns.
4. Track active `rowspan`s in a column→{value, remaining} map; pre-fill
   the carry-over values at the start of each subsequent row before
   writing DOM cells. After consuming DOM cells, drop any rowspan-carry
   into the row's tail at its column position.
5. Cosmetic: fill undefined holes with `''` so consumers see
   length-consistent rows (needed for the column-count signal in
   `scoreTable`).

**Tests**: three new `tests/lib/actions/_cheerio_tables.test.js` cases
covering the rowspan PNB pattern, the colspan two-currency header
pattern, and the nested-`<table>` exclusion.

**Limitations / followup**: cannot fully validate against the live PNB
page from this dev machine — Playwright returned 0 tables on
`https://pnb.bank.in/Interest-Rates-Deposit.html` (likely Norton TLS MITM
on this host or a WAF block; same class as
`reference_norton_tls_mitm.md`). Integration validation lands during
cohort #3 — expect PNB FCNR to recover from 0 (the new picker's reject)
to 25-30 slabs across 5-6 currencies. If cohort #3 still shows 0 slabs
for PNB FCNR, the fallback is Option B (Playwright + Azure DI Layout OCR
pipeline) which is the strategy the next session can pick up.

## Test deltas

| | before | after |
|---|---|---|
| test count | 828 (827 pass / 1 skip) | 837 (836 pass / 1 skip) |
| new files | — | `tests/lib/slug-aliases.test.js`, plus 5 new test cases inside `_cheerio_tables.test.js` and `extract_html_table.test.js` |

## Pack delta (no cohort #3 yet — same `output/latest/`)

| | before | after |
|---|---|---|
| banks | 513 | 513 |
| slabs | 8250 | 8250 |

Slab count unchanged is expected — none of these fixes mutate the
already-extracted artifacts in `output/latest/`. The fixes change what
the **next** cohort run produces and how the pack-builder canonicalizes
slugs. Cohort #3 is the validation point.

## Cohort #3 next steps (unchanged from handoff)

```bash
node --test --test-force-exit
node scripts/cleanup-output-latest.js --snapshot pre-pm-q2-cohort-2026-05-23-v3 --write
node run-batch.js --cohort pm-refresh-2026-q2 --concurrency 3 --path orchestrator
node pack/build-pack.js
node scripts/run-dual-gate.js
```

Acceptance per handoff:
- April-16 gate: PASS or PASS_WITH_WARNINGS
- Pack: ≥ 8400 slabs (cohort #1 was 8269; expected +200-400 from this work)
- No regression on axis/hdfc/sbi/kotak FCNR control banks
