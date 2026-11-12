# Agent Modes, Output Organization & Logging

## Context

The rate discovery agent currently has a single mode: full discovery (find website → find rate pages → record metadata). Rate extraction is split to a separate deterministic scraper. This causes problems:
1. The agent already fetches the page to classify it — not extracting rates wastes that work
2. Complex pages (JS-rendered, tabbed, NRI combined pages) are hard for the deterministic parser
3. For the 96 banks with existing domestic configs, we need to add NRE/NRO/FCNR — but re-running full discovery wastes time on Steps 1-2
4. Even with "discovery only" scope, the agent still times out at 5 minutes
5. All output goes to a flat `output/` folder with no run history
6. Logs have no structure or levels

---

## Changes

### 1. Three Agent Modes

**Files:** `prompts/discover.md`, `prompts/expand-nri.md`, `prompts/extract.md`, `run-discovery.js`, `CLAUDE.md`

#### Mode A: Full Discovery (existing, enhanced)
- **When:** New bank, no config exists
- **Flag:** default (no flag)
- **Prompt:** `prompts/discover.md` (updated)
- **What:** Steps 0-5 + extract all rates (domestic + NRI if found)
- **Agent writes:** `_config.json` + `_rates.json` + `_nre_rates.json` etc.

Changes to `prompts/discover.md`:
- Remove "You do NOT need to extract actual rate numbers"
- Instruct agent to extract rates from each page it visits
- Include Step 2b (NRI/FCNR pages) in the workflow
- Output both config AND rate files

#### Mode B: NRI Expansion
- **When:** Config exists with `fd` URL but no `fd_nre`/`fd_nro`/`fd_fcnr`
- **Flag:** `--expand-nri`
- **Prompt:** `prompts/expand-nri.md` (new)
- **What:** Read existing config → search known domain for NRI pages → extract NRI + domestic rates
- **Agent writes:** updated `_config.json` + all rate files

Prompt instructs the agent to:
1. Read existing `output/<code>_config.json`
2. Use the known `website` domain — skip Steps 1-2
3. Run Step 2b only (find NRI/FCNR rate pages on the known domain)
4. Update the config with new `fd_nre`/`fd_nro`/`fd_fcnr` URLs
5. Fetch each known rate page (domestic + NRI) and extract rates
6. Write all rate files

#### Mode C: Re-extract Only
- **When:** Config exists with all URLs populated, just want fresh rate data
- **Flag:** `--rates-only`
- **Prompt:** `prompts/extract.md` (new)
- **What:** Read existing config → fetch all known URLs → extract rates
- **Agent writes:** all rate files (config unchanged)

Prompt instructs the agent to:
1. Read existing `output/<code>_config.json`
2. For each URL in `rate_page_urls` (fd, fd_nre, fd_nro, fd_fcnr), fetch and extract
3. Write rate files — no web searching, no config changes

#### `run-discovery.js` changes:
- Add `--expand-nri` and `--rates-only` flags
- Select prompt file based on flag
- For `--expand-nri` and `--rates-only`: verify config exists before invoking agent, fail fast if not
- Remove the post-agent `extract_rates.js` call (agent now extracts directly)
- Pass output directory path to the agent via prompt so it writes to the right place (see section 2)

#### `CLAUDE.md` changes:
- Update Step 4 header: "Classify, Record Metadata & Extract Rates"
- Remove "You do NOT need to extract actual rate numbers"
- Add: "When you fetch a rate page, extract the rate data and write the corresponding `_rates.json` file. This is more efficient than a separate extraction step."
- Keep the instruction that config writing is the primary goal; rate extraction is best-effort

#### `run-batch.js` changes:
- Add `--expand-nri` and `--rates-only` flags that pass through to `run-discovery.js`
- When `--expand-nri`: only process banks that have a config but no `fd_nre` URL
- When `--rates-only`: only process banks that have a config

---

### 2. Output Organization

**Files:** `run-discovery.js`, `run-batch.js`

Current: everything goes into `output/` flat.

New structure:
```
output/
  latest/                          ← symlink (or copy) to most recent run per bank
    state-bank-of-india_config.json
    state-bank-of-india_rates.json
    ...
  runs/
    2026-03-30_143022_psb-batch/   ← batch run folder
      state-bank-of-india_config.json
      state-bank-of-india_rates.json
      state-bank-of-india.log
      bank-of-baroda_config.json
      ...
      _batch_results.json
    2026-03-30_150510_sbi/         ← single bank run folder
      state-bank-of-india_config.json
      state-bank-of-india_rates.json
      state-bank-of-india.log
```

**Folder naming:** `YYYY-MM-DD_HHmmss_<label>`
- Batch: label = slugified category filter (e.g., `psb-batch`, `pvb-expand-nri`)
- Single: label = bank code

**`latest/` folder:** After each run, copy the output files to `output/latest/` so the import pipeline and other tools always have a predictable path. This replaces the current flat `output/` behavior.

**Backward compat:** The import pipeline (`packages/scraper/src/import/import-discovery.ts`) scans a directory for `*_config.json` files. Pointing it at `output/latest/` works unchanged. Pointing at a specific run folder also works.

**run-discovery.js changes:**
- Create run folder: `output/runs/<timestamp>_<bankCode>/`
- Pass the run folder path to the agent prompt (so it writes files there)
- After agent completes, copy outputs to `output/latest/`
- Write log to the run folder

**run-batch.js changes:**
- Create batch run folder: `output/runs/<timestamp>_<label>/`
- Each bank's outputs go into the same batch folder
- Copy all outputs to `output/latest/` at end
- `_batch_results.json` goes in the run folder

**Migration:** Move existing flat output files into `output/latest/` on first run (or leave them and let `latest/` accumulate naturally as banks are re-run).

---

### 3. Structured Logging

**Files:** `scripts/utils/logger.js` (new), `run-discovery.js`, `run-batch.js`

Create a simple logger utility with levels: `error`, `warn`, `info`, `debug`.

```js
// scripts/utils/logger.js
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(level = "info", logFile = null) {
  const threshold = LOG_LEVELS[level] ?? 2;
  const lines = [];

  function log(lvl, ...args) {
    if (LOG_LEVELS[lvl] > threshold) return;
    const prefix = `[${new Date().toISOString()}] [${lvl.toUpperCase().padEnd(5)}]`;
    const msg = `${prefix} ${args.join(" ")}`;
    console.log(msg);
    lines.push(msg);
  }

  return {
    error: (...args) => log("error", ...args),
    warn:  (...args) => log("warn", ...args),
    info:  (...args) => log("info", ...args),
    debug: (...args) => log("debug", ...args),
    flush: () => { if (logFile) fs.writeFileSync(logFile, lines.join("\n") + "\n"); },
    lines,
  };
}
```

**`run-discovery.js`:**
- Accept `--log-level` flag (default: `info`)
- Use logger for all output: discovery progress, agent spawn, extraction, timing
- `info`: bank name, mode, elapsed time, result summary
- `debug`: prompt text, raw agent output size, file paths written
- `warn`: timeouts, missing config for --expand-nri, partial results
- `error`: spawn failures, parse errors
- Flush to `<run-folder>/<bankCode>.log`

**`run-batch.js`:**
- Accept `--log-level` flag (default: `info`)
- Use logger for batch-level messages (progress, skip/retry decisions, summary)
- Each bank's subprocess still writes its own log via run-discovery.js

---

## Execution Order

1. Create `scripts/utils/logger.js`
2. Update `CLAUDE.md` — agent now extracts rates
3. Update `prompts/discover.md` — add rate extraction instructions
4. Create `prompts/expand-nri.md`
5. Create `prompts/extract.md`
6. Update `run-discovery.js` — three modes, output folders, logging
7. Update `run-batch.js` — pass-through flags, batch folders, logging

---

## Verification

1. **Full discovery (single):** `node run-discovery.js "UCO Bank" "Public Sector Bank"` → creates `output/runs/<ts>_uco-bank/` with config + rates, copies to `output/latest/`
2. **NRI expansion:** `node run-discovery.js "State Bank of India" --expand-nri` → reads existing SBI config, finds NRI pages, writes NRE/FCNR rate files
3. **Re-extract:** `node run-discovery.js "Bank of Baroda" --rates-only` → fetches known URLs, writes fresh rate files
4. **Batch:** `node run-batch.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --category "Public Sector Bank" --expand-nri` → runs NRI expansion for all PSBs with existing configs
5. **Logging:** `--log-level debug` shows prompt text and agent output sizes; `--log-level warn` shows only problems
