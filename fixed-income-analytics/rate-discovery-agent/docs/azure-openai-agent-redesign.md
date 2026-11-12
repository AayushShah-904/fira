# Redesign: Azure OpenAI Agent for Rate Discovery

## Context

The rate-discovery-agent currently spawns `claude -p` (Claude Code CLI) as a child process for each bank. Claude reads CLAUDE.md (the full ~5K-token prompt) plus a mode-specific prompt, makes tool calls, and writes output JSON. This has two problems: (1) it couples the agent to a local Claude Code installation, and (2) it loads the entire CLAUDE.md for every interaction regardless of mode.

The Azure deployment plan (`docs/azure-deployment-plan.md`) calls this out: *"The rate-discovery-agent will be redesigned to call Azure OpenAI directly via the OpenAI SDK."*

This redesign **also** takes the opportunity to:
- **Decompose CLAUDE.md** into modular prompt fragments, so each mode only loads what it needs (saving 40-60% of prompt tokens in expand-nri and extract modes)
- **Improve logging** with proper 5-level logging (trace/debug/info/warn/error), default `warn`

## Architecture

```
BEFORE:                                    AFTER:
run-discovery.js                           run-discovery.js
  └─ spawn("claude -p ...")                  └─ runAgent({ systemPrompt, userPrompt, tools })
       └─ Claude CLI handles tools                └─ lib/agent.js (agent loop)
            CLAUDE.md = 5K tokens always               ├─ Azure OpenAI Chat Completions API
            WebSearch (built-in)                        ├─ lib/prompts/ (modular prompt builder)
            WebFetch  (built-in)                        └─ lib/tools.js (local tool dispatch)
            Read/Write/Bash (built-in)                       ├─ web_search  → Bing Search API
                                                             ├─ fetch_url   → HTTP GET + HTML cleanup
                                                             ├─ read_file   → fs.readFileSync
                                                             ├─ write_file  → fs.writeFileSync
                                                             └─ run_playwright → subprocess
```

## Prompt Decomposition: CLAUDE.md → Modular Fragments

### Current CLAUDE.md sections and per-mode relevance

| Section | Tokens | discover | expand-nri | extract |
|---------|--------|----------|------------|---------|
| Identity/Role (L1-3) | ~50 | Yes | Yes | Yes |
| Invocation (L5-17) | ~100 | **DELETE** | **DELETE** | **DELETE** |
| Efficiency Rules (L19-27) | ~200 | Yes | Partial | No |
| Step 0: Domain Lookup (L29-51) | ~300 | **No** (orchestrator does this) | **No** | **No** |
| Step 1: Find Website (L53-65) | ~200 | Yes | No | No |
| Step 2: Find Rate Pages (L67-72) | ~100 | Yes | No | No |
| Step 2b: NRI/FCNR (L73-97) | ~400 | Yes | Yes | No |
| Step 2c: GIFT City (L99-116) | ~250 | Conditional (IBU) | No | No |
| Step 3: Scraper Type (L118-145) | ~400 | Yes | No | Yes |
| Step 4: Extract Rates (L147-199) | ~500 | Yes | Yes | Yes |
| Step 5a: Config Schema (L201-253) | ~500 | Yes | Yes | No |
| Step 5b: Rate File Schema (L257-315) | ~600 | Yes | Yes | Yes |
| Bank Type Table (L317-337) | ~200 | Yes | No | No |
| Important Rules (L339-347) | ~150 | Subset | Subset | Subset |
| Output/Slug (L349-374) | ~300 | Yes | Yes | Yes |

**Current:** Every mode loads ~4,300 tokens.
**After decomposition:**

| Mode | Fragments included | Est. tokens | Savings |
|------|-------------------|-------------|---------|
| discover | base + website + rate-pages + nri + scraper + extraction + config-schema + rate-schema + bank-types + rules | ~3,200 | 25% (Step 0 + Invocation removed) |
| expand-nri | base + nri + extraction + config-schema + rate-schema + rules-subset | ~1,900 | 56% |
| extract | base + scraper + extraction + rate-schema + rules-subset | ~1,700 | 60% |

### New file: `lib/prompts/fragments.js`

Exports prompt fragments as named string constants, each a self-contained section. The orchestrator in `run-discovery.js` calls `buildSystemPrompt(mode, bankType)` which concatenates only the relevant fragments.

```js
// lib/prompts/fragments.js

const IDENTITY = `You are a Bank Rate Discovery Agent for the Indian Bank Interest Rate
Aggregator project. You are invoked for one bank at a time. Your job is to find the
bank's official website, locate interest rate pages, and extract deposit interest rates
into a standardised JSON config + rate data file.`;

const EFFICIENCY_RULES = `## Efficiency Rules
You have a budget of {maxToolCalls} tool calls. Prefer fewer, larger calls over many small ones.
1. Do not retry failed fetch URLs. If a URL returns an error (403, 404, timeout), move on.
2. Do not search for NRI/FCNR pages for co-ops, RRBs, Payments Banks, or LABs.
3. Write config and rates files in the same turn when possible.
4. Always write _rates.json even if extraction yields zero slabs (use rate_slabs: [] with a warning).
5. Skip NRI discovery unless bank type is PSB, PVB, FB, IBU, or large SFB.`;

const STEP_FIND_WEBSITE = `## Find the Official Website
1. Search the web for: "<bank name>" official website india
2. Look for .bank.in (RBI mandated) or .com/.co.in/.org domains.
3. Do NOT fetch the homepage just to verify — trust clear search results.
4. For small co-op banks, try: "<bank name>" interest rates deposit
5. Record the official website URL.

Priority: .bank.in > .co.in/.com/.org with bank name. Avoid aggregators (bankbazaar, paisabazaar, cleartax, groww).`;

const STEP_FIND_RATE_PAGES = `## Find Interest Rate Pages
1. Fetch the homepage once and look for links containing: interest rate, deposit rate, FD rate, fixed deposit.
2. If no rate link found, web search: site:<domain> interest rate deposit
3. Fetch the single most likely rate page — do not fetch multiple candidates.
4. Classify by product type: FD, RD, Savings Account, etc.`;

const STEP_NRI_FCNR = `## Find NRI/FCNR Rate Pages
After finding the domestic FD page, search for NRI deposit pages:
1. Search for links containing: NRE deposit, NRO deposit, NRI fixed deposit, FCNR deposit rates, foreign currency deposit
2. Try URL patterns: /nri-deposits, /nri-interest-rates, /fcnr-rates, /nri-banking
3. If not found on homepage: site:<domain> NRI deposit interest rate
4. Many banks have a single combined NRI page (NRE + NRO + FCNR) — record as fd_nri_combined.
5. Some banks publish separate PDFs per variant.

Key rules:
- NRE/NRO rates are in INR. FCNR rates are in foreign currencies (USD, GBP, EUR, JPY, CAD, AUD).
- FCNR has no senior citizen premium. Min tenure 1 year (365d), max 5 years (1825d).
- If not found, set URL fields to null — don't force it.`;

const STEP_GIFT_CITY = `## Find GIFT City / IFSC Rate Pages (IBU Only)
IBU banks operate under IFSCA in GIFT City, Gujarat. Deposits are in foreign currency, NOT covered by DICGC.
1. Rate pages are typically under the parent bank's IFSC/GIFT City section.
2. Search: site:<parent_domain> GIFT City deposit rates
3. URL patterns: /gift-ifsc/, /ifsc-banking/, /international-banking/gift-city/, /ibu/deposit-rates
4. Some IBUs share pages with parent bank's FCNR section.
5. Use parent_bank_code from bank-domains.json to find the parent domain.

Output: bank_type: "IBU", deposit_insurance: false. Rate files use variant: "gift" with currency per slab.`;

const STEP_SCRAPER_TYPE = `## Classify Scraper Type
| Type | How to Identify |
|------|----------------|
| html_static | Rate numbers visible in raw HTML (e.g., "6.50%", "7 days to 14 days") |
| html_js | Empty containers, React/Angular/Vue roots, rate data loaded by JS |
| pdf | Rate page links to downloadable PDF instead of inline rates |
| mixed | Some products in HTML, others in PDFs |
| government | Government gazette / ministry notification format |
| manual | No website, behind CAPTCHA/login |

For html_js pages, use the run_playwright tool instead of fetch_url — it renders JavaScript.`;

const STEP_EXTRACT_RATES = `## Extract Rate Data
When you fetch a rate page, also extract rate data in the same step.

For html_static: Record table CSS selectors, column mapping (tenure, general rate, senior rate), effective date location.
For html_js: Record framework, bot protection, data format (tables vs divs), interactive elements (tabs, dropdowns).
For pdf: Record exact PDF URL, column structure, date in filename.

Record scraper notes in config:
{ framework, bot_protection, data_format, rate_tables_on_page, has_tabs, has_dropdowns, has_lazy_loading }`;

const CONFIG_SCHEMA = `## Config File Schema
{ bank_code, bank_name, bank_type, category, website, scraper_type,
  rate_page_urls: { fd, fd_nre, fd_nro, fd_fcnr, fd_nri_combined, savings, rd },
  selectors: { table, rows, effective_date },
  column_mapping: { "0": "tenure_text", "1": "rate_general_pct", "2": "rate_senior_pct" },
  expected_slab_count, notes, scraper_notes: { framework, bot_protection, data_format, rate_tables_on_page },
  discovery_metadata: { discovered_at, discovery_method, confidence } }

Fields with defaults (omit if matching): tenure_parser="standard_indian", rate_multiplier=1.0,
senior_citizen_premium="same_table", deposit_insurance=true, update_frequency="monthly"`;

const RATE_SCHEMA = `## Rate File Schema (STRICT — use exact field names)
{ bank_code, bank_name, product_type: "FD", variant: "regular"|"nre"|"nro"|"fcnr"|"gift",
  effective_date, source_url, scraped_at: "<ISO-8601 UTC>", extraction_confidence,
  rate_slabs: [{ tenure_text, tenure_min_days, tenure_max_days, rate_general_pct,
    rate_senior_pct, rate_super_senior_pct, deposit_range }],
  special_schemes: [], warnings: [], errors: [] }

CRITICAL field names — downstream silently drops wrong names:
- rate_slabs (NOT slabs), product_type: "FD" (NOT product/fd), scraped_at (NOT extracted_at)
- tenure_min_days/tenure_max_days (NOT min_days/max_days)
- rate_general_pct as number (6.50, NOT "6.50%")
- FCNR/GIFT slabs must include "currency" field. No senior rates for FCNR/GIFT.
- If zero slabs, write rate_slabs: [] with extraction_confidence: "none" and a warning.

Deposit ranges: below_3cr (default), 3cr_to_5cr, 5cr_to_25cr, 25cr_to_100cr, above_100cr.
Co-op tiers: below_15l, 15l_to_1cr, 1cr_to_10cr, above_10cr.`;

const BANK_TYPE_TABLE = `## Bank Type Classification
| Category | bank_type |
|----------|-----------|
| Public Sector Bank | PSB |
| Private Sector Bank (Indian) | PVB |
| Small Finance Bank | SFB |
| Payments Bank | PB |
| Foreign Bank | FB |
| Regional Rural Bank | RRB |
| Scheduled Urban Co-operative Bank | SUCB |
| Non-Scheduled Urban Co-operative Bank | NSUCB |
| Scheduled State Co-operative Bank | SSCB |
| Non-Scheduled State Co-operative Bank | NSSCB |
| District Central Co-operative Bank | DCCB |
| Local Area Bank | LAB |
| Financial Institution | FI |
| IFSC Banking Unit | IBU |
| Housing Finance Company | HFC |`;

const RULES_CORE = `## Important Rules
1. Never use aggregator sites (bankbazaar, paisabazaar, cleartax, groww) as the source.
2. Respect rate limits — 3-5 fetches for domestic FD + 2-3 for NRI per bank.
3. Be honest about confidence in warnings.
4. Handle failures gracefully — produce config with scraper_type: "manual" and empty rate data.
5. Record CSS selectors accurately — they'll be used by the automated scraper.
6. Many small co-op banks don't have websites — note clearly and check state co-op portal.`;

const OUTPUT_SLUG = `## Output File Naming
Files: <output_dir>/<bank_code>_config.json, <bank_code>_rates.json,
  <bank_code>_nre_rates.json, <bank_code>_nro_rates.json,
  <bank_code>_fcnr_rates.json, <bank_code>_gift_rates.json

bank_code slug algorithm: lowercase → remove non-alphanumeric except spaces/hyphens →
  replace spaces/underscores with hyphens → collapse multiple hyphens → trim.
Examples: "State Bank of India" → state-bank-of-india, "HDFC Bank Limited" → hdfc-bank-limited
Do NOT abbreviate — always use the full name.`;

module.exports = {
  IDENTITY, EFFICIENCY_RULES, STEP_FIND_WEBSITE, STEP_FIND_RATE_PAGES,
  STEP_NRI_FCNR, STEP_GIFT_CITY, STEP_SCRAPER_TYPE, STEP_EXTRACT_RATES,
  CONFIG_SCHEMA, RATE_SCHEMA, BANK_TYPE_TABLE, RULES_CORE, OUTPUT_SLUG,
};
```

### New file: `lib/prompts/build-prompt.js`

```js
// lib/prompts/build-prompt.js
const f = require("./fragments");

function buildSystemPrompt(mode, { bankType, isIBU } = {}) {
  const parts = [f.IDENTITY];

  if (mode === "discover") {
    parts.push(f.EFFICIENCY_RULES, f.STEP_FIND_WEBSITE, f.STEP_FIND_RATE_PAGES);
    if (["PSB","PVB","FB","SFB","IBU"].includes(bankType)) parts.push(f.STEP_NRI_FCNR);
    if (isIBU) parts.push(f.STEP_GIFT_CITY);
    parts.push(f.STEP_SCRAPER_TYPE, f.STEP_EXTRACT_RATES, f.CONFIG_SCHEMA, f.BANK_TYPE_TABLE);
  } else if (mode === "expand-nri") {
    parts.push(f.STEP_NRI_FCNR, f.STEP_EXTRACT_RATES, f.CONFIG_SCHEMA);
  } else if (mode === "rates-only") {
    parts.push(f.STEP_SCRAPER_TYPE, f.STEP_EXTRACT_RATES);
  }

  parts.push(f.RATE_SCHEMA, f.RULES_CORE, f.OUTPUT_SLUG);
  return parts.join("\n\n");
}

module.exports = { buildSystemPrompt };
```

The existing `prompts/discover.md`, `prompts/expand-nri.md`, `prompts/extract.md` become the **user message** (with template variable substitution), unchanged.

### What happens to CLAUDE.md?

CLAUDE.md remains in the repo as documentation but is **no longer loaded at runtime**. A comment at the top notes: *"This file is reference documentation. Runtime prompts are built from lib/prompts/fragments.js."*

---

## Enhanced Logging

### Current state: `scripts/utils/logger.js`
- 4 levels: error (0), warn (1), info (2), debug (3)
- Default: `info`

### New design: add `trace` level, default to `warn`

```
LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 }
Default: warn
```

| Level | Use for |
|-------|---------|
| `error` | Fatal failures: spawn crash, missing env vars, file write failure |
| `warn` | Non-fatal issues: tool timeout, HTML truncation, empty slabs, rate-limit hit |
| `info` | Per-bank summary line, mode/status, slab counts, cost — the "headline" |
| `debug` | Tool call details (name, duration, error), prompt size, file copies |
| `trace` | Full tool arguments, full HTML responses (truncated), full API request/response bodies |

### Changes to `scripts/utils/logger.js`

```diff
- const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
+ const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

- function createLogger(level = "info") {
+ function createLogger(level = "warn") {

  // Add trace method:
+ trace: (...args) => log("trace", ...args),
```

### Logging in the agent loop

```
trace  → Full API request messages, full response body, full tool arguments + results
debug  → "API call #3: 1234 prompt tokens, 567 completion tokens"
         "Tool: web_search (1200ms) → 8 results"
info   → "Bank of India [DISCOVER] | html_js | 12 domestic slabs | $0.19"
warn   → "HTML truncated from 250K to 80K chars"
         "Tool fetch_url failed: HTTP 403"
         "Tool budget exhausted at 15 calls"
error  → "Azure OpenAI API error: 401 Unauthorized"
         "Missing AZURE_OPENAI_ENDPOINT env var"
```

### Callers updated

- `run-discovery.js`: Default log level changes from `"info"` to `"warn"`
- `run-batch.js` / `run-pipeline.js`: Already pass `--log-level` through

---

## New Files

### 1. `lib/azure-openai-client.js` (~80 lines)

Thin wrapper around the `openai` package's `AzureOpenAI` class.

- `createClient()` → configured `AzureOpenAI` instance
- `chatCompletion(client, messages, tools, toolChoice, model)` → wraps `client.chat.completions.create()`:
  - Retry on 429 (exponential backoff: 1s → 2s → 4s, max 3)
  - Retry on 500/503 (once)
  - Temperature 0.1
  - Logs retries at `warn`

Env vars: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` (default `gpt-4.1`), `AZURE_OPENAI_API_VERSION` (default `2024-12-01-preview`).

### 2. `lib/tools.js` (~300 lines)

Tool definitions (OpenAI function-calling schema) + implementations.

| Tool | Parameters | Implementation |
|------|-----------|----------------|
| `web_search` | `{query: string}` | Bing Search v7, `mkt=en-IN`, top 8 results as readable text |
| `fetch_url` | `{url: string}` | HTTPS GET + redirects, `truncateHtml()` to 80K chars, 30s timeout |
| `read_file` | `{file_path: string}` | `fs.readFileSync`, restricted to project root, max 100KB |
| `write_file` | `{file_path: string, content: string}` | `fs.writeFileSync`, restricted to output dir, creates parent dirs |
| `run_playwright` | `{url, scroll?, tabs?, selects?, intercept?}` | `spawnSync("node scripts/fetch_rates_playwright.js ...")`, 60s timeout |

`truncateHtml(html, maxChars=80000)`: strips `<script>`, `<style>`, `<head>`, `<nav>`, `<footer>`, `<svg>`, comments, collapses whitespace. If still over limit, extract `<table>` elements + surrounding context. Logs at `warn`.

`executeTool(name, args, context)` — dispatcher. On error returns `{"error": "..."}`.

Env vars: `BING_SEARCH_API_KEY`, `BING_SEARCH_ENDPOINT`.

### 3. `lib/prompts/fragments.js` (~350 lines)

CLAUDE.md decomposed into named string constants (see Prompt Decomposition section above).

### 4. `lib/prompts/build-prompt.js` (~60 lines)

`buildSystemPrompt(mode, { bankType, isIBU })` — assembles fragments for the mode.

### 5. `lib/agent.js` (~200 lines)

Core agent loop.

```js
async function runAgent({
  systemPrompt,   // from buildSystemPrompt()
  userPrompt,     // mode-specific prompt + domain context
  outputDir,      // for write_file sandboxing
  projectRoot,    // for read_file sandboxing
  maxToolCalls,   // default 15
  logger,         // logger instance
  onToolCall,     // callback(name, args, result, durationMs, isError)
  onApiCall,      // callback(usage)
}) → { success, finalText, toolCalls[], usage, costUsd, elapsedMs }
```

Loop:
1. `messages = [{role: "system", content: systemPrompt}, {role: "user", content: userPrompt}]`
2. Loop (max 20 iterations):
   a. `chatCompletion()` — trace-log full messages, debug-log token counts
   b. Accumulate usage via `onApiCall`
   c. `finish_reason === "stop"` → done
   d. `tool_calls` → execute each, push results, increment counter
   e. Counter >= maxToolCalls → `tool_choice: "none"`, warn-log
   f. 3 consecutive errors → force termination, warn-log
3. Compute cost, return

### 6. `lib/cost-tracker.js` (~100 lines)

Mirrors `trace-parser.js` API for drop-in replacement in `run-discovery.js`.

- `createCostTracker()` → `{ recordApiCall, recordToolCall, getSummary, getToolCalls, getRawEvents, getFinalText, setFinalText }`
- `getSummary()` matches trace-parser shape: `{ total_cost_usd, tool_call_count, wall_clock_ms, tokens, model, ... }`
- Cost from env: `AZURE_OPENAI_INPUT_PRICE_PER_1M` (2.50), `AZURE_OPENAI_OUTPUT_PRICE_PER_1M` (10.00)

### 7. `.env.example`

```
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_DEPLOYMENT=gpt-4.1
AZURE_OPENAI_API_VERSION=2024-12-01-preview
BING_SEARCH_API_KEY=
BING_SEARCH_ENDPOINT=https://api.bing.microsoft.com/v7.0/search
AGENT_MAX_TOOL_CALLS=15
AZURE_OPENAI_INPUT_PRICE_PER_1M=2.50
AZURE_OPENAI_OUTPUT_PRICE_PER_1M=10.00
LOG_LEVEL=warn
```

---

## Modified Files

### 8. `run-discovery.js`

**Lines 1-194 (arg parsing, run dir, pre-flight, prompt building):** Mostly unchanged. Key changes:
- Import `buildSystemPrompt` instead of reading CLAUDE.md
- Import `runAgent`, `createCostTracker`
- Remove `createTraceParser` import
- Default log level: `"warn"` (was `"info"`)
- Determine `bankType` from category string
- Call `buildSystemPrompt(mode, { bankType, isIBU })`

**Lines 205-394 (Claude spawn + close handler):** Replace with:
```js
(async () => {
  const tracker = createCostTracker();
  const result = await runAgent({
    systemPrompt: buildSystemPrompt(mode, { bankType, isIBU }),
    userPrompt: prompt,
    outputDir: runDir,
    projectRoot: __dirname,
    maxToolCalls: parseInt(process.env.AGENT_MAX_TOOL_CALLS || "15", 10),
    logger: log,
    onToolCall: (name, args, resultStr, durationMs, isError) => {
      tracker.recordToolCall(name, durationMs, isError, ...);
    },
    onApiCall: (usage) => tracker.recordApiCall(usage),
  });

  // Post-processing (reused from current code):
  // - Write trace.jsonl, summary.json
  // - Normalize rate files
  // - Count slabs, copy to latest/
  // - Print summary, flush log
})().catch(err => { log.error(err.message); process.exit(1); });
```

### 9. `scripts/utils/logger.js` — Add `trace` level, change default to `warn`

### 10. `package.json` — Add `"openai": "^4.73.0"`

### 11. `.gitignore` — Add `.env`

---

## Unchanged Files

| File | Why |
|------|-----|
| `run-batch.js` | Subprocess interface preserved |
| `run-pipeline.js` | Subprocess interface + summary.json format preserved |
| `scripts/extract_rates.js` | Deterministic, no LLM |
| `scripts/fetch_rates_playwright.js` | Called as subprocess by run_playwright tool |
| `scripts/utils/normalize-rates.js` | Pure utility |
| `scripts/utils/validate-rates.js` | Pure utility |
| `scripts/utils/parse-tenure.js` | Pure utility |
| `scripts/utils/slugify.js` | Pure utility |
| `data/bank-domains.json` | Data file |
| `prompts/*.md` | User message templates — still used |

---

## Token Budget per Mode

| Mode | System | User | Fetches | Tool results | Output | Total |
|------|--------|------|---------|--------------|--------|-------|
| discover | ~3,200 | ~700 | ~45,000 | ~2,500 | ~4,000 | ~55K |
| expand-nri | ~1,900 | ~600 | ~30,000 | ~1,500 | ~3,000 | ~37K |
| extract | ~1,700 | ~500 | ~30,000 | ~1,000 | ~3,000 | ~36K |

All within GPT-4o's 128K window.

## Tool Budget

15 calls (configurable via `AGENT_MAX_TOOL_CALLS`). Higher than Claude's 8 because Azure OpenAI treats each search/fetch as separate round-trips. Enforced by agent loop: after limit, `tool_choice: "none"`.

## Cost Comparison

| | Claude Code CLI | Azure OpenAI GPT-4o |
|--|----------------|---------------------|
| Per bank (LLM) | ~$0.46 | ~$0.15-0.19 |
| Per bank (search) | included | ~$0.006 (Bing) |
| **Total per bank** | **~$0.46** | **~$0.16-0.20** |
| 219 banks full run | ~$101 | ~$35-44 |

Modular prompts compound the savings (25-60% fewer system prompt tokens).

## Implementation Order

```
Step 1:  lib/prompts/fragments.js        (decompose CLAUDE.md)
Step 2:  lib/prompts/build-prompt.js     (depends on 1)
Step 3:  lib/azure-openai-client.js      (standalone)
Step 4:  lib/tools.js                    (standalone)
Step 5:  lib/agent.js                    (depends on 3, 4)
Step 6:  lib/cost-tracker.js             (standalone)
Step 7:  scripts/utils/logger.js         (add trace, change default)
Step 8:  run-discovery.js                (depends on 2, 5, 6, 7)
Step 9:  .env.example, package.json, .gitignore
```

Steps 1, 3, 4, 6, 7 can run in parallel.

## Verification

1. **Prompt assembly:** Unit test `buildSystemPrompt()` for each mode
2. **Tool tests:** Each tool in isolation (Bing search, fetch, read/write, Playwright)
3. **Single bank E2E:** `node run-discovery.js "State Bank of India" "Public Sector Bank" --log-level debug`
4. **Mode parity:** Test discover, expand-nri, rates-only on 1 bank each
5. **Logging levels:** `--log-level trace` shows full bodies; default `warn` shows only warnings
6. **Batch:** `node run-batch.js banks.csv --category "Payments Bank" --limit 3`
7. **Pipeline:** `node run-pipeline.js banks.csv --dry-run --limit 20`
8. **Output comparison:** 5 banks vs Claude-generated output — same schema, similar slab counts

## Risks

| Risk | Mitigation |
|------|-----------|
| GPT-4o prompt adherence differs from Claude | Modular design makes per-fragment tuning easy |
| HTML truncation loses rate data | Prioritize `<table>` extraction, warn-log, test with large pages |
| Bing vs Claude's WebSearch quality | `mkt=en-IN`, `site:` prefix support |
| Azure OpenAI TPM limits | Exponential backoff + inter-bank delay |
| Function call JSON parse errors | try/catch, return error to model |
| Fragment assembly incoherence | Unit test assembled prompts per mode |
