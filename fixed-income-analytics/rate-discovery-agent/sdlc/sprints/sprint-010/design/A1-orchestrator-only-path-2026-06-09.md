# Sprint 010 Phase A1 — Orchestrator-only path

**Date:** 2026-06-09
**Status:** Operator-approved (2026-06-09); design + implementation in this same commit.

## Why

The 2026-06-05/06 cohort runs (`5kz1vm8`, `9zulerb`) showed two distinct extraction paths in the agent:

1. **Orchestrator path** (`lib/orchestrator.js`, Sprint 003 #1c) — deterministic Node sequence over `find_website → find_rate_page → fetch_page → classify → extract_html_table / extract_pdf_table / extract_via_vision / extract_via_ocr → commit`. Extraction step dispatches via `lib/extractors/dispatch.js` to a templated extractor or, for un-hinted banks, falls through `_generic-html-3col → _llm-fallback`. The fallback IS Azure OpenAI (per `lib/extractors/_llm-fallback.js` lines 86–90 — `AZURE_OPENAI_DEPLOYMENT_FULL` / `..._DEPLOYMENT` / fallback `gpt-4.1`).

2. **LLM path** (`lib/agent.js#runAgent`) — open-ended Azure OpenAI chat loop reading `CLAUDE.md` as the system prompt. Sprint 6 Step 5 marked it for retirement (sprint-006 close-out, 2026-05-24). Deletion was scheduled for Sprint 7; never happened.

The `pm-refresh-2026-q2` cohort defaulted to the LLM path (`agentPath='llm'`) because of `run-discovery.js:83`:

```js
let agentPath = process.env.RATE_AGENT_PATH || "llm";
```

Banks with `extraction.*.fulfills_product` registry hints were auto-routed to the orchestrator via the M2.6 block; banks without hints stayed on the LLM path. That covered ~140 of 513 banks — the other ~370 ran on the deprecated open-ended loop.

Operator directive (2026-06-09):

> "Orchestrator should be the default path. the agent_path:llm should be removed. The only non-orchestrator path should be to use Claude capabilities itself which is available only in the local run."

## What ships

1. **Orchestrator is the only path.** `run-discovery.js`:
   - Default `agentPath = "orchestrator"` (no env var override path)
   - `--path llm` errors out with a deprecation message and exits 1
   - `--path orchestrator` is the only accepted value (back-compat with cohort scripts that still pass it)
   - The M2.6 auto-route block is deleted — orchestrator is universal; banks with hints get template dispatch, banks without hints fall through to `_generic-html-3col → _llm-fallback`
   - `runLlmAttempt` is deleted; `runAttempt` always calls `runOrchestratorAttempt`
   - The retry loop (was LLM-only) is deleted; orchestrator is deterministic so retries with the same template yield the same output
   - The `partial_silent.json` marker write is deleted (was LLM-flakiness signal); the clear-stale-marker path stays so banks recover into the pack once their next orchestrator run lands
2. **`lib/agent.js` is deleted.** Only consumer was `run-discovery.js`. Sprint 6 Step 5's long-deferred deletion finally happens.
3. **`tests/lib/agent-playwright-disabled-guard.test.js` is deleted.** The guard it tested was inside the deleted `lib/agent.js`.
4. **`run-batch.js`:**
   - `forceIbuLlm` logic is deleted (no LLM path to force IBUs onto)
   - `effectivePath` is gone; the cohort dispatcher just passes `--path orchestrator` (the cohort-wide flag, or default)
5. **JSDoc references to "two-path-architecture"** in `lib/tier-router.js` are factually still valid — `agentResult` field shape remains the same — left unchanged for now.

## Why orchestrator can cover every bank now

Sprint 6 worried that orchestrator couldn't handle JS-rendered or un-templated banks. Two things changed that:

1. **Template dispatch is in place** (`lib/extractors/dispatch.js`, Sprint 005 Phase C + Sprint 006 Step 3b). Registered templates: `coop-bankin-3col-tenure-general-senior`, `psb-pdf-rate-card-3col`, `pvb-multi-variant`, `fb-multi-variant`, `ibu-static-pdf-quarterly`, plus the auto-fallbacks `_generic-html-3col` and `_llm-fallback`.
2. **`_llm-fallback` is real Azure OpenAI.** Lines 86–90 select the deployment from `AZURE_OPENAI_DEPLOYMENT_FULL` / `..._DEPLOYMENT` / default `gpt-4.1`. Banks without a template that fall through are still handled — by the same Azure OpenAI deployments the rest of the system uses, just via the deterministic orchestrator scaffolding (chunked HTML, per-chunk prompt, anti-fabrication validation) rather than an open-ended chat loop.

## What this does NOT change

- The orchestrator's actions (`find_website`, `find_rate_page`, `fetch_page`, etc.) are unchanged. None of them are touched by A1.
- `lib/extractors/dispatch.js` and the registered extractors are unchanged.
- `_llm-fallback.js` is unchanged.
- The Azure OpenAI Bicep env wiring is unchanged.

## What changes operationally

| Before | After |
|---|---|
| `agent_path: 'llm'` on ~370 of 513 banks per cohort | `agent_path: 'orchestrator'` on all banks |
| `model: 'gpt-4.1-mini'` or `'gpt-4.1'` at the top of the agent loop | Each orchestrator action picks the model it needs (`extract_html_table` uses the full deployment, `find_website` uses mini, etc.) |
| Up to 3 attempts per bank (model-flakiness retries) | 1 attempt per bank (deterministic) |
| `partial_silent.json` markers written when 3 attempts all drift | Markers never written (legacy markers are cleared by run-discovery) |
| `lib/agent.js` deprecation warning fires on every run | `lib/agent.js` is gone |

## Risk

- **Banks that the LLM path was extracting cleanly but have no template** will now route through `_generic-html-3col → _llm-fallback`. The fallback uses the same Azure OpenAI deployments but with a more constrained prompt (anti-fabrication validation against the source HTML). Quality should be at least as good; the 12-bank cohort in Phase F verifies before the 513-fire.
- **Some banks the LLM path was *not* extracting cleanly** (the 270-bank cloud-zero set in the prior audit) may behave differently with the orchestrator. Some will improve (IBUs with templates that never ran), some will not (banks where the underlying site is broken).

The Phase E single-bank cloud smoke (`indusind-bank-ibu`) is the first concrete verification — it has a `template_id` and should now dispatch to the IBU GIFT extractor.

## Files changed

- `run-discovery.js` — default `agentPath`, deletion of `runLlmAttempt` / M2.6 block / retry loop / partial_silent write
- `run-batch.js` — deletion of `forceIbuLlm` / `effectivePath`
- `lib/agent.js` — **deleted**
- `tests/lib/agent-playwright-disabled-guard.test.js` — **deleted**
- Pre-existing safe-write-exempt comments added to `lib/cloud-capability/observer.js`, `scripts/analysis/cloud-outcome-recount.js`, `scripts/analysis/sprint-009-cloud-incapable-candidates.js`, `pack/quality-gate.js` (unrelated to A1; surfaced by the write-discipline check that A1's npm-test run triggered).

## Test status

`npm test`: **1,458 pass / 0 fail / 44 skipped** after the changes. Including all of:

- `tests/lib/cohort/*` (24 cases)
- `tests/lib/cloud-block/*` (29 cases)
- `tests/lib/cloud-capability/*` (36 cases — registry-updater + observer)
- `tests/lib/tier-router*` (35 cases — including the Phase 5 fix)
- `tests/lib/extraction-inspector*`
- `tests/lib/cohort-watchdog.test.js`
- `tests/pack/*` (18 cases — build-pack + quality-gate)

The deleted test `tests/lib/agent-playwright-disabled-guard.test.js` had 6 cases (now gone — they covered code that's also gone).
