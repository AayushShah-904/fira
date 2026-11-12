# K — Best-per-variant chooser + PM pack delivery (2026-06-11)

**Phase:** Sprint 010 Extension 2 — final pack-quality pass before sprint close.
**Trigger:** PM requested latest rates ASAP with FCNR focus. Operator pushed for "best quality + recent slabs per variant", not bank-scoped recovery.
**Outcome:** **9,202-slab pack** (gate PASS, +9.95% over 8,369 floor), zipped at `pack/rates-pack-2026-06-11.zip`, PM brief + FCNR CSV/JSON delivered.

## Why this phase was needed

The K-step recovery work documented in `K-cohort-post-results-2026-06-09.md` operated bank-wide — for the 7 R3-class banks + 29 sub-threshold banks, it restored ALL variants of the regressed bank from HEAD (or pack reconstruction for `head_none`). That was correct for the regression class it targeted (banks where the cohort had destroyed more than it added), but it created a new class of micro-regressions:

- `icici-bank-limited/fcnr`: cohort produced 13 slabs scraped 2026-06-09 (fresher and slightly richer than the prev 12-slab disk snapshot); bank-wide HEAD restore overwrote it with the older 12-slab version.
- `mizuho-bank-ltd`: similar shape (cohort variant was unambiguously better).

A per-bank recovery is too coarse when the cohort regressed only some variants. A per-(bank, variant) chooser scoped to **quality+freshness** signals catches these cases.

## What the chooser does

`scripts/recovery/best-per-variant-2026-06-11.js`:

For each `(bank_code, variant)` pair across all known banks (585 banks × 5 variants = 2,925 pairs), compares candidates from:

| Source | Why included |
|---|---|
| `output/latest/<file>` | Current disk state (baseline) |
| `git HEAD:./output/latest/<file>` | Last committed verified state |
| `pack/dist/rates-pack.json` | Current published denormalization |
| `pack/dist-staging-550ptm4/rates-pack.json` | Raw 2026-06-09 cohort output — freshest scrapes |
| `pack/dist-staging-550ptm4-fullrecovered/rates-pack.json` | Post-K recovery state |
| `pack/history/rates-pack-2026-05-14.json` | 28-day-old historical pack |
| `pack/history/rates-pack-2026-04-16.json` | 56-day-old historical pack |

Then applies **two narrow decision rules** — correctness-first, never trading slab count for freshness:

### Rule A — FILL_EMPTY

Triggers when the disk slot is empty or missing. Accepts candidates that meet **all** of:

- `extraction_confidence === 'high'` (rejects medium/low/unknown sources)
- `scraped_at` present and within 90 days
- Picks the freshest; ties broken by `SOURCE_PRIORITY` (HEAD → pack:cur → pack:stg-fullrec → pack:stg-cohort → pack:2026-05-14 → pack:2026-04-16)

### Rule B — SAFE_REPLACE

Triggers when disk has data. Accepts alternatives that meet **all** of:

- `confRank(alt) >= confRank(disk)` (same or higher confidence)
- `alt.rate_slabs.length >= disk.rate_slabs.length` (no slab loss)
- `alt.scraped_at > disk.scraped_at` (strictly fresher)

Pick the best by (higher conf → more slabs → fresher → source priority).

### Rule design — explicit non-criteria

- **Slab count is not a quality signal.** Operator feedback during this phase: "the number of slabs itself is not the criteria for quality — correctness is." Slab count is used only as a "don't lose data" guardrail in rule B, never as a positive scoring signal.
- **Excludes manifest is respected.** `output/latest/_pack_excludes.json` quarantined (bank, variant) pairs (Bank of Ceylon NRE/NRO/FCNR — mislabeled Sri Lankan data; NHB Sunidhi — defunct scheme; etc.) are skipped before scoring.
- **Provenance preserved.** Every written file gets `_best_per_variant_picked: { picked_at, picked_from, rule, reason }`.

## Outcome

| Metric | Value |
|---|---:|
| `(bank, variant)` pairs considered | 623 |
| FILL_EMPTY picks | 19 (writes: 19, blocked: 0) |
| SAFE_REPLACE picks | 30 (writes: 30, blocked: 0) |
| Total writes | 49 |
| Net slab delta to disk | +195 |
| Pack pre-chooser | 9,064 slabs |
| Pack post-chooser | **9,202 slabs** (gate PASS, +9.95% vs 8,369 floor, 0 high-conf regressions) |

### FILL_EMPTY sources

| Source | Count |
|---|---:|
| pack:2026-05-14 | 15 |
| pack:cur | 2 |
| pack:2026-04-16 | 2 |
| HEAD | 1 (NHB regular — blocked by exclude before write) |

Notable fills: IBU regulars (HSBC, SBI, PNB, BOI, Axis, Standard Chartered) and AmEx India regular, Ujjivan SFB FCNR (5 slabs USD), 3 co-op banks.

### SAFE_REPLACE sources

| Source | Count |
|---|---:|
| pack:stg-cohort | 16 |
| pack:2026-05-14 | 12 |
| HEAD | 2 |

Notable replaces: icici FCNR (12 high/19d → 13 high/2d), Mizuho regular, Union Bank regular/NRE/NRO, UCO Bank regular/NRO, DBS Bank India variants.

## FCNR coverage delta

| Metric | Pre-chooser (9,064 pack) | Post-chooser (9,202 pack) |
|---|---:|---:|
| FCNR banks in pack | 43 | **44** |
| Total FCNR slabs | 1,150 | **1,157** |
| FCNR banks fresh ≤30d | 37 | **39** |
| FCNR banks stale 31–90d | 6 | 5 |

The +1 bank is Ujjivan SFB FCNR (fill from May-14 pack, 5 USD slabs).

## Two bugs found + fixed during the run

1. **Synthetic `extraction_method` rejected by safe-write.** Initial chooser set `extraction_method: 'reconstructed_from_pack'` for pack-source picks. `lib/safe-write.js` enforces a closed allowed list (`automatic_html_static`, `llm_inline_extraction`, etc., plus `stale_needs_refresh` / `pending_*`). Pack denormalization itself drops `extraction_method` (verified empirically against `pack/history/rates-pack-2026-05-14.json`). Fix: fall back to `'stale_needs_refresh'` for pack-source picks — semantically honest ("rate values came from a prior pack; needs a fresh scrape to recover the true extraction method") and accepted by safe-write.

2. **Bank-scoped HEAD restore overwrote fresher cohort variants.** Documented above; the chooser is the structural fix.

## PM deliverables

| File | Size | Purpose |
|---|---:|---|
| `pack/rates-pack-2026-06-11.zip` | 252 KB | Bundle: `rates-pack.json` + `rates-pack.schema.json` + `README.md` |
| `output/pm-2026-06-11/PM-BRIEF-2026-06-11.md` | 4 KB | PM-facing summary, FCNR citations, caveats |
| `output/pm-2026-06-11/fcnr-rates-2026-06-11.csv` | 208 KB | 1,157 rows, ISO-normalized currencies |
| `output/pm-2026-06-11/fcnr-banks-2026-06-11.json` | 424 KB | Full FCNR subset of pack, 44 banks |

PM caveats embedded in brief: 134 banks lack `scraped_at` (HEAD-restored historical state); 5 FCNR banks are 31–90d (HDFC 73d / unknown confidence is the worst — flagged "avoid citing without refresh"); Bank of Ceylon FCNR quarantined.

## Files added / modified

**Created:**
- `scripts/recovery/best-per-variant-2026-06-11.js`
- `logs/sprint-010/best-per-variant-v2-2026-06-11.json` (decision audit)
- `logs/sprint-010/fcnr-coverage-2026-06-11.json` + `-v2.json`
- `output/pm-2026-06-11/PM-BRIEF-2026-06-11.md` + 2 attachments
- `pack/rates-pack-2026-06-11.zip`
- This doc.

**Modified:**
- 49 `output/latest/<bank>_<variant>_rates.json` files via safeWriteArtifact (source=operator) with `_best_per_variant_picked` provenance.
- `pack/dist/rates-pack.json` (rebuilt and promoted from `pack/dist-staging-best-per-variant/`)
- `pack/dist/{rates-pack.schema.json, README.md, QUALITY-GATE.json, REPORT.md}` (rebuilt alongside)

## What this closes

- The icici-fcnr regression flagged in `K-cohort-post-results-2026-06-09.md`.
- The bank-scoped-HEAD-restore overshoot pattern surfaced during recovery.
- The PM's "best rates last month with FCNR focus" ask.

## What this carries to Sprint 011

- Currency-code normalization in the pack itself (currently only normalized in the CSV view): "EURO" → "EUR", "YEN" → "JPY".
- HDFC FCNR refresh — 73 days old / unknown confidence; one-bank smoke `node run-discovery.js hdfc-bank-limited --variant fcnr --keep-attempts` recommended.
- Pack denormalization should preserve `extraction_method` so future pack-reconstruction picks can carry the real method instead of `stale_needs_refresh`.
- A regression test for the chooser's "don't trade slab count for freshness" guardrail.
