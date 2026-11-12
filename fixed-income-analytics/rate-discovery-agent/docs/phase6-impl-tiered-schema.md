# Phase 6: Tiered Strategy + Schema Cleanup — Implementation Notes

**Date:** 2026-03-28
**Status:** Complete
**Files created:** `scripts/run-extract-only.js`
**Files modified:** `run-batch.js`, `scripts/extract_rates.js`, `CLAUDE.md`

## Phase 6a: Tiered Agent Strategy

### Problem
Even banks that are fully discovered (config exists, domain known, scraper type classified) still triggered a Claude LLM session for re-extraction. For the 96 already-discovered banks, that's a total waste of tokens.

### Solution

**`scripts/run-extract-only.js`** (new, 80 lines) — Standalone batch extractor that wraps `extract_rates.js --all` with:
- CLI interface matching batch runner pattern (`--scraper-type`, `--limit`, `--bank-code`)
- Header showing config count, filter, "0 tokens" emphasis
- Timing report at the end

Usage:
```
node scripts/run-extract-only.js                         # all 96 banks
node scripts/run-extract-only.js --scraper-type pdf       # only PDF banks
node scripts/run-extract-only.js --scraper-type html_static --limit 10
node scripts/run-extract-only.js --bank-code citibank-na
```

**`run-batch.js` — `--extract-only` flag** — When set:
- Skips LLM entirely for all banks
- For each bank in the CSV: check if `_config.json` exists
  - If yes → call `extract_rates.js` directly (Tier A/B/C)
  - If no → skip with message "needs LLM discovery first"
- Prints `Mode: EXTRACT-ONLY (no LLM, 0 tokens)` in header
- Early exit after extract-only loop (doesn't enter sequential/parallel paths)

This enables the workflow:
1. First pass: `node run-batch.js banks.csv --category "Foreign Bank"` — LLM discovers all banks
2. Recurring: `node run-batch.js banks.csv --category "Foreign Bank" --extract-only` — refresh rates, 0 tokens

### Tier Routing in Practice

With `--extract-only`, the effective tiering is:
- **Banks with config** → Tier A/B/C (direct extraction, 0 tokens)
- **Banks without config** → skipped (flagged for future LLM discovery)

Without `--extract-only`, all banks go through LLM discovery (Tier D/E), but `--resume` skips already-succeeded ones.

A future enhancement could auto-detect the tier per bank within a single batch run (LLM for unknown, extract for known), but the current two-pass approach is simpler and explicit.

## Phase 6b: Config Schema Simplification

### Changes

**`scripts/extract_rates.js`** — Now calls `mergeWithDefaults(rawConfig)` when reading configs. This means configs can omit fields that match their defaults (tenure_parser, rate_multiplier, senior_citizen_premium, deposit_insurance, update_frequency). The extractor fills them in automatically.

**`CLAUDE.md`** — Updated config schema example to annotate optional fields with `// optional, default: <value>`. Added a "Fields with defaults" section explaining which fields can be omitted.

### Impact
Future agent runs can write shorter configs (skip boilerplate fields), saving a few tokens per config write. Existing configs continue to work unchanged (mergeWithDefaults is additive — it doesn't remove existing fields).

## Phase 6c: Unified Multi-Table Schema

### Changes

**`scripts/extract_rates.js`** — After extraction, every slab gets `deposit_range: "below_3cr"` if not already set. This is the default for retail deposits (< Rs 3 crore).

**`CLAUDE.md`** — Added "Deposit range" section documenting standard values:
- `"below_3cr"` — retail (default)
- `"3cr_to_5cr"`, `"5cr_to_25cr"`, `"25cr_to_100cr"`, `"above_100cr"` — bulk tiers
- `"below_15l"`, `"15l_to_1cr"`, `"1cr_to_10cr"`, `"above_10cr"` — co-op tiers

### Alignment with Database Schema
The `deposit_range` field maps to the existing `min_deposit_for_slab` / `max_deposit_for_slab` fields in `packages/shared/src/schemas/rate.ts:22-23`. The `deposit_range` string is a human-readable label; the numeric fields provide precise bounds. The ingestion pipeline can derive one from the other.

### Future Enhancement
When the Playwright script supports `--tabs` extraction (Phase 5a), each tab's data could be labeled with a different deposit_range (e.g., tab "Below 3 Cr" → `below_3cr`, tab "3-5 Cr" → `3cr_to_5cr`). This isn't automated yet but the schema supports it.

## Testing

| Test | Command | Result |
|------|---------|--------|
| Extract-only script | `run-extract-only.js --scraper-type html_static --limit 2` | Bandhan 24 slabs, Bank of Ceylon 9 slabs |
| Batch --extract-only | `run-batch.js ... --extract-only --limit 2` | Axis (Playwright), Bandhan (HTML) |
| deposit_range present | Check bandhan-bank-limited_rates.json | `"deposit_range": "below_3cr"` on all slabs |
| mergeWithDefaults | Extract with minimal config | Fills tenure_parser, rate_multiplier defaults |
| Syntax | `node -c` on all files | All OK |
