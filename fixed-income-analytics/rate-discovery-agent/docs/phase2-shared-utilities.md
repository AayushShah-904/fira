# Phase 2: Shared Utility Scripts — Implementation Notes

**Date:** 2026-03-28
**Status:** Complete
**Files created:** 5 new files in `rate-discovery-agent/scripts/utils/`
**Files modified:** `run-discovery.js`, `run-batch.js`

## Problem

Deterministic logic (slug generation, tenure parsing, rate validation) was either:
- Duplicated inline across multiple files (slugify appears in `run-discovery.js`, `run-batch.js`, and `packages/api/src/lib/helpers.ts`)
- Performed by the LLM during discovery (tenure text parsing, rate validation), wasting tokens on rule-based operations
- Not available as standalone tools for the upcoming extraction pipeline

## Files Created

### `scripts/utils/slugify.js`
- CommonJS port of `packages/api/src/lib/helpers.ts:slugify()`
- Exact same algorithm: lowercase → strip non-word chars → hyphens → collapse → trim
- Supports CLI mode: `node scripts/utils/slugify.js "HDFC Bank Limited"` → `hdfc-bank-limited`
- Exported as `{ slugify }`

### `scripts/utils/parse-tenure.js`
- CommonJS port of `packages/shared/src/constants/tenure-maps.ts`
- Contains all 23 `TENURE_PRESETS` (exact copy from TypeScript source)
- Contains `TENURE_UNIT_DAYS` multiplier map (day=1, week=7, month=30, year=365)
- `parseTenure(text)` function handles:
  - Preset lookup (exact match on common patterns)
  - Single value: "444 days" → `{minDays: 444, maxDays: 444}`
  - Range: "7 days to 14 days" → `{minDays: 7, maxDays: 14}`
  - "above X" modifier: adds +1 to minDays
  - "less than X" modifier: subtracts -1 from maxDays
  - "X and above" pattern: sets maxDays to 3650 (10 years cap)
- Returns `null` on parse failure (caller flags for manual review)
- CLI mode: `node scripts/utils/parse-tenure.js "1 year to less than 2 years"` → `{"min_days":365,"max_days":729}`

**Note:** Added the "X and above" pattern (e.g., "5 years and above") which exists in `TENURE_PRESETS` but wasn't handled by the regex parser in the TypeScript source. This covers banks that use open-ended tenure descriptions.

### `scripts/utils/validate-rates.js`
- `validateRate(pct, type)` — checks a single rate against bounds
  - general: 1.50%–9.50% (lowered from 2.50% to accommodate foreign banks like Citibank at 1.75%)
  - senior/super_senior: 1.50%–10.50%
- `validateSlabs(slabs)` — validates an entire rate_slabs array:
  - Per-slab rate bounds check
  - Senior >= general check
  - Tenure min ≤ max check
  - Tenure continuity check (non-overlapping, sequential)
- Returns `{ valid, warnings[], errors[] }` — errors are structural problems, warnings are data quality flags
- CLI mode: `node scripts/utils/validate-rates.js output/hdfc-bank-limited_rates.json`

### `scripts/utils/config-defaults.js`
- `CONFIG_DEFAULTS` object — canonical default values for all optional config fields
- `mergeWithDefaults(partial)` — fills missing fields from defaults (one level deep for sub-objects)
- `stripDefaults(config)` — removes fields that match their default values (for Phase 6b compact storage)
- Helper functions: `deepClone`, `deepEqual`, `isPlainObject`

### `scripts/utils/index.js`
- Barrel re-export of all utility modules
- Usage: `const { slugify, parseTenure, validateSlabs } = require("./scripts/utils")`

## Files Modified

### `run-discovery.js`
- Lines 49-58: Replaced 8-line inline slug algorithm with:
  ```javascript
  const { slugify } = require("./scripts/utils/slugify");
  const bankCode = slugify(bankName);
  ```

### `run-batch.js`
- Lines 214-223: Replaced 9-line `toBankCode()` function with:
  ```javascript
  const { slugify: toBankCode } = require("./scripts/utils/slugify");
  ```
- Aliased as `toBankCode` to minimize diff — all existing call sites (`toBankCode(bank.name)`) continue to work unchanged.

## Testing

All utilities tested via CLI and programmatic API:

| Test | Command | Result |
|------|---------|--------|
| Slugify basic | `node slugify.js "State Bank of India"` | `state-bank-of-india` |
| Slugify punctuation | `node slugify.js "Rajkot Nagrik Sahakari Bank Ltd."` | `rajkot-nagrik-sahakari-bank-ltd` |
| Slugify hyphenated | `node slugify.js "Cosmos Co-operative Bank Ltd."` | `cosmos-co-operative-bank-ltd` |
| Tenure preset | `node parse-tenure.js "7 days to 14 days"` | `{"min_days":7,"max_days":14}` |
| Tenure "less than" | `node parse-tenure.js "1 year to less than 2 years"` | `{"min_days":365,"max_days":729}` |
| Tenure special | `node parse-tenure.js "444 days"` | `{"min_days":444,"max_days":444}` |
| Tenure "above" | `node parse-tenure.js "above 5 years to 10 years"` | `{"min_days":1826,"max_days":3650}` |
| Tenure "and above" | `node parse-tenure.js "5 years and above"` | `{"min_days":1825,"max_days":3650}` |
| Validate HDFC | `node validate-rates.js output/hdfc-bank-limited_rates.json` | All 17 slabs valid |
| Validate Citibank | `node validate-rates.js output/citibank-na_rates.json` | All 17 slabs valid |
| Syntax check | `node -c` on all files | All OK |

## Design Decisions

1. **CommonJS, not ESM** — The rate-discovery-agent uses `"type": "commonjs"`. The shared package (`packages/shared`) is ESM TypeScript, so the logic was ported (copied) rather than imported. A future consolidation could use a build step.

2. **Aliased import in run-batch.js** — Used `{ slugify: toBankCode }` to avoid renaming all call sites. The function name `toBankCode` is descriptive in the batch context.

3. **Rate bounds lowered to 1.50%** — Original plan had 2.50% floor, but foreign banks like Citibank (1.75%) and institutional banks would generate false warnings. Lowered to 1.50% which is below any observed rate in the output data.

4. **"X and above" pattern added** — Not in the TypeScript source's regex but is in the presets. Added explicit regex handler for this pattern since banks like SBI and BOB use it in their rate tables.
