# HDFC regression after anti-fabrication rewrite (2026-05-18)

## Symptom

After commit `debb627` ("per-table LLM chunking + anti-fabrication contract"), HDFC's 5-bank smoke result fell from 71 slabs (smoke-p4b-5bank) to **2 slabs** (smoke-p4c2). All four variants are affected: `hdfc-bank-limited_rates.json` has 2 slabs and the NRE/NRO/FCNR files were not written.

Pre-fix, HDFC had been the headline win of Phase 4 — the new `fetch_page` action avoided the Playwright subprocess crash on its 1.2 MB rendered pages, and the previous LLM trigger accepted whatever the model returned. The rewrite tightened acceptance, and HDFC's specific layout interacts badly with the new validation.

## Suspected root cause

`validateSlabAgainstChunk(slab, chunkText)` in `lib/actions/extract_html_table.js` has two acceptance gates:

1. Rate-digit gate — `rate_general_pct`'s digit string MUST appear in the cheerio-stripped chunk text.
2. Identity gate — `source_row_text` head (~150 chars) OR `tenure_text` MUST appear in chunk text.

HDFC's rate page likely emits the model output in a form where one of those gates fails for almost every row. Possible mechanisms:

- **Number formatting drift.** Page shows `7.55%` but LLM emits `7.55` as a number — the rate-digit gate searches for the literal string `"7.55"`, which IS present in the chunk. That should pass. But if the page uses `7.55 %` (with a space) and the LLM strips the percent for `rate_general_pct` while keeping `7.55%` in `source_row_text`, the page text after `htmlToText` may have `7.55 %` (extra whitespace) and the source_row_text probe (`"7.55%"`) won't match.
- **Whitespace normalisation gap.** `htmlToText` collapses whitespace runs to single spaces; `validateSlabAgainstChunk` does NOT do the same to `source_row_text` before searching. A space-preserving slab probe like `"7 days to 14 days 3.00% 3.50%"` won't match the normalised haystack if the model interleaved tabs / `\xa0` non-breaking spaces.
- **Cheerio scoring penalised the rate-bearing tables.** HDFC's pages mention "Card Rate" / "Existing Rate" / "Revised Rate" in footnote tables — the `_cheerio_tables.NOISE_PATTERNS` regex penalises tables containing those phrases. If the canonical rate table is sufficiently penalised it may score ≤ 0 and be filtered out before reaching the LLM at all.
- **Subprocess Path B not engaging anymore.** Pre-fix, when classify returned `html_static`, the dispatcher subprocess ran on a fresh fetch and the in-browser scan produced slabs. Post-fix, `pathAUsed = true` short-circuits Path B, so we never call the subprocess. If cheerio Path A finds no slabs AND the LLM's chunked output is all dropped by post-validation, we end with 0.

## Reproduction

```bash
node run-discovery.js "HDFC Bank Limited" "Private Sector Bank (Indian)" \
  --path orchestrator --output-dir output/runs/hdfc-debug --log-level debug
```

The trace JSON in `output/runs/hdfc-debug/hdfc-bank-limited.trace.jsonl` records per-action durations and slab counts. The smoke log `hdfc-bank-limited.log` should contain `llm_validation: chunk[i] dropped slab ...` warnings revealing which gate is firing.

## Diagnosis steps (in priority order)

1. **Count drops per chunk.** Grep the log for `llm_validation:`. If most drops cite "rate ... not present", the rate-digit gate is at fault. If most cite "source_row_text not found", the identity gate is.

2. **Inspect the chunk text vs slab probe.** Add a one-shot `logger.debug(chunkText.slice(0, 500))` and a `logger.debug(probe.slice(0, 200))` for the first 2 dropped slabs. Compare character-by-character.

3. **Check Path A vs Path B.** If `pathAUsed = true` but cheerio Path A's `bestIdx === -1` and `slabs.length === 0` before the LLM is invoked, HDFC needs Path B. Either (a) gate `pathAUsed` on a non-empty deterministic result, or (b) restore the legacy Path B as a final fallback when both A and LLM are empty.

4. **Score the HDFC rate tables.** Save a copy of HDFC's rendered HTML and run `extractScoredTables(html)` in isolation. If the canonical rate table scores ≤ 0 because of "Card Rate" noise penalty, weaken the penalty for the specific case where multiple rate-shaped rows still beat the noise.

## Quick-win fix candidates (each ≤ 50 lines)

- Normalise `source_row_text` with the same whitespace-collapse as `htmlToText` before the `includes` check.
- Add a tolerance band to the rate-digit gate: search for both `"7.55"` and `"7.55%"` (with optional `%`).
- Add `if (pathAUsed && slabs.length === 0) { pathAUsed = false; }` before the Path B block — so cheerio empty on cached_body falls through to the live dispatcher.
- Pre-fix HDFC's bank-domains.json with a `selectors.table` chain that picks the canonical rate table by class, sidestepping the multi-table scoring.

## Why this is NOT blocking the commit chain

Phase 4 (`ddce343`) fundamentally fixed HDFC's structural blocker: the Playwright subprocess no longer crashes on its 1.2 MB pages because we don't spawn it anymore. The LLM has the body. The trustworthiness of the output is the trade-off — 2 real slabs is better than 71 silently-fabricated ones. The follow-up restores quantity without sacrificing the anti-fabrication guarantee.

## Stop conditions

If the diagnosis steps above don't yield a fix in ~3 hours, accept HDFC as a Phase 7 carve-out per the strategy doc's "Stop conditions" section, and route HDFC through the LLM-prompt path (`--path llm`) until Sprint 004.
