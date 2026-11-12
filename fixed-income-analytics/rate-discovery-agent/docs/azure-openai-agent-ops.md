# Azure OpenAI Agent — Operations Guide

## Prerequisites

1. **Azure OpenAI resource** with a GPT-4o deployment
2. **Bing Search API** resource (for the `web_search` tool)
3. **Node.js 20+** with npm
4. **Playwright browsers**: `npx playwright install chromium` (for JS-rendered bank pages)

## Setup

```bash
cd rate-discovery-agent
npm install
cp .env.example .env
# Edit .env with your Azure credentials
```

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint | `https://myresource.openai.azure.com` |
| `AZURE_OPENAI_API_KEY` | API key for the resource | `abc123...` |
| `AZURE_OPENAI_DEPLOYMENT_MINI` | Tier 1 (cheap) deployment name | `gpt-4.1-mini` |
| `AZURE_OPENAI_DEPLOYMENT_FULL` | Tier 2 (capable) deployment name | `gpt-4.1` |
| `BING_SEARCH_API_KEY` | Bing Search v7 API key | `xyz789...` |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AZURE_OPENAI_DEPLOYMENT` | `gpt-4.1` | Legacy single-model fallback |
| `AZURE_OPENAI_API_VERSION` | `2024-12-01-preview` | Azure OpenAI API version |
| `BING_SEARCH_ENDPOINT` | `https://api.bing.microsoft.com/v7.0/search` | Bing endpoint |
| `AGENT_MAX_TOOL_CALLS` | `15` | Max tool calls per bank before forcing completion |
| `LOG_LEVEL` | `warn` | Default log level (error/warn/info/debug/trace) |
| `AZURE_OPENAI_INPUT_PRICE_PER_1M` | `2.00` | Input token cost for cost tracking (GPT-4.1) |
| `AZURE_OPENAI_OUTPUT_PRICE_PER_1M` | `8.00` | Output token cost for cost tracking (GPT-4.1) |

## Running

### Single Bank Discovery

```bash
# Full discovery
node run-discovery.js "State Bank of India" "Public Sector Bank" "Maharashtra"

# With verbose logging
node run-discovery.js "HDFC Bank Limited" "Private Sector Bank (Indian)" --log-level debug

# NRI expansion (requires existing config)
node run-discovery.js "State Bank of India" --expand-nri

# Re-extract rates only (requires existing config with URLs)
node run-discovery.js "State Bank of India" --rates-only
```

### Batch Processing

```bash
# Process all banks in a CSV
node run-batch.js banks.csv

# Filter by category, limit count
node run-batch.js banks.csv --category "Public Sector Bank" --limit 5

# With debug logging
node run-batch.js banks.csv --category "Small Finance Bank" --log-level info
```

### Pipeline (Status-Aware)

```bash
# Dry run — show what would happen
node run-pipeline.js banks.csv --dry-run

# Process pending + stale banks
node run-pipeline.js banks.csv --batch-size 10

# Resume from checkpoint
node run-pipeline.js banks.csv --resume

# Rebuild bank index
node run-pipeline.js banks.csv --rebuild-index --dry-run
```

## Output Structure

```
output/
├── latest/                          # Current state (always up-to-date)
│   ├── _bank_index.json             # Index of all discovered banks
│   ├── state-bank-of-india_config.json
│   ├── state-bank-of-india_rates.json
│   ├── state-bank-of-india_nre_rates.json
│   ├── state-bank-of-india.log
│   └── ...
├── runs/                            # Per-run archives (timestamped)
│   ├── 20260414T120000_state-bank-of-india/
│   │   ├── state-bank-of-india_config.json
│   │   ├── state-bank-of-india_rates.json
│   │   ├── state-bank-of-india.log
│   │   ├── state-bank-of-india.trace.jsonl
│   │   └── state-bank-of-india.summary.json
│   └── ...
└── archive/                         # Superseded/old files
    ├── first-wave/                  # Original pre-pipeline output
    └── sbi/                         # Old-slug files from reconciliation
```

## Log Levels

| Level | When to use | What you see |
|-------|-------------|--------------|
| `error` | Something broke | Fatal failures only |
| `warn` | **Default for batch** | Timeouts, truncations, budget exhaustion, tool failures |
| `info` | Single-bank runs | Per-bank summary line (scraper type, slab count, cost) |
| `debug` | Troubleshooting | Tool call details, prompt sizes, file operations |
| `trace` | Deep debugging | Full API request/response bodies, full HTML (**file only, never console**) |

```bash
# Quiet batch run (only errors and warnings on console)
node run-batch.js banks.csv

# Verbose single bank (see tool calls on console)
node run-discovery.js "SBI" --log-level debug

# Full trace for debugging (writes to .log file, not console)
node run-discovery.js "SBI" --log-level trace
# Then inspect: output/runs/<timestamp>_state-bank-of-india/state-bank-of-india.log
```

## Cost Monitoring

Each run produces a `.summary.json` with cost breakdown:

```json
{
  "total_cost_usd": 0.1876,
  "input_tokens": 52340,
  "output_tokens": 3210,
  "tool_call_count": 8,
  "wall_clock_ms": 45000,
  "model": "gpt-4.1"
}
```

**Two-tier model strategy:**

The agent uses GPT-4.1-mini (Tier 1) for the initial attempt and falls back to GPT-4.1 (Tier 2) if the output quality check fails. Some complex banks are pre-routed directly to Tier 2.

| Scenario | Model | Tokens (approx) | Cost (approx) |
|----------|-------|-----------------|---------------|
| Tier 1 succeeds (~70% of banks) | gpt-4.1-mini | ~55K in, ~4K out | ~$0.03 |
| Tier 1 fails → Tier 2 retry (~20%) | mini + full | ~55K + ~55K | ~$0.17 |
| Pre-routed to Tier 2 (~10%) | gpt-4.1 | ~55K in, ~4K out | ~$0.14 |
| Web search | — | — | $0 (see below) |

**Weighted average: ~$0.06/bank** (vs ~$0.46 with Claude Code CLI).
**Full pipeline (500 banks):** ~$30.

**Pre-routing to Tier 2 (skips mini):** IBU banks, expand-nri mode, html_js scraper type, WAF/CAPTCHA noted in bank-domains.json.

**Quality check triggers retry:** 0 slabs extracted, low/none confidence, scraper_type "manual" despite known domain, agent failure.

### Search costs: eliminated

The agent does **not** depend on Bing Search or any paid search API. Bank domains are discovered through a three-layer strategy (see Domain Discovery below), and once cached in `bank-domains.json`, the agent never searches for that bank again.

### Aggregate cost from batch results:

```bash
node -e "
const fs = require('fs');
const dir = 'output/latest';
let total = 0, count = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.summary.json'))) {
  const s = JSON.parse(fs.readFileSync(dir + '/' + f));
  if (s.total_cost_usd) { total += s.total_cost_usd; count++; }
}
console.log(count + ' banks, $' + total.toFixed(2) + ' total, $' + (total/count).toFixed(3) + '/bank avg');
"
```

## Rate Limiting

### Azure OpenAI
- The client (`lib/azure-openai-client.js`) retries on HTTP 429 with exponential backoff (1s → 2s → 4s, max 3 retries)
- If you hit persistent rate limits, increase the delay between banks in `run-batch.js` (`--delay` flag) or reduce `--concurrency`
- Check your Azure OpenAI deployment's TPM (tokens per minute) quota in the Azure portal

### Bing Search
- Bing Search API has a default rate of 3 calls/second on the free tier
- Each bank typically uses 1-2 searches
- The agent does not retry Bing 429s — it returns the error to the model, which moves on

## Troubleshooting

### "Missing AZURE_OPENAI_ENDPOINT env var"
→ Create `.env` from `.env.example` and fill in your Azure credentials.

### "Missing BING_SEARCH_API_KEY env var"
→ The web_search tool needs a Bing Search API key. If you don't have one, the agent can't search for bank websites — it will only work with banks already in `data/bank-domains.json`.

### Agent produces empty rate files
→ Check the log file (`output/runs/<run>/bank.log`) for tool errors. Common causes:
- HTML page is JS-rendered but agent used `fetch_url` instead of `run_playwright` → scraper_type should be `html_js`
- Bank page returns 403/CAPTCHA → config will have `scraper_type: "manual"`
- PDF rate page → agent should note the PDF URL in config

### Tool budget exhausted
→ The agent hit the 15-call limit. This can happen for banks with complex page structures. Options:
- Increase `AGENT_MAX_TOOL_CALLS` in `.env`
- Pre-populate the bank's entry in `data/bank-domains.json` to skip website search steps

### High cost on a run
→ Check `summary.json` for token counts. Large HTML pages inflate input tokens. The `truncateHtml()` function caps at 80K chars — if pages are routinely large, lower the limit in `lib/tools.js` (`MAX_FETCH_CHARS`).

## Domain Discovery & Search Costs

The agent does **not** depend on any paid search API (Bing, Google, etc.). Bank domains are discovered through a three-layer strategy and cached in `data/bank-domains.json`. Once a domain is cached, the agent never searches for that bank again.

### Three-layer domain discovery

| Layer | Tool | Cost | Coverage |
|-------|------|------|----------|
| **1. Domain cache** | `data/bank-domains.json` | $0 | 287 banks already cached |
| **2. bank.in probing** | `scripts/guess-bank-in.js` | $0 | Generates candidates from bank name, probes with HEAD requests |
| **3. Responses API search** | `scripts/run-domain-discovery.js` | ~$0.002/bank | Uses Azure OpenAI Responses API with built-in web_search (Bing grounding) |

**Layer 1** is checked automatically by `run-discovery.js` before starting the agent. If the bank's domain and rate page are known, the agent skips straight to fetching and extracting.

**Layer 2** is a zero-cost script that constructs likely `.bank.in` URLs from bank names and probes them:
```bash
# Probe all uncached banks in the CSV
node scripts/guess-bank-in.js banks.csv

# Dry run — show candidates without probing
node scripts/guess-bank-in.js banks.csv --dry-run

# Single bank
node scripts/guess-bank-in.js --bank "HDFC Bank Limited"

# Filter by category
node scripts/guess-bank-in.js banks.csv --category "Small Finance Bank" --limit 20
```

**Layer 3** uses the Azure OpenAI Responses API with built-in `web_search` tool (Bing grounding). No separate Bing Search resource needed — just the same Azure OpenAI endpoint. Cost: ~$2 per 1K search transactions.
```bash
# Discover domains for all uncached banks in the CSV
node scripts/run-domain-discovery.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv

# Preview batches without calling API
node scripts/run-domain-discovery.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --dry-run

# Filter by category
node scripts/run-domain-discovery.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "District Central Co-operative Bank" --batch-size 10

# Limit and control rate
node scripts/run-domain-discovery.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --limit 50 --delay 10
```
Results are saved to `bank-domains.json` after each batch (safe to interrupt).

### Domain cache management

```bash
# Backfill from all existing configs → bank-domains.json
node scripts/sync-domains.js

# Preview what would change
node scripts/sync-domains.js --dry-run

# Check a specific bank's cache entry
node -e "const d=JSON.parse(require('fs').readFileSync('data/bank-domains.json')); console.log(d['state-bank-of-india'])"
```

The cache is also updated **automatically** after each successful agent run — `run-discovery.js` writes the discovered domain and URLs back to `bank-domains.json`.

### bank.in domain priority

Per RBI directive, all Indian banks must migrate to `.bank.in` domains. The agent and the probing script both prioritize `.bank.in`. When a bank has both a legacy domain (`.com`, `.co.in`) and a `.bank.in` domain, `.bank.in` is always recorded as canonical. Some smaller co-op banks may not have migrated yet — legacy domains are used as fallback.

### Graceful fallback when no search API is configured

If `BING_SEARCH_API_KEY` is not set, the `web_search` tool returns a helpful message guiding the agent to:
1. Use the pre-looked-up domain info (from the cache)
2. Try `https://<bank-slug>.bank.in` directly
3. Fetch the homepage and look for rate page links

The agent can still discover rates for most banks without any search API.

## Azure Deployment

For Container Apps Jobs deployment, see `docs/azure-deployment-plan.md` Phase 5. The Dockerfile should:

1. Use `node:20-slim` base
2. Install Playwright Chromium: `npx playwright install --with-deps chromium`
3. Copy the rate-discovery-agent project
4. Set env vars from Azure Key Vault or Container Apps secrets
5. Entry point: `node run-pipeline.js /data/banks.csv --resume`
