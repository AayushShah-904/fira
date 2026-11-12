# Operator guide — PM rate-pack refresh 2026-Q2 (local run)

> Standalone runbook for executing the 513-bank cohort `pm-refresh-2026-q2`
> locally. Companion to:
> - [plan](../plan/pm-rate-pack-refresh-2026-q2.md) — the full refresh plan
> - [AUM research handoff](../plan/co-op-aum-research-handoff-2026-05-20.md) — DCCB / NSUCB selection methodology
> - [12-bank smoke report](cohort-smoke-12-cloud-2026-05-20.md) — validation of the partial_silent / drift code paths the run depends on

## Cohort at a glance

**File**: `data/cohorts/pm-refresh-2026-q2.json` (committed at `84396d2`).
**Banks**: 513 across 14 categories. **+76% vs last pack** (292 → 513).

| Category | Count |
|---|---:|
| Non-Scheduled Urban Co-operative Bank | 132 |
| District Central Co-operative Bank | 130 |
| Scheduled Urban Co-operative Bank | 52 |
| Foreign Bank | 44 |
| IFSC Banking Unit (IFSCA) | 37 |
| Regional Rural Bank | 28 |
| Scheduled State Co-operative Bank | 24 |
| Private Sector Bank (Indian) | 21 |
| Public Sector Bank | 12 |
| Small Finance Bank | 11 |
| Non-Scheduled State Co-operative Bank | 10 |
| Payments Bank | 6 |
| Financial Institution | 4 |
| Local Area Bank | 2 |
| **Total** | **513** |

DCCB and NSUCB cohorts merge: operator-curated top-100 lists (by AUM)
∪ last pack's coverage ∪ NAFSCOB award winners (DCCB only). The union
guarantees the new pack never regresses below the last delivery.

## Pre-flight checklist

```bash
cd C:\sw\BharatOmni\UFA\BIRD\rate-discovery-agent
git log --oneline -1                              # confirm HEAD has the cohort
git status                                        # working tree clean
ls data/cohorts/pm-refresh-2026-q2.json           # cohort file present
node run-batch.js --cohort pm-refresh-2026-q2 --dry-run | tail -3
# Expect: "Resolved 513 bank(s) [mode=cohort]"
```

Environment:

| Var | Required for | Typical value |
|---|---|---|
| `AZURE_OPENAI_ENDPOINT` | LLM extraction | `https://<name>.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` *or* MSI | AOAI auth | api key OR Azure-CLI logged in |
| `AZURE_OPENAI_DEPLOYMENT_FULL` | tier-2 model | `gpt-4.1` (or current full deployment) |
| `AZURE_OPENAI_DEPLOYMENT_MINI` | tier-1 model | `gpt-4.1-mini` |
| `BIRD_STORAGE` | data plane | unset / `local` for local runs (do NOT set to `azure` here) |

For local runs, `BIRD_STORAGE` should NOT be `azure` — that would trigger
cloud-sync push at end-of-batch, which is undesired during a local
delivery. Confirm:

```powershell
$env:BIRD_STORAGE   # should be empty or 'local'
```

Playwright sanity (for html_js scrapers):

```bash
npx playwright --version
# If absent: npx playwright install chromium
```

## The run

```bash
node run-batch.js --cohort pm-refresh-2026-q2 --concurrency 3
```

| Flag | Effect |
|---|---|
| `--cohort pm-refresh-2026-q2` | Reads `data/cohorts/pm-refresh-2026-q2.json` (513 banks). |
| `--concurrency 3` | Runs 3 banks in parallel. Code allows up to 5, but **5 is untested at cohort scale**: risks AOAI 429 burst, ~5 GB Chromium RAM, and write contention on `data/bank-domains.json`. 3 is the safer default. |

**Note: `--resume` is NOT in the recommended command.** See the next section for why and what to use instead.

### Expected timing & cost

| Metric | Value |
|---|---|
| Wall clock | **~7 hours** at concurrency 3 (513 × ~3 min/bank ÷ 3). Slower banks (retries, drift-trigger) push this; budget up to **9 h** safely. At concurrency 5 it would be ~5 h but with the risks above. |
| AOAI cost | **~$25-35** ($0.05/bank × 513, plus ~30% retry overhead for drift retries). Cost is the same at any concurrency. |
| Disk | ~30-50 MB additional under `output/runs/<batch-label>/` and `output/latest/` |

### Run-time signals to expect

| Per-bank line | What it means |
|---|---|
| `>>> [N/513] <slug> [DISCOVER]` | Bank started |
| `OK <duration> \| <scraper_type> \| <slabs> \| <url> [<model>] \| $<cost> \| <tool_calls> tool calls` | Bank succeeded |
| `attempt 1 quality check failed: slab drift on <variant>: <actual> < 0.8 * <expected> (floor)` | Drift detected → retry attempt 2 |
| `[METRIC] slab_drift bank=<slug> variant=<v> actual=<n> expected=<m> source=<floor\|prior>` | Structured metric emission (also visible in LAW for cloud runs) |
| `partial_silent: drift persists after 3 attempts (<reason>)` | Drift not recovered after MAX_ATTEMPTS; partial_silent marker written |
| `Wrote partial_silent marker: <slug>.partial_silent.json` | Marker persisted; bank will be excluded from pack and git publish |
| `Cleared stale partial_silent marker: <slug>.partial_silent.json` | A bank that previously had a marker now passes drift → marker removed |
| `FAIL <duration> \| No output files generated` | Bank failed after 3 attempts; usually WAF block on cloud (less common locally) |
| `RATE LIMITED: <slug>` | AOAI 429 hit; delay automatically increases; sequence eventually pauses 5 min if hits keep occurring |

A live progress tail in another shell:

```powershell
Get-Content output/runs/<latest-batch-label>/_batch_results.json -Wait
```

Or simpler — watch the latest log file:

```powershell
$latest = Get-ChildItem output/latest/*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $latest.FullName -Tail 20 -Wait
```

### Recovery (Ctrl+C / crash — use this pattern, NOT `--resume`)

`Ctrl+C` once is graceful (finishes the in-flight bank, then exits).
A second `Ctrl+C` is hard kill — the in-flight bank loses progress.

**Don't use `--resume` for this refresh.** The `--resume` skip logic in
`run-batch.js#checkResume` cannot distinguish "fresh config from THIS
batch" vs "stale config from prior PM-pack work or earlier smokes". For
banks where `output/latest/<slug>_config.json` already existed before
this batch (≈292 of our 513 — the prior-pack overlap), `--resume` would
skip them on a restart even if they were never processed in this batch
— silently keeping the stale data.

**Safer pattern**: after a Ctrl+C, derive the "remaining" list from
this batch's run folder (not from `output/latest/`), then re-invoke
with `--banks`:

```powershell
# Identify this batch's run folder (most-recent timestamped folder)
$batchDir = (Get-ChildItem output/runs/ -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
Write-Host "Batch folder: $batchDir"

# Build a "remaining" file = cohort minus banks already completed THIS BATCH
$batchDirPosix = $batchDir.Replace('\', '/')
node -e "
const fs = require('fs');
const cohort = require('./data/cohorts/pm-refresh-2026-q2.json');
const dir = '$batchDirPosix';
const done = new Set(
  fs.readdirSync(dir)
    .filter(f => f.endsWith('_config.json'))
    .map(f => f.slice(0, -'_config.json'.length))
);
const remaining = cohort.filter(e => !done.has(e.bank_code)).map(e => e.bank_code);
fs.writeFileSync('output/runs/remaining-banks.txt', remaining.join('\n') + '\n');
console.log('Done in batch:', done.size, '| Remaining:', remaining.length);
"

# Re-invoke with --banks filter (CSV mode required for --banks)
node run-batch.js data/Indian_Banks_Comprehensive_List_RBI.csv `
  --banks output/runs/remaining-banks.txt --concurrency 3
```

This pattern is robust across multiple Ctrl+C cycles — each restart
re-derives the remaining list from the **most-recent batch folder**
(which contains only banks the agent actually processed since this
refresh started, not stale prior work).

### Multi-restart sanity check

Between cycles, verify completeness:

```powershell
# Bank-level config count in latest
(Get-ChildItem output/latest/*_config.json).Count

# Bank-level rates count
(Get-ChildItem output/latest/*_rates.json).Count

# If the two diverge by more than a handful, you may have banks where
# the agent died between writing config and writing rates. List them:
$configs = Get-ChildItem output/latest/*_config.json | ForEach-Object { $_.BaseName -replace '_config$','' }
$rates = Get-ChildItem output/latest/*_rates.json | ForEach-Object { $_.BaseName -replace '_rates$','' }
Compare-Object $configs $rates | Where-Object SideIndicator -eq '<='
```

For any bank that shows up in the Compare-Object output, force-rerun
with `--banks` filtered to those slugs.

## Post-run analysis

### 1. Tally what landed

```bash
node scripts/analysis/tally-smoke.js output/latest
```

Look at the `err`, `warn`, `vs baseline` columns. Anything > 0 in `err`
deserves a look at the corresponding `<slug>.log`.

### 2. Identify augment targets (banks that need a second pass)

```bash
node scripts/list-augment-targets.js \
  --cohort pm-refresh-2026-q2 \
  --previous-pack pack/dist/rates-pack.json \
  --out output/runs/pm-refresh-augment-list.txt \
  --report sdlc/sprints/sprint-004/implementation/pm-refresh-2026-q2-local-tally.md
```

This writes:
- `pm-refresh-augment-list.txt` — newline-separated slugs that need a second pass
- `pm-refresh-2026-q2-local-tally.md` — markdown report (pass/fail/partial counts + top gainers/losers vs previous pack)

A bank ends up on the list if any of:
1. `<slug>.partial_silent.json` exists (drift after retries)
2. `<slug>_config.json` missing (extraction never produced anything)
3. `<slug>_rates.json` exists but has 0 slabs (extraction_failed)
4. Total slab count < 80% of previous pack's count for that bank

### 3. Augment pass (if anything on the list)

```bash
node run-batch.js --banks output/runs/pm-refresh-augment-list.txt --concurrency 3
```

Note: `--banks` uses CSV mode, so you'll need to pass a CSV path; the
bundled `data/Indian_Banks_Comprehensive_List_RBI.csv` works:

```bash
node run-batch.js data/Indian_Banks_Comprehensive_List_RBI.csv \
  --banks output/runs/pm-refresh-augment-list.txt \
  --concurrency 3
```

Banks that recover get their `partial_silent` markers cleared
automatically (Sprint 4 Track A clear-on-recovery behaviour).

### 4. Diff against last delivery

```bash
node scripts/compare-pack.js pack/dist/rates-pack.json <(git show HEAD:rate-discovery-agent/pack/dist/rates-pack.json)
```

(Adjust the `git show` path if you've moved to a different branch since
the cohort commit.) Shows:
- Net bank delta (added / dropped)
- Top 20 slab gainers
- Top 20 slab losers
- Total slab counts both sides

### 5. Rebuild pack

The agent will already have called `pack/build-pack.js` at end-of-batch
(via `finalize()`). If you want to rebuild explicitly after manual
edits (e.g., clearing a marker by hand):

```bash
node pack/build-pack.js
```

The rebuilt `pack/dist/rates-pack.json` excludes any bank whose
`<slug>.partial_silent.json` marker still exists in `output/latest/`.
Skip count is logged.

### 5.5 Run the quality gate

Before publishing the pack to PM, compare it against the last delivered
baseline (`pack/history/rates-pack-2026-05-14.json` for this refresh).
The gate classifies every change as REGRESSION / ANOMALY / WARN / GAIN /
STABLE, writes a Markdown + JSON report into `pack/dist/`, and exits 1
on unaccepted blocking findings.

```bash
npm run quality-gate -- pack/dist/rates-pack.json pack/history/rates-pack-2026-05-14.json
# or directly:
node scripts/quality-gate.js pack/dist/rates-pack.json pack/history/rates-pack-2026-05-14.json
```

Outputs:
- `pack/dist/quality-report.md` — operator-readable report
- `pack/dist/quality-report.json` — machine-readable findings

If the verdict is `BLOCK`:
1. Read `pack/dist/quality-report.md` — investigate each regression /
   anomaly under the listed `bank_code` / `variant`.
2. Real defects: fix in `output/latest/` (re-run the bank, edit
   `data/bank-domains.json`, etc.) and rebuild the pack.
3. Legitimate regressions (bank closed, RBI directive, etc.):
   add an entry to `pack/quality-gate-accepts.json` with `bank_code`,
   optional `variant`, `reason`, and `approved_by` / `approved_at`,
   then rerun the gate.
4. Repeat until the gate exits `PASS` or `PASS_WITH_WARNINGS`.

Design doc: [`../design/pack-quality-gate.md`](../design/pack-quality-gate.md).

### 6. Commit + memo for PM

```bash
git add pack/dist/rates-pack.json data/bank-domains.json
git commit -m "pack: refresh 2026-Q2 — <N> banks, <M> slabs"
```

Memo template lives at
[`sdlc/sprints/sprint-003/probe/pack-confidence-memo-for-pm.md`](../../sprint-003/probe/pack-confidence-memo-for-pm.md).
Copy into `sdlc/sprints/sprint-004/implementation/pm-refresh-2026-q2-memo.md`
and adapt — sections to update:
1. Pack version + generated_at date
2. Bank coverage (513 vs prior 292)
3. Per-category counts (table above)
4. Excluded banks (those with `partial_silent` markers — include count + reasons)
5. Confidence assessment (high / medium per the drift gate's results)

## Inspecting the cohort

```bash
# Pretty-print in pager
cat data/cohorts/pm-refresh-2026-q2.json | less

# Just slugs by category, sorted
node -e "const c=require('./data/cohorts/pm-refresh-2026-q2.json'); for (const e of c) console.log(e.bank_code, '|', e.category, '|', e.state);" | sort

# Per-state count for any specific category
node -e "const c=require('./data/cohorts/pm-refresh-2026-q2.json'); const t={}; for (const e of c) if (e.category==='District Central Co-operative Bank') t[e.state]=(t[e.state]||0)+1; console.log(t);"

# Open in VS Code
code data/cohorts/pm-refresh-2026-q2.json
```

### Per-category contents (small categories)

The categories under 100 banks each are listed in full here for quick
reference; the larger DCCB / NSUCB lists are too long to inline — open
the JSON file.

**Public Sector Bank (12):** `punjab-national-bank` · `punjab-sind-bank` ·
`bank-of-baroda` · `canara-bank` · `bank-of-india` · `bank-of-maharashtra`
· `central-bank-of-india` · `state-bank-of-india` · `union-bank-of-india`
· `indian-bank` · `indian-overseas-bank` · `uco-bank`

**Private Sector Bank — Indian (21):** `axis-bank-limited` ·
`icici-bank-limited` · `jammu-kashmir-bank-limited` ·
`karnataka-bank-limited` · `csb-bank-limited` · `dhanlaxmi-bank-limited`
· `federal-bank-limited` · `south-indian-bank-limited` ·
`dcb-bank-limited` · `hdfc-bank-limited` · `idbi-bank-limited` ·
`indusind-bank-limited` · `kotak-mahindra-bank-limited` ·
`bandhan-bank-limited` · `rbl-bank-limited` · `yes-bank-limited` ·
`tamilnad-mercantile-bank-limited` · `karur-vysya-bank-limited` ·
`city-union-bank-limited` · `nainital-bank-limited` · `idfc-first-bank-limited`

**Small Finance Bank (11):** `au-` · `capital-` · `equitas-` · `esaf-` ·
`fincare-` · `jana-` · `north-east-` · `suryoday-` · `ujjivan-` ·
`unity-` · `utkarsh-small-finance-bank-limited`

**Payments Bank (6):** `airtel-` · `fino-` · `india-post-` · `jio-` ·
`nsdl-` · `paytm-payments-bank-limited`

**Financial Institution (4):** `exim-bank-of-india` · `nabard` · `nhb`
· `sidbi`

**Local Area Bank (2):** `coastal-local-area-bank-ltd` ·
`subhadra-local-area-bank-ltd`

**Foreign Bank (44):** All foreign banks with operations in India (ANZ,
Bank of America, Barclays, BNP Paribas, Citibank, DBS, Deutsche, HSBC,
JPMorgan Chase, Mizuho, MUFG, SBM Bank, Standard Chartered, etc.).

**IFSC Banking Unit / GIFT (37):** All major Indian PSBs / PVBs / FBs
operating in GIFT City. Each is denominated in foreign currency, no
domestic FD, no DICGC insurance.

**Regional Rural Bank (28):** All currently-operating RRBs (post-recent
state-level mergers). One per state-economy block.

**Scheduled Urban Co-operative Bank (52):** Top scheduled UCBs by RBI
list — Maharashtra dominates (Saraswat, Abhyudaya, Cosmos, SVC, TJSB,
Janata, Bharat, NKGSB, Bombay Mercantile, etc.); Gujarat (Kalupur,
Prime, Mehsana, Surat People's, etc.); Karnataka (Shamrao Vithal,
Sangli, Vasavi, etc.); plus AP/Telangana (AP Mahesh, Maratha) and
others.

**Scheduled State Co-operative Bank (24):** Apex state-level
co-operative banks (one per state with co-operative banking
infrastructure).

**Non-Scheduled State Co-operative Bank (10):** All 10 NSSCBs in the
master RBI list.

### Larger co-op categories (state distributions)

| State | NSUCB | DCCB |
|---|---:|---:|
| Maharashtra | 48 | ~31 |
| Gujarat | 20 | ~14 |
| Karnataka | 19 | 9 |
| Andhra Pradesh | 8 | ~24 |
| Kerala | 7 | 1 |
| Madhya Pradesh | 6 | ~8 |
| Telangana | 5 | (Karimnagar via AP) |
| Tamil Nadu | 5 | 9 |
| Rajasthan | 4 | 9 |
| West Bengal | 4 | 3 |
| Delhi | 3 | 0 |
| Uttarakhand | 2 | 1 |
| Punjab | – | 8 |
| Uttar Pradesh | – | 8 |
| Haryana | – | 5 |
| Odisha | – | 3 |
| J&K | – | 1+ |
| Himachal Pradesh | – | 1 |
| Bihar | – | 1 |
| Jharkhand | – | 1 |

## Quality gate behaviour during the run

The drift safeguard from Sprint 4 Track A (`f8a5953` + `cd9fa75`) is
active for any bank that has an entry in
`data/expected-slab-floors.json`. Currently seeded for **11 of the
baseline-12 banks** (Equitas omitted — local baseline was all-zero).

For banks with floors, after each LLM attempt:
- If the new per-variant slab count is < 0.8 × max(prior, floor),
  drift fires → retry with full model.
- Max 3 attempts (5 min timeout each = 15 min total per bank under
  the bumped-in-`33823bb` setting).
- After 3 unsuccessful attempts, `<slug>.partial_silent.json` is
  written; the bank is excluded from `pack/build-pack.js`'s output
  and (in cloud mode) from `git-publish.js`.
- If a bank previously had a marker and now passes drift, the marker
  is removed (local file + blob).

Banks **without** floors (i.e., the 502 banks in this cohort that
aren't in the 11-bank seed) fall through to the simpler
"0-slab or low confidence ⇒ retry" gate. They can ship with low slab
counts unnoticed — see the "first-run caveat" discussed in the plan.

To extend floor coverage for future runs, add entries to
`data/expected-slab-floors.json` post-delivery using the new pack's
measured slab counts as the baseline:

```json
{
  "_seeded_at": "2026-MM-DD",
  "banks": {
    "<bank-slug>": { "regular": N, "nre": M, ... },
    ...
  }
}
```

Then commit + rebuild image (or just re-run locally — local reads
from the image-baked file path which is the working directory copy).

## Common failure modes & responses

| Symptom | Likely cause | Response |
|---|---|---|
| Bank logs `RATE LIMITED` and the batch starts inserting 60s delays | AOAI 429 from quota | Let the agent's backoff handle it; or pause and resume later (`--resume`) |
| 3 consecutive rate-limits → batch aborts | AOAI quota exhausted | Wait for the resetTime printed in the abort message; rerun with `--resume` |
| `attempt 1 quality check failed: agent failed: Agent error: 408` | AOAI API timeout (network / token-too-long) | The retry already happens; if all 3 retries timeout, the bank gets `discovery_failed`. Investigate the trace.jsonl for that bank. |
| `Playwright failed (exit 1)` | Browser session issue on a JS-rendered site | Usually transient; the agent retries via Path B; if persistent, the bank ends up with low/no slabs and goes to the augment list. |
| `partial_silent` for a bank whose floor seems too aggressive | Operator-set floor doesn't match reality (e.g., bank legitimately published fewer slabs) | Lower the floor in `data/expected-slab-floors.json`, clear the marker (`rm output/latest/<slug>.partial_silent.json`), rerun the pack build. |
| `--banks <file>` flag does nothing | CSV mode requires positional CSV path | Use the full form: `node run-batch.js data/Indian_Banks_Comprehensive_List_RBI.csv --banks <file>` |

## Hand-off when done

1. Commit the new `pack/dist/rates-pack.json` + any updated `data/bank-domains.json`.
2. Write `sdlc/sprints/sprint-004/implementation/pm-refresh-2026-q2-memo.md` (PM-facing).
3. Share the pack JSON + memo with PM (Slack / email / wherever).
4. Note any open items (banks excluded with partial_silent, banks
   needing follow-up extraction work, etc.) in the memo so PM can
   account for them.
5. Optionally seed floors for the newly-covered banks (post-delivery
   improvement; not blocking).
