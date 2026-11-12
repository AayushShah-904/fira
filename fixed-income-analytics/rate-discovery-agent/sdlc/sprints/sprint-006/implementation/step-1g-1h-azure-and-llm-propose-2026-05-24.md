# Step 1g + Step 1h — Azure client refactor + LLM-propose flow

**Date:** 2026-05-24
**Plan:** `../plan/sprint-006-scope.md`
**Context:** Both steps un-deferred from Sprint 7 per operator decision 2026-05-24.

## What landed

### Step 1g — Azure client refactor

`lib/actions/extract_via_ocr.js` now delegates `buildClient()` + `analyzeUrl()` to the shared `lib/azure/doc_intelligence.js`. The duplicated `loadSdk()` + SDK-setup boilerplate is removed.

- Public surface of `extract_via_ocr.js` is unchanged — all 45 existing OCR tests pass without modification
- The `OCR_NOT_CONFIGURED` error code is preserved (the shared module throws `DOCINTEL_NOT_CONFIGURED`; the back-compat wrapper re-throws with the legacy code so callers that test for `OCR_NOT_CONFIGURED` keep working)
- `lib/actions/extract_via_vision.js` was correctly NOT refactored — it uses Azure OpenAI Vision Chat (different service from DocIntel), not the layout API. The original plan that lumped them together was wrong.

### Step 1h — Real LLM-propose flow in author-template.js

`scripts/author-template.js`'s LLM-propose path was a stub print in Step 1d; it's now a real AOAI integration via the new `lib/templating/llm_propose.js` module.

**New module `lib/templating/llm_propose.js`** with 15 unit tests:
- `buildProposePrompt({bankCode, variant, url, html, systemTemplate?})` — pure function. Loads the prompt template from `lib/prompts/author-template.md`, extracts up to 4 candidate table chunks (score-ordered) via `_cheerio_tables.js#extractTableChunks`, and builds the system + user prompt strings.
- `parseProposeResponse(raw)` — pure function. Parses + validates strict JSON. Strips ```` ```json ```` fences if model wraps response. Validates `column_map` field names against the whitelist (`tenure_text`, `rate_general_pct`, `rate_senior_pct`, `rate_super_senior_pct`, `currency`, `amount`, `ignore`). Requires `tenure_text` AND `rate_general_pct` mappings; throws on either missing. Allows `template_id_suggestion: null` for "LLM couldn't identify" case.
- `proposeTemplate({bankCode, variant, url, html, logger, _chat?, _createClient?})` — full pipeline. Calls AOAI via existing `lib/azure-openai-client.js#chatCompletion`. Test injection points: `_chat` for end-to-end tests without real AOAI.

**Wired into `scripts/author-template.js`**:
- When fingerprint produces no cluster match (and `--no-llm` not set), call `proposeTemplate()`
- Print the proposed template_id, reason, column_map, wait_hints, click_to_reveal
- Replay through `_generic-html-3col` with the proposed column_map; show delta vs baseline
- Operator gets the same `[y/N]` confirmation flow before `--write` persists

Refusal logic unchanged: LLM-propose runs fine under agents (operator review is the trust boundary); only `--write` requires TTY + non-agent + non-CI.

## Verification

```
$ node --test tests/lib/templating/llm_propose.test.js   → 15 pass
$ node --test tests/lib/actions/extract_via_ocr.test.js   → 45 pass (no regressions from refactor)
$ npm test                                                → 1056 pass / 0 fail / 51 skip
```

Smoke test of author-template.js:
- `--help` exits 0 with usage including LLM-propose mode
- `--write` under CLAUDECODE=1 still refuses (exit 11) — Phase D2 refusal cascade unaffected

## Open follow-ups (still un-deferred per operator)

- **Step 3c** — `extract_html_table.js` (1,870 LOC) split into deterministic + LLM modules. Biggest remaining piece.
- **Step 3d** — wire real AOAI in `_llm-fallback.js` (currently a stub). The LLM scaffolding to lift lives in `extract_html_table.js:1109-1199` (buildHtmlExtractionPrompt) + line 1012 (validateSlabAgainstChunk traceability post-processor).
- **Step 3e** — wire DocIntel paths in `psb-pdf-rate-card-3col.js` + `ibu-static-pdf-quarterly.js` (Step 1g unblocks this — they can now use the shared client).
- **Step 3f** — currency-matrix paths in `pvb-multi-variant.js` + `fb-multi-variant.js` FCNR/GIFT (depends on Step 3c lifting the currency-matrix logic into a shared helper).
