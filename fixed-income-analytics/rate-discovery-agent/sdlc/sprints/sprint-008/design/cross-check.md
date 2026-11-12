# Design — Phase 4: systematic independent cross-check

**Sprint:** 008 · **Phase:** 4 · **Status:** design → implementation
**Depends on:** Phase 1 snapshots. **Generalizes:** the flagged-only `verify-with-llm.js` into an every-variant second opinion.

## Approach

`scripts/audit/cross-check-all.js`. For every variant that has a Phase-1 snapshot, re-extract the rates with an independent LLM read of the snapshot and compare to the shipped slabs via `diffSlabs()`. Emit a per-(bank,variant) agreement and a per-extraction-method roll-up — a second confidence signal beside the Phase-2 sampling audit. **Measures only; never auto-replaces** (the replace path stays in `verify-with-llm.js`).

## No fork

The extraction prompt is the one thing the refresh verifier and this cross-check must share. Moved verbatim into **`lib/llm/reextract-prompt.js`** (`buildExtractionPrompt`, `variantInstructions`, `classifyAgreement`); `verify-with-llm.js` now imports it (its local copies deleted). The slab normalization / plausibility helpers (`normalizeLlmSlabs`, `plausibleLlmResult`) are reused from `verify-with-llm.js`'s existing exports; `diffSlabs` from `extract-and-diff.js`; `classifyExtraction`/`stripJsonEnvelope` from the Phase-2 audit script.

## Agreement classes (`classifyAgreement(diff, nLlm)`)

- `FULL` — no added/removed/changed slabs.
- `PARTIAL` — some slabs match, some differ.
- `DISAGREE` — nothing matches.
- `LLM_NO_DATA` — re-extraction empty/implausible.
- `SKIPPED` — no snapshot text / error.

(`diffSlabs` keys on tenure+deposit_range+currency, so LLM tenure-text drift can inflate added/removed — read FULL/PARTIAL as a signal, not a proof. Operator follows up on DISAGREE/LLM_NO_DATA.)

## Cost control

- `--strata template,tier2,static` to tier the work (template+tier2 first).
- `--max-calls` budget (default 200), `--concurrency` (default 4), gpt-4.1-mini default.
- Incremental skip via `output/audit/_crosscheck_state.json` keyed by `bank|variant|snapshot_sha|slabs_hash` — re-runs only re-check changed snapshots/slabs.

## Output

`output/audit/crosscheck-<ts>/cross-check.json` (per-variant records + diff summary) + console roll-up "% FULL per extraction_method". Low-agreement variants are a review queue; optional auto-exclude via `_pack_excludes.json` is operator opt-in only (not done here).

## Tests

`tests/audit/cross-check.test.js`: `parseKey`, `hashSlabs`, `classifyAgreement` (FULL/PARTIAL/DISAGREE/LLM_NO_DATA), `buildExtractionPrompt` shape. LLM not exercised in unit tests.
