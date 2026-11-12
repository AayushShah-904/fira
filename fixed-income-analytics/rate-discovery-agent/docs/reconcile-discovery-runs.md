# Reconcile Old and New Discovery Runs

## Problem

Discovery output lives in **three locations** with overlapping, inconsistent data:

| Location | Configs | Role |
|----------|---------|------|
| `output/` | 99 | Original first-wave runs (before pipeline existed). Stale snapshot. |
| `output/latest/` | 221 | Pipeline's working set. Superset of `output/` + newer batch/pipeline runs. |
| `output/runs/` | per-run | Timestamped directories with traces. Source of truth for individual runs. |

All 99 files in `output/` also exist in `output/latest/` (15 differ because the pipeline re-ran those banks and updated `latest/` only). The `output/` root is essentially a stale leftover.

Within `output/latest/`, 22 old-slug files coexist with 199 new-slug files:

1. **Pipeline blindness**: `run-pipeline.js` slugifies CSV bank names → produces hyphenated slugs → never matches old underscore slugs → treats those banks as `PENDING` → re-discovers from scratch ($0.46 each, wasted)
2. **Duplicate entries**: 7 banks have both old and new configs (SBI, HDFC, Axis, BoB, Airtel, Capital SFB, Cosmos)
3. **Lost data**: 15 banks exist ONLY as old slugs — their websites, URLs, scraper types, selectors, and rate data would be ignored

## What old configs have that's valuable

Each old config contains (verified by inspecting `au_small_finance`, `sbi`, `hdfc` etc.):
- `website` — confirmed official domain
- `rate_page_urls.fd` — validated FD rate page URL
- `scraper_type` — classified (html_js, html_static, pdf)
- `selectors` + `column_mapping` — CSS selectors for deterministic extraction
- `scraper_notes` — framework, bot protection, table count, data format
- `notes` — detailed human-readable observations (e.g., "WAF blocks HTTP, Playwright works")

**What's missing from old configs:** `fd_nre`, `fd_nro`, `fd_fcnr` URLs (NRI discovery wasn't run)

## Solution: `scripts/reconcile-runs.js`

A one-time (re-runnable) reconciliation script that:

### Step 1: Rename old-slug files to new slugs

For each old-slug config in `output/latest/`:
1. Read the config, get `bank_name`
2. Derive the canonical slug via `slugify(bank_name)`
3. If canonical slug differs from current filename slug → **rename** all files for that bank:
   - `{old}_config.json` → `{new}_config.json`
   - `{old}_rates.json` → `{new}_rates.json`
   - `{old}_nre_rates.json` → `{new}_nre_rates.json` (if exists)
   - `{old}.log`, `{old}.summary.json`, `{old}.trace.jsonl` (if exist)
4. Update `bank_code` inside the config and rate JSONs to match the new slug

### Step 2: Merge duplicates (7 banks)

When both old and new configs exist for the same canonical slug:
1. **New config wins** — it has NRI URLs, richer scraper_notes, more detail
2. **Merge from old** — fill any fields that are `null` in new but populated in old:
   - `selectors` (old SBI has CSS selectors; new SBI has `null`)
   - `column_mapping` (same)
   - Scraper notes details not in new
3. **Archive old** — move old files to `output/archive/{old_slug}/`

### Step 3: Mark completeness

Add a `discovery_completeness` field to each config:

```json
"discovery_completeness": {
  "domestic_fd": true,      // has rate_page_urls.fd
  "nri_searched": false,    // NRI discovery was never run
  "nre": null,              // null = not searched, true = found, false = searched & not found
  "nro": null,
  "fcnr": null,
  "gift": null              // IBU only
}
```

Derivation logic:
- `domestic_fd`: `true` if `rate_page_urls.fd` is non-null
- `nri_searched`: `true` if any of `fd_nre`, `fd_nro`, `fd_fcnr` is explicitly set (even to `null` meaning "searched, not found"); `false` if the fields are missing entirely (never searched)
- Individual NRI fields: `true` if URL present, `false` if explicitly `null`, omit if never searched

### Step 4: Mark rate staleness

Add `data_freshness` to each config:

```json
"data_freshness": "stale"   // "current" | "stale" | "demo_only"
```

- `current`: scraped_at within --max-age (default 7 days)
- `stale`: scraped_at older than --max-age but rates were successfully extracted
- `demo_only`: rates exist but may be outdated; usable for UI development

### Step 5: Rebuild bank index

After all renames/merges, run `buildIndexFromFilesystem()` (or `node run-pipeline.js banks.csv --rebuild-index --dry-run`) to regenerate `_bank_index.json` with canonical slugs.

## Old → New Slug Mapping

| Old Slug | New Slug (canonical) | Has New? | Action |
|----------|---------------------|----------|--------|
| `sbi` | `state-bank-of-india` | Yes | Merge (old has selectors) |
| `hdfc` | `hdfc-bank-limited` | Yes | Merge |
| `axis_bank` | `axis-bank-limited` | Yes | Merge |
| `bank_of_baroda` | `bank-of-baroda` | Yes | Merge |
| `airtel_payments` | `airtel-payments-bank-limited` | Yes | Merge |
| `capital_sfb` | `capital-small-finance-bank-limited` | Yes | Merge |
| `cosmos_coop` | `cosmos-co-operative-bank-ltd` | Yes | Merge |
| `au_small_finance` | `au-small-finance-bank-limited` | No | Rename |
| `equitas_sfb` | `equitas-small-finance-bank-limited` | No | Rename |
| `esaf_sfb` | `esaf-small-finance-bank-limited` | No | Rename |
| `fino_payments` | `fino-payments-bank-limited` | No | Rename |
| `ippb` | `india-post-payments-bank-limited` | No | Rename |
| `jana_sfb` | `jana-small-finance-bank-limited` | No | Rename |
| `jio_payments` | `jio-payments-bank-limited` | No | Rename |
| `nsdl_payments` | `nsdl-payments-bank-limited` | No | Rename |
| `paytm_payments_bank` | `paytm-payments-bank-limited` | No | Rename |
| `shivalik_sfb` | `shivalik-small-finance-bank-limited` | No | Rename |
| `slice_sfb` | `slice-small-finance-bank-limited` | No | Rename |
| `suryoday_sfb` | `suryoday-small-finance-bank-limited` | No | Rename |
| `ujjivan_sfb` | `ujjivan-small-finance-bank-limited` | No | Rename |
| `unity_sfb` | `unity-small-finance-bank-limited` | No | Rename |
| `utkarsh_sfb` | `utkarsh-small-finance-bank-limited` | No | Rename |

**Note:** The canonical slug is derived from `bank_name` inside each config via `slugify()`.

## Script Design

```
scripts/reconcile-runs.js [--dry-run] [--archive-dir output/archive]

Flags:
  --dry-run         Show what would happen without changing files
  --archive-dir     Where to move superseded old files (default: output/archive)
  --rebuild-index   Rebuild _bank_index.json after reconciliation
```

### Implementation (~200 lines)

```
1. Scan output/latest/*_config.json
2. For each config:
   a. Read JSON, extract bank_name
   b. Derive canonical_slug = slugify(bank_name)
   c. If filename_slug !== canonical_slug → mark for rename
3. Group by canonical_slug to find duplicates
4. For renames (no duplicate): rename files, update bank_code in config
5. For merges (duplicate):
   - Load both configs
   - Use new-slug config as base
   - Fill null fields from old-slug config (selectors, column_mapping, notes)
   - Add discovery_completeness
   - Write merged config under canonical slug
   - Archive old-slug files
6. For all configs: add discovery_completeness if missing
7. Rebuild index if --rebuild-index
8. Print summary: renamed, merged, unchanged, errors
```

### Merge Rules (Step 5 detail)

When merging old into new:
- **New wins**: bank_code, bank_name, bank_type, website, scraper_type, rate_page_urls, discovery_metadata
- **Old fills nulls**: selectors (if new is null/empty), column_mapping (if new is null), expected_slab_count (if new is null)
- **Concatenate**: notes (append old notes if different), scraper_notes (merge objects, new wins per-key)
- **Never downgrade**: if new has NRI URLs, keep them; don't overwrite with old's missing fields

## Clean up `output/` root

The 99 files in `output/` (root) are a stale subset of `output/latest/`. After reconciliation:
1. Move stale-only files (`output/*.pdf`, `output/*.log`, `output/_batch_results*.json`) to `output/archive/first-wave/`
2. Delete `output/*_config.json` and `output/*_rates.json` that are identical to their `output/latest/` counterparts
3. For the 15 that differ — they're older versions; archive them too since `output/latest/` has the updated versions

This leaves `output/` with only: `latest/`, `runs/`, `archive/`.

## Also update: `data/bank-domains.json`

Check `data/bank-domains.json` for old-slug keys and rename to canonical slugs. Partially done in commit cc7025a but may have missed some.

## Verification

1. `node scripts/reconcile-runs.js --dry-run` — preview all renames and merges
2. `node scripts/reconcile-runs.js` — execute
3. `ls output/latest/*_config.json | grep '_[a-z]' | grep -v '^.*-.*_config'` — should return 0 old-slug files
4. `node run-pipeline.js banks.csv --rebuild-index --dry-run --limit 30` — verify all reconciled banks show as STALE (not PENDING)
5. Spot-check merged configs (SBI, AU SFB) — verify selectors, NRI URLs, completeness fields all present
6. Spot-check rate files — verify bank_code updated, rates intact

## Impact on Azure OpenAI Redesign

This reconciliation is **independent** of the Azure OpenAI migration — it cleans up the output data layer, not the agent layer. Should be done **before** the migration so the pipeline starts clean. The `discovery_completeness` field can later be used by `run-pipeline.js` to route banks to NRI expansion mode when `nri_searched` is `false`.
