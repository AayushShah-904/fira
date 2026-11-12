# Phase 1: Orchestrated Discovery Pipeline

## Problem

The current system has two separate entry points (`run-discovery.js` for one bank, `run-batch.js` for many) but no intelligence about *what work each bank actually needs*. Every invocation either runs the full LLM discovery or the full deterministic extractor — there's no middle ground, no status awareness, no attempt to avoid re-doing work that's already been done.

The operator currently has to decide manually:
- Which banks need discovery? → `run-batch.js banks.csv --category "..."`
- Which banks need NRI expansion? → `run-batch.js banks.csv --expand-nri`
- Which banks need fresh rates? → `run-batch.js banks.csv --rates-only`
- Which banks can skip the LLM? → `run-batch.js banks.csv --extract-only`

This is error-prone, and more importantly it wastes LLM budget: banks that have captured selectors get the full $0.46 LLM treatment when a $0.00 deterministic extraction would work; banks with stale rate data get completely skipped unless the operator remembers to run `--rates-only`.

## Goal

A single command that:

```bash
node run-pipeline.js banks.csv --batch-size 10
```

1. Reads the master CSV
2. For each bank, determines what work is needed based on its current state
3. Picks the cheapest method that can do that work (deterministic first, LLM fallback)
4. Processes banks in batches of N, reporting progress after each batch
5. Can be interrupted and resumed without re-doing completed work
6. Handles the full lifecycle: first discovery → rate extraction → periodic refresh → revision detection

---

## Per-bank status machine

Status is derived from what exists in `output/latest/` — no separate status database. The filesystem IS the state.

### Status classification

```
For a given bank_code, check output/latest/:

1. No <bank_code>_config.json exists?
   → status: PENDING
   → action: full LLM discovery

2. Config exists, scraper_type = "manual"?
   Check config.notes and scraper_notes for keywords:
     "no website", "not found" → status: NO_WEBSITE
     "captcha", "blocked", "WAF", "403" → status: BLOCKED
     otherwise → status: MANUAL
   → action: skip (log reason)

3. Config exists, scraper_type != "manual",
   but no <bank_code>_rates.json OR rate_slabs = [] ?
   → status: PARSE_FAIL
   → action: deterministic extract first, LLM fallback

4. Config exists, rate_slabs.length > 0,
   but scraped_at is older than --max-age (default 7 days)?
   → status: STALE
   → action: deterministic re-extract, compare to previous

5. Config exists, rate_slabs.length > 0,
   scraped_at is within --max-age?
   → status: CURRENT
   → action: skip (already fresh)
```

### State transitions

```
PENDING ──[LLM discover]──→ PARSE_FAIL  (if 0 slabs)
                          ──→ EXTRACTED   (if slabs > 0)
                          ──→ BLOCKED     (if CAPTCHA / WAF)
                          ──→ NO_WEBSITE  (if no site found)

PARSE_FAIL ──[deterministic]──→ EXTRACTED (if slabs > 0)
           ──[LLM retry]────→ EXTRACTED  (if slabs > 0)
           ──[both fail]────→ PARSE_FAIL (stays, logged)

EXTRACTED ──[time passes]──→ STALE

STALE ──[deterministic re-extract]──→ CURRENT (rates unchanged)
      ──[deterministic re-extract]──→ EXTRACTED (rates changed, updated)
      ──[deterministic fails]──────→ PARSE_FAIL (site changed?)

BLOCKED / NO_WEBSITE / MANUAL → stay (only change via --retry-blocked flag)
```

### What "deterministic extract" means

This is `scripts/extract_rates.js`'s `extractBank(code)` function. It:
1. Reads the config from `output/latest/<code>_config.json`
2. Routes to `extractHtmlStatic`, `extractHtmlJs` (via Playwright), or `extractPdf` based on `scraper_type`
3. Uses the config's `selectors`, `column_mapping`, and `rate_page_urls` — no web searching, no LLM
4. Writes `*_rates.json` files with the canonical schema

It succeeds when:
- `html_static` banks have populated `selectors` + `column_mapping` + `rate_page_urls.fd`
- `pdf` banks have a `scraper_notes.pdf_url` or `rate_page_urls.fd` ending in `.pdf`
- `html_js` banks have `rate_page_urls.fd` (Playwright fetches and extracts)

It fails (returns 0 slabs) when:
- Selectors are stale (site redesigned)
- URL returns 403/404 (page moved)
- The page structure doesn't match the captured column_mapping

**Current readiness (from audit):** 80 banks with full selectors + col_map + URL, 28 more html_js via Playwright, 16 PDF = **108 banks deterministic-ready**.

### What "LLM fallback" means

Spawn `claude -p` via `run-discovery.js` with the appropriate mode:
- PENDING bank → `discover` mode (full Steps 0–5)
- PARSE_FAIL bank → `rates-only` mode (URLs known, just re-extract via LLM interpretation)
- STALE bank where deterministic failed → `rates-only` mode

The LLM path captures selectors in the config, so a bank that goes through LLM once becomes deterministic-ready for all future runs.

---

## The action router

For each bank, the pipeline chooses an action based on status:

| Status | Primary action | Fallback |
|---|---|---|
| **PENDING** | LLM discover | — |
| **PARSE_FAIL** | Deterministic extract | LLM rates-only |
| **STALE** | Deterministic extract | LLM rates-only (if deterministic yields 0) |
| **CURRENT** | Skip | — |
| **BLOCKED** | Skip (log) | LLM discover (only with `--retry-blocked`) |
| **NO_WEBSITE** | Skip (log) | LLM discover (only with `--retry-blocked`) |
| **MANUAL** | Skip (log) | — |

The key decision: **deterministic always runs first when a config exists.** LLM is only invoked when deterministic produces 0 slabs or no config exists. This is the "use agent only when needed" principle.

### Cost per action

| Action | Wall clock | LLM cost | When used |
|---|---|---|---|
| Skip | 0s | $0 | CURRENT, BLOCKED, NO_WEBSITE |
| Deterministic extract | ~5s | $0 | PARSE_FAIL, STALE (first attempt) |
| LLM discover | ~116s | ~$0.46 | PENDING |
| LLM rates-only | ~60–90s\* | ~$0.30\* | PARSE_FAIL fallback, STALE fallback |

\* Estimated for `--rates-only` mode (narrower scope than full discover). Not yet measured.

---

## Batch processing

### The loop

```
Load CSV → deduplicate → classify status for all banks
                              ↓
Sort by priority: PENDING > PARSE_FAIL > STALE > rest
                              ↓
While banks remain and budget allows:
  Take next N banks (--batch-size, default 10)
  For each bank in batch:
    Run action router (deterministic first, LLM fallback)
    Record outcome
    Update output/latest/ (status derived from new files)
  Print batch summary (succeeded, failed, skipped, cost)
  Check rate-limit state; apply backoff if needed
  Write checkpoint so --resume can continue
```

### Batch summary output

After each batch of N:

```
=== Batch 3 (banks 21-30 of 1995) ===
  PENDING  → discovered:  3  (2 with slabs, 1 blocked)
  PARSE_FAIL → fixed:     1  (deterministic succeeded)
  STALE → refreshed:      4  (2 rates unchanged, 2 updated)
  CURRENT → skipped:      2
  Cost this batch: $1.38  (3 LLM calls)
  Wall clock: 6m12s
  Running total: 30/1995 processed, $4.20 spent
```

### Resume and checkpointing

The pipeline writes `output/latest/_pipeline_state.json` after each batch:

```json
{
  "last_run": "2026-04-12T10:00:00Z",
  "csv_file": "docs/Indian_Banks_Comprehensive_List_RBI.csv",
  "banks_processed": 30,
  "banks_total": 1995,
  "status_counts": {
    "current": 120,
    "stale": 40,
    "pending": 1800,
    "blocked": 15,
    "no_website": 10,
    "parse_fail": 10
  },
  "total_cost_usd": 4.20,
  "total_wall_sec": 3720
}
```

On `--resume`, the pipeline reads this file and skips banks already at CURRENT status. Banks at STALE get re-checked. Banks at PARSE_FAIL get retried.

---

## Rate revision detection (STALE → CURRENT)

For a STALE bank (has rate slabs, but scraped_at is old):

1. **Run deterministic extractor** against the existing config
2. **Compare new slabs to existing slabs:**
   - If slab count and rate values match → mark as CURRENT (rates unchanged), update `scraped_at`
   - If rates differ → write new rates file, log the delta
3. **If deterministic fails** (0 slabs, 403, etc.) → the page may have changed structure. Fall back to LLM `--rates-only` to re-learn the page.

The comparison is slab-by-slab: match on `tenure_min_days` + `tenure_max_days`, compare `rate_general_pct` and `rate_senior_pct`. Any change in any slab means "rates revised."

This is cheap (~5s, $0) when the deterministic path works, and only costs LLM budget when the site has structurally changed — which is rare (monthly at most for well-maintained bank sites).

---

## File changes

### New file: `run-pipeline.js`

The main orchestrator. Subsumes `run-batch.js`'s CSV iteration + batch logic, adds the status machine and action router.

```
Usage:
  node run-pipeline.js banks.csv                    # process all, auto-detect status
  node run-pipeline.js banks.csv --batch-size 20    # larger batches
  node run-pipeline.js banks.csv --category "PSB"   # filter by category
  node run-pipeline.js banks.csv --max-age 3        # treat rates older than 3 days as stale
  node run-pipeline.js banks.csv --resume            # continue from checkpoint
  node run-pipeline.js banks.csv --retry-blocked     # retry CAPTCHA/WAF banks
  node run-pipeline.js banks.csv --dry-run           # show what would happen, don't execute
```

Key internal structure:

```js
// 1. Load CSV, compute bank_code slug for each
// 2. classifyStatus(bankCode) → reads output/latest/, returns status enum
// 3. Sort banks by priority
// 4. Batch loop:
//    For each bank:
//      a. tryDeterministic(bankCode) → spawn extract_rates.js, check result
//      b. If deterministic succeeded → done
//      c. If not and status warrants LLM → spawn run-discovery.js with mode
//      d. Record outcome
//    Print batch summary
//    Write checkpoint
```

### Modified: `run-discovery.js`

No structural changes. The pipeline calls it as a subprocess for LLM runs, same as `run-batch.js` does today. The `--output-dir` flag already lets the pipeline control where output goes.

One small addition: a `--skip-domain-lookup` flag. When the pipeline is invoking run-discovery.js, the pipeline has already done its own status classification and knows the bank's state. No need for run-discovery.js to re-read bank-domains.json — the pipeline injects the context. (This is the lever P mechanism already in place.)

### Modified: `scripts/extract_rates.js`

Currently expects to be run as `node scripts/extract_rates.js <bank_code>` and reads configs from `output/`. Needs a small tweak:

- Accept `--config-dir <path>` to read configs from a specified directory (defaults to `output/` for backward compat). The pipeline will pass `output/latest/` so the deterministic extractor reads from the canonical location.
- Exit with code 0 if slabs extracted, code 1 if not. (May already behave this way — needs verification.)
- Stdout should emit slab count so the pipeline can parse it without reading the rates file.

### Existing: `run-batch.js`

Not modified. Remains available as a simpler alternative for operators who want the old "one mode, one CSV filter" behavior. The pipeline is the new recommended entry point.

---

## `--dry-run` mode

Before committing to $866 of LLM spend, the operator should see what the pipeline *would* do:

```bash
node run-pipeline.js banks.csv --dry-run
```

Output:

```
=== Pipeline Dry Run ===
Master CSV: 1,995 banks

Status breakdown:
  CURRENT:      109  (skip — rates fresh)
  STALE:         48  (deterministic re-extract, $0 each)
  PARSE_FAIL:     8  (deterministic first, LLM fallback ~$0.30 each)
  BLOCKED:       15  (skip — CAPTCHA/WAF)
  NO_WEBSITE:    10  (skip — no site)
  MANUAL:         3  (skip)
  PENDING:    1,802  (LLM discover ~$0.46 each)

Estimated actions:
  Deterministic extractions:    56  (~5 min total, $0)
  LLM discover calls:       1,802  (~58h sequential, ~$829)
  LLM rates-only fallbacks:    ~4  (~6 min, ~$1.20)
  Skipped:                    137

Total estimated cost: ~$830
Total estimated time: ~58h sequential, ~12h at concurrency=5
```

This lets the operator decide batch size, concurrency, category filters, and budget before any real work starts.

---

## Priority ordering

Banks are processed in this order within each batch:

1. **PARSE_FAIL** — cheapest to fix (deterministic, ~5s). Quick wins.
2. **STALE** — second cheapest (deterministic re-extract, ~5s). Keeps existing data fresh.
3. **PENDING by category priority:**
   - PSB → PVB → SFB → FB → IBU → PB → SSCB → SUCB → RRB → DCCB → NSUCB → FI
   - Within each category: alphabetical
   - Rationale: higher-traffic bank categories first (PSBs cover the most depositors)
4. **BLOCKED / NO_WEBSITE / MANUAL** — last (only with `--retry-blocked`)

---

## Example scenarios

### Scenario 1: First full run (from scratch)

```bash
node run-pipeline.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --batch-size 10
```

All 1,995 banks are PENDING. Pipeline processes 10 at a time. Each gets LLM discovery (~$0.46 each). After each batch, checkpoint saves. Operator can ctrl-C and `--resume` later. PSBs processed first, then PVBs, etc.

Estimated: ~$830 LLM, ~58h sequential.

### Scenario 2: Resume after partial run

```bash
node run-pipeline.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --resume --batch-size 20
```

Pipeline reads `_pipeline_state.json`, skips CURRENT banks, retries PARSE_FAIL, discovers remaining PENDING. Picks up exactly where it left off.

### Scenario 3: Weekly refresh

```bash
node run-pipeline.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --max-age 7
```

Most banks are CURRENT (scraped within 7 days) → skipped. A few are STALE → deterministic re-extract (~5s each). Maybe 2-3 have structurally changed → LLM fallback. Total cost: ~$1-2 for the whole portfolio, ~10 min.

### Scenario 4: Just the cooperative banks

```bash
node run-pipeline.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv \
  --category "Non-Scheduled Urban Co-operative Bank" \
  --batch-size 10 --resume
```

Filters to 1,392 NSUCBs. Of those, ~696 may have no website (50% hit rate from audit). Pipeline discovers 10 at a time. No-website banks fast-fail in ~60s/$0.29 each. Banks with websites get fully discovered in ~116s/$0.46 each. Total estimated: ~$689 for the full NSUCB sweep.

### Scenario 5: Check what would happen

```bash
node run-pipeline.js ../docs/Indian_Banks_Comprehensive_List_RBI.csv --dry-run
```

No LLM calls, no fetches. Just reads output/latest/ and prints the status breakdown + cost estimate.

---

## Implementation plan

### Step 1: Status classifier (~30 lines)

A pure function `classifyBank(bankCode, latestDir, maxAgeDays)` that reads config + rates files and returns `{ status, config, slabCount, scraped_at, reason }`.

### Step 2: Action router (~60 lines)

Given a status, runs the correct action:
- `tryDeterministic(bankCode)` → spawn `scripts/extract_rates.js`, check exit code + slab count
- `runLlmDiscovery(bank, mode)` → spawn `run-discovery.js` with appropriate flags
- Normalizes output files via `normalize-rates.js` after each action

### Step 3: Batch loop + checkpoint (~100 lines)

CSV parser (reuse from run-batch.js), priority sorter, batch chunking, checkpoint write/read, summary printing.

### Step 4: Rate comparison for STALE banks (~40 lines)

Load old slabs, run deterministic extract, compare slab-by-slab, log deltas.

### Step 5: Dry-run mode (~20 lines)

Classify all banks, aggregate status counts, estimate cost, print.

### Step 6: Small tweaks to extract_rates.js

- `--config-dir` flag
- Clean exit code behavior
- Slab count on stdout

**Total estimated: ~300 lines of new code in `run-pipeline.js`, ~20 lines of tweaks to `scripts/extract_rates.js`.**

---

## What this does NOT do

- **Does not change the LLM prompts or agent behavior.** The agent still runs the same discover.md / extract.md prompts. The improvement comes from calling it less often.
- **Does not build a web UI or dashboard.** Status is filesystem-derived + JSON checkpoint.
- **Does not handle CAPTCHA bypass.** BLOCKED banks are skipped. Phase 4 (Playwright stealth) is a separate future step.
- **Does not replace run-batch.js or run-discovery.js.** Both still work as before. The pipeline is a smarter alternative that subsumes their common usage patterns.
- **Does not parallelize within a single bank** (multiple URLs concurrently). One bank at a time, but multiple banks can overlap via --concurrency.

---

## Success criteria

1. `--dry-run` correctly classifies all 1,995 banks and estimates cost within 20% of actuals.
2. Deterministic extraction succeeds for ≥70 of the 80 ready banks (some may have stale selectors).
3. A 10-bank mixed-status batch completes with correct routing (PENDING → LLM, PARSE_FAIL → deterministic, STALE → re-extract, CURRENT → skip).
4. `--resume` correctly picks up where a ctrl-C'd run left off.
5. Weekly refresh of the full covered portfolio costs <$5 and takes <30 min.
