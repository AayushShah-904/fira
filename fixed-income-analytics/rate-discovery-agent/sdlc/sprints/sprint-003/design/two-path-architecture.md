# Two-path architecture: CLAUDE.md vs orchestrator

**Date:** 2026-05-16
**Status:** Both paths exist in the code. LLM-prompt path is the production runner; orchestrator path (Sprint 003 #1c) is built but not yet wired into a runner. The plan is to support both for a while so we can compare behavior bank-by-bank, then retire the LLM-prompt path once the orchestrator is satisfactory.

## TL;DR

Two parallel paths from `run-discovery.js`:

- **LLM-prompt path (live)**: one open-ended Azure OpenAI chat-loop per bank. The LLM reads CLAUDE.md and decides every step. CLAUDE.md is the brain.
- **Orchestrator path (built, not wired)**: deterministic Node sequence that calls fine-grained actions. Some actions call Azure OpenAI internally for narrow sub-tasks. CLAUDE.md is bypassed.

CLAUDE.md still exists because `run-discovery.js:337` still calls `runAgent`, not `orchestrate`. After migration, CLAUDE.md retires or shrinks to a one-page intro.

## Component map

```
                          run-batch.js   (multi-bank coordinator)
                                │  spawn child per bank
                                ▼
                          run-discovery.js   (per-bank entry — already calls slugify on CSV name)
                                │
                ┌───────────────┴───────────────┐
                │                               │
        ●  LLM-PROMPT PATH                ○  ORCHESTRATOR PATH
        ●  (production, today)            ○  (built Sprint 003 #1c,
                │                            not yet wired to a runner)
                ▼                               ▼
        lib/agent.js (runAgent)         lib/orchestrator.js orchestrate()
                │                               │
                │  one big LLM loop:            │  fixed Node sequence:
                │  CLAUDE.md fragments          │   find_website →
                │  + prompts/discover.md        │   commit_to_registry →
                │  + tool defs                  │   for each variant:
                │                               │     find_rate_page →
                ▼                               │     classify_rate_page →
        Azure OpenAI Chat Completions          │     extract_{html|pdf|vision} →
                │  tool_calls                   │     commit_rates →
                ▼                               │   classify_outcome
        lib/tools.js (executeTool)              │
        web_search · web_fetch · read_file      ▼
        write_file · playwright_fetch ·     lib/actions/*.js
        slugify                             (deterministic Node;
                │                            some call Azure OpenAI
                ▼                            internally for narrow tasks)
        output/latest/*.json                    │
                                                ▼
                                            same output/latest/
```

## Who calls Azure OpenAI?

Both paths call AOAI, very differently:

| Path | How AOAI is used |
|---|---|
| **LLM-prompt** | One open-ended chat-loop per bank. LLM reads CLAUDE.md and decides every step. ~15-25 tool calls per bank. |
| **Orchestrator** | Orchestrator itself makes **zero** AOAI calls. Only specific actions invoke AOAI for narrow sub-tasks: `find_website` (Responses API for web search), `extract_via_vision` (Vision), `extract_html_table` LLM-fallback (selector picker). |

## Division of work

Same decisions, different owners:

| Decision | LLM-prompt path (live) | Orchestrator path (Sprint 003) |
|---|---|---|
| Workflow order (website → page → extract) | CLAUDE.md prose §"Step-by-Step Workflow" | Node code in `orchestrate()` |
| Skip NRI for co-op banks | CLAUDE.md prose §"Efficiency Rules" #2 | `shouldQueryNri(bankType, bankCode)` in orchestrator.js:50 |
| Classify scraper type (html/pdf/vision) | LLM follows CLAUDE.md §Step 3 table | `classify_rate_page` action |
| Enforce canonical bank_code | `$BANK_CODE` injected into prompt; LLM instructed not to re-derive | `commit_rates:99` strict equality check, errors on mismatch |
| Pick selectors / extract slabs | LLM inspects HTML, writes selectors block | `extract_html_table` (cheerio + canonical-table picker) |
| Handle missing pages, retries | LLM judgment from CLAUDE.md | Explicit `phase_events`, structured errors |
| Search the web | LLM calls `web_search` tool | `find_website` action calls AOAI Responses API |

## Why CLAUDE.md still exists

`run-discovery.js:337` calls `runAgent` (line 26 import), not `orchestrate`. The only callers of `orchestrate` today are `tests/lib/orchestrator.test.js`. So the orchestrator is **built but unused in production**.

Until `run-discovery.js` is changed to invoke `orchestrate()`, CLAUDE.md remains the agent's playbook. After migration:

- CLAUDE.md's prose workflow becomes dead weight — the workflow is in Node code.
- Narrow LLM calls inside specific actions use **targeted prompts** (e.g. `find_website`'s search prompt is ~40 tokens, not the 4300-token CLAUDE.md). Those prompts live next to the action code.
- CLAUDE.md gets retired or trimmed to a one-page "what this project does" intro.

## Migration plan

1. **Dual-path runner**: `run-discovery.js` accepts `--path llm|orchestrator` (or env var `RATE_AGENT_PATH=orchestrator`). Default stays `llm` until orchestrator proven.
2. **Comparison harness**: per-bank diff of outputs from both paths for a chosen sample (5-10 banks per category). Capture wall-clock, AOAI tokens, slab counts, validation flags.
3. **Bank-type-staged rollout**: flip default to `orchestrator` for one bank type at a time (start PSB — cleanest HTML; finish co-op tail).
4. **Retire LLM-prompt path**: once orchestrator is default for all bank types and a refresh cycle has run cleanly, delete `lib/agent.js`, `lib/prompts/build-prompt.js`, `lib/prompts/fragments/`, and `prompts/discover.md` / `prompts/extract.md` / `prompts/expand-nri.md`. CLAUDE.md retires or shrinks.

## What "wire the orchestrator into production" means concretely

`run-discovery.js:337` currently looks like:

```js
const result = await runAgent({ systemPrompt, userPrompt, outputDir, ... });
```

Migrated form (post-step-1 of migration):

```js
const result = pathChoice === 'orchestrator'
  ? await orchestrate({ bank_name, bank_type, state, output_dir, run_dir, domains_file, ... })
  : await runAgent({ systemPrompt, userPrompt, outputDir, ... });
```

After step 4 (retirement), only the `orchestrate` call remains.

## What gets compared during dual-path operation

Per bank, both paths write to a sandbox dir; the comparison harness reports:

| Metric | What to look for |
|---|---|
| Slab count per variant | Should match within ±1 (off-by-one on edge slabs is OK) |
| `rate_general_pct` per matched tenure | Exact match preferred; > 5 bps drift is a regression |
| `rate_senior_pct` presence | Orchestrator should populate where LLM did |
| Validation flag count (critical/warning) | Should be ≤ LLM path |
| AOAI tokens used | Expect orchestrator significantly lower (action-level prompts ≪ full CLAUDE.md) |
| Wall-clock | Expect orchestrator faster (no big chat-loop) |
| `extraction_method` recorded in `_rates.json` | Confirms which extractor (html_static / html_js / pdf / vision / llm-fallback) ran |

## See also

- [`option-a-c-implementation-plan.md`](./option-a-c-implementation-plan.md) — 2026-05-16 phased plan to close the orchestrator's coverage gap (17% → ≥70% on the 5-bank smoke) by routing all HTTP fetches through a per-bank Playwright session and tightening the cheerio extraction. Includes the architecture review and extraction-quality diagnosis that justified the approach.

## Related files

- `lib/agent.js` — LLM-prompt path driver
- `lib/orchestrator.js` — orchestrator path
- `lib/actions/*.js` — orchestrator's actions (9 files)
- `lib/azure-openai-client.js`, `lib/azure-openai-responses.js` — AOAI wrappers
- `lib/prompts/build-prompt.js`, `lib/prompts/fragments/` — system prompt assembly (LLM path)
- `prompts/discover.md`, `prompts/extract.md`, `prompts/expand-nri.md` — user prompts (LLM path)
- `CLAUDE.md` — agent playbook (LLM path)
- `tests/lib/orchestrator.test.js` — only current caller of `orchestrate()`
- `sdlc/sprints/sprint-003/design/action-contracts.md` — action input/output schemas
