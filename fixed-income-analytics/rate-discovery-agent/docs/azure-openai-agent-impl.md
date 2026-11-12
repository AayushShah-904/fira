# Azure OpenAI Agent — Implementation Notes

## What Changed

The rate-discovery-agent was refactored from spawning the Claude Code CLI (`claude -p`) as a subprocess to calling Azure OpenAI Chat Completions API directly with function calling. This decouples the agent from a local Claude Code installation and makes it deployable to Azure Container Apps.

### Architecture (Before → After)

```
BEFORE:                                 AFTER:
run-discovery.js                        run-discovery.js
  └─ spawn("claude -p ...")               └─ runAgent() [lib/agent.js]
       └─ Claude CLI (local)                   ├─ Azure OpenAI Chat Completions
            WebSearch (built-in)               └─ Local tool dispatch [lib/tools.js]
            WebFetch  (built-in)                    ├─ web_search  → Bing Search API
            Read/Write/Bash (built-in)              ├─ fetch_url   → HTTPS + HTML cleanup
                                                    ├─ read_file   → fs.readFileSync
                                                    ├─ write_file  → fs.writeFileSync
                                                    └─ run_playwright → subprocess
```

### New Files

| File | Purpose |
|------|---------|
| `lib/agent.js` | Core agent loop — calls Azure OpenAI, executes tool calls locally, loops until done or budget exhausted |
| `lib/azure-openai-client.js` | AzureOpenAI SDK wrapper with exponential backoff retry on 429/500/503 |
| `lib/tools.js` | 5 tool definitions (OpenAI function-calling schema) + implementations |
| `lib/cost-tracker.js` | Token/cost tracking, mirrors the trace-parser.js API for drop-in use in run-discovery.js |
| `lib/tier-router.js` | Two-tier model routing: pre-route hard banks to full model, post-run quality check for retry |
| `lib/azure-openai-responses.js` | Responses API client for web search — used by domain discovery and as agent search fallback |
| `lib/prompts/fragments.js` | CLAUDE.md decomposed into 13 named prompt fragments |
| `lib/prompts/build-prompt.js` | Assembles mode-specific system prompts from fragments |
| `.env.example` | Environment variable template |

### Modified Files

| File | Changes |
|------|---------|
| `run-discovery.js` | Replaced Claude CLI spawn with `runAgent()` call. Added two-tier model routing (mini first, full on retry). Added `buildSystemPrompt()`, `CATEGORY_TO_TYPE` mapping. Default log level → `warn`. |
| `scripts/utils/logger.js` | Added `trace` level (file-only, never console). Added `isEnabled(lvl)` for cheap guards. Switched from in-memory buffer to streaming `WriteStream` via `setLogFile()`. Default → `warn`. |
| `package.json` | Added `openai` dependency |
| `.gitignore` | Added `.env`, `output/latest/`, `output/runs/`, `output/archive/` |

### Unchanged Files

`run-batch.js`, `run-pipeline.js`, `scripts/extract_rates.js`, `scripts/fetch_rates_playwright.js`, all other `scripts/utils/`, `data/bank-domains.json`, `prompts/*.md` — all unchanged. The CLI interface of `run-discovery.js` is preserved (same args, exit codes, output files, summary.json shape).

## Prompt Strategy

CLAUDE.md was decomposed into 13 fragments in `lib/prompts/fragments.js`. The `buildSystemPrompt(mode, {bankType, isIBU})` function assembles only the relevant fragments:

| Mode | Included fragments | Chars | vs full CLAUDE.md |
|------|--------------------|-------|-------------------|
| discover (PSB) | identity + efficiency + website + rate-pages + NRI + scraper + extraction + config-schema + bank-types + rate-schema + rules + slug | 10,938 | baseline |
| discover (IBU) | + GIFT City section | +1,200 | conditional |
| discover (co-op) | − NRI section | −1,800 | smaller |
| expand-nri | identity + NRI + extraction + config-schema + rate-schema + rules + slug | 7,125 | 35% smaller |
| rates-only | identity + scraper + extraction + rate-schema + rules + slug | 5,690 | 48% smaller |

CLAUDE.md remains in the repo as reference documentation but is no longer loaded at runtime.

## Agent Loop Design

`lib/agent.js` implements a standard function-calling loop:

```
1. messages = [system, user]
2. loop (max 25 iterations):
   a. response = chatCompletion(messages, tools)
   b. if finish_reason == "stop" → return finalText
   c. for each tool_call:
      - parse args (with try/catch for malformed JSON)
      - execute locally via executeTool()
      - push {role: "tool", content: result}
   d. if toolCallCount >= budget → tool_choice = "none" + nudge message
   e. if 3 consecutive errors → force completion
3. return result
```

**Tool budget**: Default 15 calls (configurable via `AGENT_MAX_TOOL_CALLS`). Higher than Claude's 8 because Azure OpenAI treats each search/fetch as separate round-trips. After budget, `tool_choice` switches to `"none"` to force the model to finish.

**Error handling**: Tool failures return `{"error": "..."}` as the tool result — the model sees the error and decides what to do. The CLAUDE.md instructions already say "do not retry failed URLs". After 3 consecutive errors, the loop forces completion.

## Tool Implementations

### web_search
- Bing Web Search API v7 (`BING_SEARCH_API_KEY`)
- `mkt=en-IN`, `count=8`, `responseFilter=Webpages`
- Returns formatted text (title + URL + snippet), not raw JSON — saves tokens

### fetch_url
- Node.js `https`/`http` with redirect following (up to 5 hops)
- `truncateHtml()` strips `<script>`, `<style>`, `<head>`, `<nav>`, `<footer>`, `<svg>`, comments
- Collapses whitespace, truncates to 80K chars
- If still over limit after stripping, extracts only `<table>` elements + 200 chars context
- 30s timeout, 2MB max download

### read_file
- `fs.readFileSync`, path resolved relative to project root
- Security: rejects paths that escape project root
- Max 100KB

### write_file
- `fs.writeFileSync`, path must resolve within the output directory
- Creates parent dirs automatically
- Security: rejects paths outside output dir

### run_playwright
- Spawns `node scripts/fetch_rates_playwright.js <url> [flags]` via `spawnSync`
- 90s timeout, 5MB max buffer
- Parses output after `JSON_OUTPUT:` marker
- Supports `--scroll`, `--tabs`, `--selects`, `--intercept` flags

## Logging Architecture

5 levels: `error` (0) → `warn` (1) → `info` (2) → `debug` (3) → `trace` (4). Default: `warn`.

| Level | Console | File | Use for |
|-------|---------|------|---------|
| error | stderr | yes | Fatal failures |
| warn | stdout | yes | Non-fatal issues (truncation, timeouts, budget exhaustion) |
| info | stdout | yes | Per-bank summary line |
| debug | stdout | yes | Tool call details, prompt sizes |
| trace | **no** | yes | Full API bodies, HTML content (expensive) |

**Cost model**: At default `warn`, every info/debug/trace call is a single integer comparison + early return. `isEnabled("trace")` guards prevent expensive argument preparation:

```js
// Cheap at warn level — the JSON.stringify never runs
if (log.isEnabled("trace")) log.trace("Full HTML:", hugeString);
```

**Streaming output**: Log file is a `WriteStream` opened via `setLogFile(path)`. Messages write directly to the stream — no in-memory buffer accumulation. Constant memory regardless of verbosity.

## Cost Tracking

`lib/cost-tracker.js` mirrors the `trace-parser.js` API:
- `recordApiCall(usage)` — accumulates prompt_tokens, completion_tokens
- `recordToolCall(name, durationMs, isError, inputPreview, resultPreview)`
- `getSummary()` — returns `{total_cost_usd, tool_call_count, wall_clock_ms, input_tokens, output_tokens, model, ...}`

Cost is computed from env vars `AZURE_OPENAI_INPUT_PRICE_PER_1M` (default 2.50) and `AZURE_OPENAI_OUTPUT_PRICE_PER_1M` (default 10.00).

The `.summary.json` format is compatible with `run-pipeline.js` and `run-batch.js` — they read `total_cost_usd` and `tool_call_count` from it.

## Two-Tier Model Routing

The agent uses a two-tier model strategy to optimize cost:

- **Tier 1 (GPT-4.1-mini)**: Default for ~70% of banks. Cheap ($0.40/$1.60 per 1M tokens).
- **Tier 2 (GPT-4.1)**: For complex banks and retries. Capable ($2.00/$8.00 per 1M tokens).

### Pre-routing (`selectInitialTier`)

Some banks go straight to Tier 2 (no mini attempt):

| Condition | Reason |
|-----------|--------|
| `isIBU === true` | GIFT City discovery is complex |
| `mode === "expand-nri"` | Multi-page NRI discovery |
| `scraper_type === "html_js"` in bank-domains.json | JS-rendered pages need Playwright + HTML interpretation |
| Notes mention WAF/CAPTCHA/bot protection | Needs careful handling |

### Post-run quality check (`checkQuality`)

After a Tier 1 run completes, the output is inspected:

| Check | Fails when |
|-------|-----------|
| Agent success | `result.success === false` |
| Config exists | No `_config.json` written |
| Scraper type | `manual` despite known domain (unexpected) |
| Rate slabs | 0 slabs and scraper_type ≠ manual |
| Confidence | `extraction_confidence` is "none" or "low" |

If any check fails, Tier 1 output files are cleaned up and the agent retries with the full model. Both attempts' traces are preserved (`bank.trace.jsonl` + `bank_attempt2.trace.jsonl`).

### Cost impact

| Scenario | Mini cost | Full cost | Total |
|----------|-----------|-----------|-------|
| Mini succeeds (70%) | ~$0.04 | — | $0.04 |
| Mini fails → full retry (30%) | ~$0.04 | ~$0.15 | $0.19 |
| **Weighted average** | | | **~$0.09/bank** |

vs $0.15-0.19/bank with full model always → ~50% savings from the two-tier approach.

## Search-Free Architecture

The agent does **not** depend on any paid search API. Domain discovery uses a three-layer strategy:

1. **Domain cache** (`data/bank-domains.json`): Pre-looked up by `run-discovery.js`, injected into the user prompt. Agent skips search entirely for cached banks.
2. **bank.in probing** (`scripts/guess-bank-in.js`): Generates candidate `.bank.in` domains from bank names and probes with HEAD requests. Zero cost.
3. **Claude Code search** (`prompts/discover-domains.md`): For banks where probing fails, uses Claude Code CLI (which has built-in WebSearch) for domain-only discovery.

### Domain cache details

Every successful discovery run writes back to `bank-domains.json` via `lib/domain-cache.js`. Two update paths:
- **Incremental** (automatic): `run-discovery.js` calls `updateDomainEntry()` post-run
- **Bulk** (manual): `node scripts/sync-domains.js` backfills from all existing configs

**Merge rules:** Existing non-null values are never overwritten. New rate page URLs fill gaps. Explicitly `null` = searched, not found (distinct from never searched). `null` can be upgraded to a URL if later discovered.

### Web search strategy (3 layers)

The `web_search` tool in `lib/tools.js` tries three strategies in order:

1. **Bing Search API** — if `BING_SEARCH_API_KEY` is set (direct API, fastest)
2. **Azure OpenAI Responses API** — if Azure OpenAI endpoint is configured (uses built-in `web_search` tool with Bing grounding, no separate resource needed, ~$2/1K transactions)
3. **Graceful fallback** — guides the agent to try `<slug>.bank.in` directly, use known domain info, or fetch the homepage for links

For domain discovery, `scripts/run-domain-discovery.js` uses the Responses API directly via `lib/azure-openai-responses.js` — batches banks, gets domains + rate page URLs with citations, and merges into `bank-domains.json`.

### Two APIs, two purposes

| API | Used by | Purpose |
|-----|---------|---------|
| **Chat Completions** | `lib/agent.js` (main agent loop) | Rate extraction — function calling with read/write/fetch tools |
| **Responses API** | `lib/azure-openai-responses.js` | Domain/page discovery — built-in web search with Bing grounding |

This separation keeps the main agent loop efficient (no search cost for cached banks) while providing search capability when needed.

### bank.in domain priority

Per RBI directive, all Indian banks must migrate to `.bank.in`. The discovery prompt searches `site:bank.in` first. `.bank.in` is always recorded as canonical even if a legacy domain also exists.

### NRI product independence

NRE, NRO, and FCNR are separate products with independent rate schedules. The prompt explicitly states they must be fetched and extracted independently — never assumed to match domestic FD rates. Each variant gets its own rate file. A `null` URL means "searched, not found" (distinct from never searched).

## Backward Compatibility

- **run-batch.js**: Spawns `run-discovery.js` as subprocess — same CLI interface, same exit codes, same output files. No changes needed.
- **run-pipeline.js**: Same. Reads `.summary.json` — same format. Status machine unchanged.
- **scripts/extract_rates.js**: Deterministic extraction — no LLM, completely independent.
- **Output format**: Identical JSON files (`_config.json`, `_rates.json`, variants). The `normalizeRatesFile()` post-processing still runs.
