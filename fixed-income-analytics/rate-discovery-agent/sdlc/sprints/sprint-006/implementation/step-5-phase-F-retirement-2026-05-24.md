# Step 5 — Phase F begin retiring legacy paths

**Date:** 2026-05-24
**Plan:** `../plan/sprint-006-scope.md`

## What landed

### Deprecation notice on `lib/agent.js`

- Module-level header comment marks the file as deprecated with a clear deletion timeline
- `runAgent()` now calls `logDeprecationOnce(logger)` at the top of every invocation — deduped per process so existing batches aren't spammed
- The warning message says: `[DEPRECATED] lib/agent.js (runAgent) — Sprint 6 Step 5 marked for retirement. Migrate callers to lib/extractors/dispatch.js + scripts/author-template.js. Physical deletion scheduled for Sprint 7 after pilot 50 migration completes.`

CI / grep can confirm zero `runAgent` invocations remain after Step 4 pilot 50 migration; that's the prerequisite for the Sprint 7 physical-delete commit.

### Hint-migration script `scripts/migrate-hints-to-column-maps.js`

One-shot migration from the legacy `extraction.hints` M2.3 annotation system to the new `template.extract.column_map`. Dry-run by default; `--write` requires TTY + non-agent + non-CI (same refusal cascade as `bin/approve-accept.js`).

**Dry-run scan reported 10 banks have `extraction.hints` to migrate**:
- `ajmer-central-co-operative-bank-ltd` (fd_image_ocr)
- `axis-bank-limited` (fd_image_ocr_fcnr, fd_pdf_nri, fd_pdf_domestic)
- `bank-of-bahrain-and-kuwait-bsc` (fd_image_ocr_fcnr)
- `banswara-central-co-operative-bank-ltd` (fd_image_ocr)
- `barmer-central-co-operative-bank-ltd` (fd_image_ocr)
- `hdfc-bank-limited` (fd)
- `icici-bank-limited` (fd_nri_combined)
- `idbi-bank-limited` (fd_nri_combined)
- `idfc-first-bank-limited` (fd)
- `tamil-nadu-grama-bank` (fd_image_ocr)

The migration logic:
1. Walks each entry's `extraction.<key>` blocks
2. If `template.extract.column_map` not already set AND first block's pages[0].columns is well-shaped, derives a column_map (maps `tenure|period → tenure_text`, `senior → rate_senior_pct`, `super senior → rate_super_senior_pct`, `general|rate|interest → rate_general_pct`)
3. Deletes the `extraction` field
4. Persists via `safeWriteArtifact(kind: 'registry-file', source: 'operator')`

**Note: today's dry-run shows `added_template_column_map: false` for all 10 banks** — their existing hint blocks don't have `pages[].columns[]` arrays in the shape the auto-derive recognizes. That's fine: the migration still removes `extraction.hints` (which is the goal — kill the legacy path), and the operator can subsequently author proper `template.extract.column_map` blocks via `scripts/author-template.js`. The bank's `template` block can be authored before OR after this migration; the script is idempotent.

### `lib/extraction-hint.js` retention

NOT deleted in Sprint 6. Sprint 7 deletes the file after:
1. Operator runs `scripts/migrate-hints-to-column-maps.js --write` (clears all extraction.hints from registry)
2. Confirms `grep -r "require.*extraction-hint" lib/ scripts/` returns no callers
3. Single commit deletes the file

## Verification

```
$ node --test                                                → 1083 pass / 0 fail / 51 skip
$ node scripts/migrate-hints-to-column-maps.js               → dry-run, exit 0, lists 10 banks
$ node scripts/migrate-hints-to-column-maps.js --write       → exit 11 (CLAUDECODE refused)
$ node scripts/migrate-hints-to-column-maps.js --help        → exit 0 with usage
```

## What this DOES NOT do

This step **does not delete anything from production**. It marks the deprecation timeline and ships the one-shot migration script. Actual deletion is a Sprint 7 commit, sequenced after:
1. Step 4 pilot 50 migration completes (operator-driven)
2. Hint migration runs successfully on the 10 affected banks
3. Grep confirms no remaining callers of the legacy paths
