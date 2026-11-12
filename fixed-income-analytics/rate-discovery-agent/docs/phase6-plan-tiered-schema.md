# Phase 6: Tiered Strategy + Schema Cleanup — Plan

**Date:** 2026-03-28
**Status:** Planning
**Depends on:** All prior phases

## Goal

Skip the LLM entirely for banks with known domains and scraper types. Clean up config schema (strip defaults). Add deposit_range field for multi-table banks.

## Phase 6a: Tiered Agent Strategy

**Files to create:** `scripts/run-extract-only.js`
**Files to modify:** `run-batch.js`

### Tier Classification

| Tier | Criteria | Action | Cost |
|------|----------|--------|------|
| A | Known domain + html_static in bank-domains.json + config exists | Skip LLM, run extract_rates.js | 0 tokens, ~30s |
| B | Known domain + html_js + config exists | Skip LLM, run extract_rates.js | 0 tokens, ~1min |
| C | Known domain + pdf + config exists | Skip LLM, run extract_rates.js | 0 tokens, ~30s |
| D | In bank-domains.json but no config | LLM discovery | 8-12K tokens |
| E | Unknown (not in bank-domains.json) | Full LLM discovery | 15-20K tokens |

### run-batch.js Changes

Add `--extract-only` flag that skips LLM and runs extraction directly for Tier A/B/C banks:
- Load `data/bank-domains.json`
- For each bank: check if config exists AND bank is in domains file
- If yes → Tier A/B/C → call `scripts/extract_rates.js` directly
- If no → Tier D/E → run normal discovery via run-discovery.js

### `scripts/run-extract-only.js` — Standalone Batch Extractor

CLI:
```
node scripts/run-extract-only.js                     # all banks with configs
node scripts/run-extract-only.js --scraper-type pdf   # only PDF banks
node scripts/run-extract-only.js --bank-code sbi      # specific bank
```

This is essentially a thin wrapper around `extract_rates.js --all` but with batch reporting, timing, and a proper summary. Useful for periodic re-extraction (the recurring scraper use case).

## Phase 6b: Config Schema Simplification

**Files to modify:** `scripts/extract_rates.js` (use mergeWithDefaults when reading), `CLAUDE.md`

- When the extractor reads a config, apply `mergeWithDefaults()` to fill missing fields
- Update CLAUDE.md to note which fields are optional with defaults
- This means future agent runs can omit boilerplate fields, saving a few tokens per config

No migration of existing files (too risky, minimal benefit).

## Phase 6c: Unified Multi-Table Schema

**Files to modify:** `CLAUDE.md`, `scripts/extract_rates.js`

- Add `deposit_range` field to rate_slabs
- Standard values: `"below_3cr"` (default), `"3cr_to_5cr"`, etc.
- When extractor writes slabs, set `deposit_range: "below_3cr"` as default
- Update CLAUDE.md schema example
- Aligns with existing `min_deposit_for_slab`/`max_deposit_for_slab` in packages/shared/src/schemas/rate.ts

## Verification

- `node scripts/run-extract-only.js --scraper-type pdf` → PDF banks get rates
- `node scripts/run-extract-only.js --limit 5` → 5 banks extracted, 0 tokens
- `node scripts/extract_rates.js dhanlaxmi-bank-limited` → rates have deposit_range field
- Config reads work with missing optional fields (mergeWithDefaults)
