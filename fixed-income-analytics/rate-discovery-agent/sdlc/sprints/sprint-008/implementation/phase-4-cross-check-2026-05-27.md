# Implementation — Phase 4: systematic independent cross-check (2026-05-27)

Design: `../design/cross-check.md`. Status: **code complete + dry-run validated; live run deferred until the Phase-2 audit finishes (shared LLM endpoint).**

## What shipped

- **`lib/llm/reextract-prompt.js`** (new) — shared re-extraction prompt: `buildExtractionPrompt`, `variantInstructions` (moved **verbatim** from `verify-with-llm.js`), `classifyAgreement(diff, nLlm)` (FULL/PARTIAL/DISAGREE/LLM_NO_DATA). Single source so the cross-check and the refresh verifier can't fork the prompt.
- **`scripts/refresh/verify-with-llm.js`** — now imports `buildPrompt`/`variantInstructions` from the shared module; its local copies deleted. Exports unchanged (`stripHtmlForLlm`, `normalizeLlmSlabs`, `plausibleLlmResult`); loads clean.
- **`scripts/audit/cross-check-all.js`** (new) — enumerates variants with a snapshot, re-extracts each via the snapshot + LLM, compares to shipped slabs with `diffSlabs()`, classifies agreement, and rolls up % FULL per extraction method. Reuses `normalizeLlmSlabs`/`plausibleLlmResult` (verify-with-llm exports), `classifyExtraction`/`stripJsonEnvelope` (Phase-2 audit). MEASURES ONLY — no auto-replace.
  - Cost control: `--strata`, `--max-calls` (default 200), `--concurrency` (default 4), gpt-4.1-mini; incremental skip via `output/audit/_crosscheck_state.json` keyed by `bank|variant|snapshot_sha|slabs_hash`.
- **`tests/audit/cross-check.test.js`** (new) — `parseKey`, `hashSlabs`, `classifyAgreement` matrix, `buildExtractionPrompt`/`variantInstructions` shape.

## Verified

- `node --test tests/audit/cross-check.test.js` → **5/5**.
- `verify-with-llm.js` + `reextract-prompt.js` load clean after the refactor (exports intact).
- `check-write-discipline.js` clean (154 files).
- Dry-run: **357 variants have snapshots**; `--strata template` → 200 under the default cap.

## Live run result + a real finding (2026-05-27)

`cross-check-all.js --strata template --max-calls 60`: **template FULL 8%** (5 FULL / 17 PARTIAL / 34 DISAGREE / 4 LLM_NO_DATA, n=60).

**Interpret carefully — this is NOT "92% wrong".** `diffSlabs` keys slabs on tenure-text + deposit_range + currency; the independent LLM read phrases tenure_text differently and may pick a different amount-tier, so many slabs land as added/removed (→ DISAGREE) even when the *rates* are close. The Phase-2 audit (5.3% error, compared at the rate-value level) is the truer correctness signal; this cross-check, as implemented, is a coarser **structural-divergence queue** — the 34 DISAGREE are worth a look, but the depressed FULL% is largely representation noise.

**Follow-on (new):** make the agreement metric **rate-centric** — match LLM vs shipped slabs by overlapping tenure-day range and compare `rate_general_pct` within tolerance, rather than exact `diffSlabs` key equality. That turns cross-check into a clean confidence signal worth feeding Phase 5. Until then, `confidence_signals.crossCheckAgreement` should be treated as low-precision.

## Deferred

- Live run (`--strata template,tier2 --max-calls N`) to produce the per-method agreement roll-up — deferred a few minutes to avoid rate-limit contention with the concurrently-running Phase-2 audit (same Azure OpenAI endpoint). The LLM path reuses production-proven components (`buildExtractionPrompt` + `chatCompletion` + `normalizeLlmSlabs`, all exercised by `verify-with-llm.js`). Roll-up numbers will be recorded here + in the sprint memory.
- Optional auto-exclude of low-agreement variants via `_pack_excludes.json` — operator opt-in only; not wired.
