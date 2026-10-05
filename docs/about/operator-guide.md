# Operator Guide — Day-to-Day Runbook

> Part of the [onboarding guidebook](overview.md). Read [overview.md](overview.md) first for the mental model (the pipeline, the two stores, "cloud as source of truth"). Read [deployment.md](deployment.md) for the Azure topology this guide operates against, and [quality-checks.md](quality-checks.md) for what the gate/accept commands below actually mean. This page is commands, not concepts.

**Audience:** an operator running this system day to day — one-bank debugging, cohort runs (local and cloud), pack build/gate/publish, image deploys, and repair operations when something clobbers something else.

**Safety callout — read this before running anything against prod:**

> - The **only** valid path to a quality-gate accept is `bin/approve-accept.js` (signed, operator key, interactive TTY, agent-immune by design). **Never** hand-edit `pack/quality-gate-accepts.json`. A 2026-05-23 incident (48 fabricated accepts) is the reason this is a hard rule.
> - **Never run a restore (`restore-banks-to-blob.js`, `seed-latest-from-local.js`) while a cloud cohort run is finalizing.** The finalize path's `push()` re-uploads all ~4,300 blobs and will clobber your concurrent restore (backlog `#16`, the "push-back race").
> - `cloud/sync.js pull` overwrites the image's baked-in `data/bank-domains.json` with whatever is in blob. Registry edits (new domain, corrected URL) must go to **blob** via `scripts/azops/push-bank-domains-merge.js` — editing the local file and redeploying the image is not enough.
> - If a deploy or publish step is blocked by a permission/authorization classifier, that is a stop sign for the **operator**, not an obstacle to route around.
> - The rates pack is **always** built from cloud-collected data. Local runs are debug-only and never feed the shipped pack (two narrow, operator-approved exceptions exist — see [overview.md §4](overview.md#4-the-two-stores-and-cloud-as-source-of-truth)).

---

## 1. Prerequisites & environment

```bash
npm install                 # installs Playwright + deps (postinstall may fetch Chromium)
cp .env.example .env        # then fill in real values (see below)
az login                    # Azure CLI auth — required for any cloud:* command, blob ops, ACR build
az account set --subscription <sub-id>   # make sure you're on the right subscription
```

`.env` (from `.env.example`) needs at minimum:

```bash
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2024-12-01-preview
AZURE_OPENAI_DEPLOYMENT_MINI=gpt-4.1-mini     # tier 1 (cheap/fast, ~70% of banks)
AZURE_OPENAI_DEPLOYMENT_FULL=gpt-4.1          # tier 2 (JS-rendered, WAF, NRI discovery)
```

`BING_SEARCH_API_KEY` can stay empty — the Azure OpenAI Responses API's built-in `web_search` works off just the endpoint.

**What NOT to commit:**
- `.env` (real API keys) — already gitignored, double-check before any `git add -A`.
- `~/.rate-discovery/operator.key` — lives outside the repo entirely, by design (§9 below).
- Anything under `output/latest/` you haven't deliberately curated — it's real scraped data (see §11 troubleshooting) and tests must never touch it.

**FIRA_STORAGE:** unset (or anything other than `azure`) = local mode, no blob/git sync, safe to experiment. `FIRA_STORAGE=azure` = cloud mode — `run-batch.js` will pull from blob at start and push at end. Only set this locally if you deliberately intend to touch blob (rare; see §8 repair operations).

---

## 2. Run rates for one bank, locally

`run-discovery.js` has three modes (flags), driven by `lib/orchestrator.js` under the hood — see [agent-design.md](agent-design.md) for internals.

```bash
# Full discovery: find website, find rate pages, extract — for a brand-new bank
node run-discovery.js "HDFC Bank Limited" --category "Private Sector Bank (Indian)"

# Positional form also works: <name> <category> <state>
node run-discovery.js "State Bank of India" "Public Sector Bank" "Maharashtra"

# NRI expansion: existing config, find + extract NRE/NRO/FCNR/GIFT pages
node run-discovery.js "axis-bank-limited" --expand-nri

# Re-extract only: known URLs, just re-fetch + re-extract (fast, cheap, but blind to URL moves)
node run-discovery.js "axis-bank-limited" --rates-only

# Targeted single-variant refresh (Sprint 011 item 18) — only touches one product
node run-discovery.js "axis-bank-limited" --rates-only --variant fcnr
# --variant accepts: regular | nre | nro | fcnr | gift
```

Useful flags: `--log-level debug` (error|warn default|info|debug|trace), `--output-dir <dir>` (used internally by `run-batch.js` to group cohort output), `--state <state>`. `--path` is accepted for back-compat but only `orchestrator` is valid now — `--path llm` errors out (the legacy LLM-chat path was retired Sprint 010).

Output lands in `output/runs/<timestamp>_<bank_code>/` and is copied into `output/latest/<bank_code>_{config,rates,nre,nro,fcnr,gift}.json` via the safe-write funnel (never a blind overwrite — see [quality-checks.md §2](quality-checks.md#2-safe-write-discipline-libsafe-writejs-adr-012)).

If a bank isn't in `data/bank-domains.json` and you didn't pass `--category`, the run derives `bank_type` from the registry or from an existing local config — but for a truly new bank you should pass `--category` explicitly so NRI variants get expected correctly.

---

## 3. Run a cohort locally (debug only)

**Local cohort runs never feed the shipped pack.** Use them to validate a fix, smoke-test a small batch, or reproduce a cloud failure before you push a fix to the cloud path.

```bash
# CSV mode — filter the bundled RBI bank list by category
node run-batch.js data/Indian_Banks_Comprehensive_List_RBI.csv --category "Public Sector Bank" --limit 5

# Cohort mode — a named, version-controlled bank list under data/cohorts/
node run-batch.js --cohort gold-11-nri-banks --dry-run     # resolve + print, no LLM calls
node run-batch.js --cohort gold-11-nri-banks

# Slug-list mode — explicit bank_codes, bypasses skip-status filtering
node run-batch.js axis-bank-limited hdfc-bank-limited --category "Private Sector Bank (Indian)"

# Resume a partial run: skip succeeded, retry rate-limited automatically
node run-batch.js --cohort gold-11-nri-banks --resume

# Resume AND retry banks that failed outright last time
node run-batch.js --cohort gold-11-nri-banks --resume --retry-failed

# Parallel execution (max 5)
node run-batch.js --cohort gold-11-nri-banks --concurrency 3

# NRI expansion / rates-only across a whole cohort
node run-batch.js --cohort gold-11-nri-banks --expand-nri
node run-batch.js --cohort gold-11-nri-banks --rates-only
```

Other flags worth knowing: `--limit <n>` (CSV/category mode only), `--delay <sec>` (default 2s between banks), `--timeout <sec>` (default 900 = 15 min per bank, sized for the orchestrator's internal retry budget), `--banks <file|comma-slugs>` (CSV mode filter), `--include-skipped` (bypass the registry's skip-status filter), `--extract-only` (deterministic extraction, no LLM). List available cohorts by running any cohort-mode command with a bad name — the error message prints `Available cohorts: ...`.

Available cohorts live in `data/cohorts/*.json`; the current operational focus is `gold-11-nri-banks` (11 PM-chosen banks + their 7 GIFT IBUs, 18 entities).

---

## 4. Run a cohort in the cloud (source of truth)

Three ways to kick off a cloud execution, in increasing order of "close to the metal":

### 4a. `start-cohort-run.js` — cohort already committed + image current

```bash
node scripts/azops/start-cohort-run.js --cohort gold-11-nri-banks --env prod
node scripts/azops/start-cohort-run.js --cohort gold-11-nri-banks --env prod --rates-only
node scripts/azops/start-cohort-run.js --cohort gold-11-nri-banks --env prod --expand-nri
```

Reads the deployed job's current container spec, overlays `args: ["--cohort=<name>", ...]`, and POSTs an ARM `start`. Prints the execution name and a watch command.

### 4b. `start-cohort.js` — richer UX (live progress, confirmation prompt, dry-run)

```bash
node scripts/azops/start-cohort.js --cohort gold-11-nri-banks --env prod          # attaches, polls, prints live per-bank progress
node scripts/azops/start-cohort.js --cohort gold-11-nri-banks --env prod --detach # kick off and exit; re-attach later
node scripts/azops/start-cohort.js --cohort gold-11-nri-banks --env prod --dry-run --yes  # print the az command, don't run it
```

### 4c. The Function HTTP trigger (what a UI or scheduler would call)

```bash
FN_KEY=$(az functionapp keys list --name func-fira-trigger-prod --resource-group rg-fira-rate-agent-prod-southindia --query masterKey -o tsv)
curl -X POST -H "x-functions-key: $FN_KEY" -H "Content-Type: application/json" \
  "https://func-fira-trigger-prod.azurewebsites.net/api/start-discovery" \
  -d '{"banks": ["hdfc-bank-limited", "axis-bank-limited"]}'

# or by category (bank-type code)
curl -X POST -H "x-functions-key: $FN_KEY" -H "Content-Type: application/json" \
  "https://func-fira-trigger-prod.azurewebsites.net/api/start-discovery" \
  -d '{"category": "PSB", "dryRun": true}'
```

Request body: exactly one of `banks` (array of slugs, max 150), `category` (one of `PSB|PVB|SFB|PB|FB|RRB|SUCB|NSUCB|SSCB|NSSCB|DCCB|LAB|FI|IBU|HFC`), or `cadence` (reserved, currently `400 not_implemented`). `dryRun: true` short-circuits for `banks` requests (echoes the resolved list, no Job started).

### Checking status

```bash
npm run cloud:status                          # last 5 executions, ARM status + business outcome
node scripts/azops/cloud-status.js --limit 10
node scripts/azops/status.js <exec-name> --env prod           # attach/poll a specific execution
node scripts/azops/status.js <exec-name> --env prod --once     # one snapshot, no polling
```

`cloud:status` joins ARM's lifecycle status against the execution receipt (`output/latest/_execution_<name>.json`, written by `run-batch.js`) — ARM "Succeeded" only means exit 0, which can hide a no-op run; the receipt's `outcome` field (`success` / `partial_failure` / `failure` / `no_work` / `aborted_no_progress`) is the real signal.

**How to know it's done:** `status.js`/`start-cohort.js` attach mode polls until the execution reaches `Succeeded`/`Failed`/`Cancelled`. A cohort-level watchdog (`FIRA_COHORT_NO_PROGRESS_TIMEOUT_MS`, default 25 min) aborts the run cleanly if no bank finishes in that window, rather than waiting out the full `replicaTimeoutSec` (up to 20h).

**Colleague-collision caveat:** the Container Apps Job accepts overlapping executions. If a colleague starts a cohort run while yours is finalizing, both runs' `push()` steps upload the *entire* accumulated `output/latest/` — last writer wins, per-file, no locking. Check `npm run cloud:status` before kicking off a new run if you suspect one might already be in flight, and never overlap a manual restore (§8) with a cohort run's finalize window.

---

## 5. Inspect state / drift

```bash
# Is the deployed job's spec what you expect? (image tag, kill-switch, replica timeout)
npm run cloud:drift
node scripts/azops/drift-check.js --env prod --expected-image-tag <sha> --expected-killswitch 0

# KQL reconciliation across recent runs (requires Log Analytics access)
npm run cloud:reconcile
node scripts/azops/reconcile.js --env prod --lookback 120 --run-label <label>

# Pull blob's output/latest/* into a local staging dir (read-only, safe-write-bypassing —
# never points this at your real output/latest/)
node scripts/azops/pull-latest-from-blob.js --dest pack/dist-staging-cloud-2026-07-09/latest

# URL health probe — is a bank's stored rate-page URL still alive before trusting --rates-only?
node scripts/analysis/url-health-probe.js --cohort gold-11-nri-banks
```

`drift-check.js` exit codes: `0` no drift, `2` drift detected (field-level diff printed), `3` couldn't read the live job. Defaults: `--expected-image-tag` = your local git HEAD SHA, `--expected-killswitch 0`, `--expected-replica-timeout 18000`.

Use `pull-latest-from-blob.js` when you want to build/gate a pack **from cloud state** without going through a full cohort run — it refuses to write into any path literally ending in `output/latest` (guardrail against clobbering your real local state).

---

## 6. Build a pack: build → gate → publish

```bash
npm run build-pack          # node pack/build-pack.js  → pack/dist/rates-pack.json + schema + README
node pack/quality-gate.js    # the PRE-PUBLISH gate — this is the one publish.js enforces (see note below)
npm run publish-pack         # node pack/publish.js — uploads pack/dist/* to the rates-pack blob container
```

> **There are two gates — don't confuse them.**
> - **`pack/quality-gate.js`** (Sprint 010) is the **pre-publish slab-coverage gate**. It reads `pack/dist/rates-pack.json`, compares against the floor baseline in `pack/baseline/`, writes `pack/dist/QUALITY-GATE.json`, and is the gate **`pack/publish.js` and the cloud finalize actually enforce**. Its two block conditions and the `--accept-regression` override are described below. **This is the one you run before publishing.**
> - **`scripts/quality-gate.js`** (Sprint 004, wired to `npm run quality-gate`) is a **richer analysis report** — it classifies every change into REGRESSION / ANOMALY / WARN / GAIN / STABLE, takes explicit `<new-pack> <baseline-pack>` args, and honours **signed** accepts (`bin/approve-accept.js`). Use it for deeper diffing/triage; it does **not** gate publish.

**Read the gate output before publishing.** `[quality-gate] PASS` or `[quality-gate] BLOCK — reasons: <list>`; full machine verdict in `pack/dist/QUALITY-GATE.json`, human summary appended to `pack/dist/REPORT.md`. Two independent block conditions in `pack/quality-gate.js` (either fires a BLOCK): pack-wide slab count drops **>10%** vs. baseline, or any bank with **baseline** confidence `high` loses **>50%** of its slabs. See [quality-checks.md §3](quality-checks.md#3-the-quality-gate-packquality-gatejs) for the full model.

```bash
# Build against a staged (cloud-pulled) source dir instead of the real output/latest/
FIRA_LATEST_DIR=pack/dist-staging-cloud-2026-07-09/latest FIRA_DIST_DIR=pack/dist-staging-cloud-2026-07-09/dist node pack/build-pack.js
FIRA_DIST_DIR=pack/dist-staging-cloud-2026-07-09/dist node pack/quality-gate.js

# One-off operator override on a run-level block (unsigned, does NOT persist across runs)
node pack/quality-gate.js --accept-regression "axis re-extraction known, verified manually"
```

`--accept-regression` is a blunt, run-scoped override — it's different from (and weaker than) a **signed accept**, which persists as a standing decision. If a finding needs to be accepted permanently (so future gate runs don't re-flag it), that's the operator-only, TTY-gated path:

```bash
node bin/approve-accept.js --bank axis-bank-ibu --variant gift --finding-hash <hash> --reason "documented override, see sprint-011 notes"
node bin/approve-accept.js --list        # review current accepts, no key needed
node bin/approve-accept.js --verify      # check every entry's HMAC signature
```

This requires `~/.rate-discovery/operator.key` (32+ bytes hex — `openssl rand -hex 32 > ~/.rate-discovery/operator.key`) and refuses to run inside an agent session, inside CI, or without a TTY. **This is the only valid way to produce a signed accept — never hand-edit `pack/quality-gate-accepts.json`.**

`publish.js` hard-refuses to upload unless `QUALITY-GATE.json#pass` is true or `operator_override` is set — there is no way to publish a blocked pack silently.

### Building the PM deliverable

```bash
node scripts/pack/build-pm-deliverable.js --date 2026-07-09
node scripts/pack/build-pm-deliverable.js --date 2026-07-09 --pack pack/dist-staging-cloud-2026-07-09/dist/rates-pack.json --variants fcnr,gift
```

Produces `output/pm-<date>/<variant>-rates-<date>.csv` and `<variant>-banks-<date>.json` per NRI variant (default `nre,nro,fcnr,gift`), plus a stats block on stdout for the PM brief. `--pack` lets you point it at a pack built from cloud-pulled staging data rather than the default `pack/dist/rates-pack.json`.

---

## 7. Deploy a new image

```bash
./iac/deploy-image.sh
```

One command, four atomic steps: (1) build + upload `functions.zip`, (2) `az acr build` the container image into `crfirarateagentprod` tagged `:<git-sha>` and `:latest` (retries 3x with backoff, verifies the tag landed), (3) re-apply Bicep with **both** `imageTag` and `runFromPackageUrl` set together — plus a **preserved** `disableGitPublish` value read back from the currently-deployed job, so a routine deploy can never silently flip the kill switch — (4) sync function triggers and poll `/admin/functions` until both functions report loaded.

Useful overrides (env vars, all optional): `ACR_NAME`, `IMAGE_NAME`, `LOCATION`, `TEMPLATE`, `PARAMETERS`, `ENV_NAME`, `AZ_BIN` (don't override unless you know what you're doing — `az.bat` on PATH is already handled), `DISABLE_GIT_PUBLISH` (explicit kill-switch override for this deploy), `SKIP_FUNCTION_VERIFY=1` (skip the post-deploy poll), `ACR_BUILD_MAX_ATTEMPTS`.

**Requires:** `az login`, subscription set, `bicep` CLI, Python 3 on PATH (for `build-functions-zip.py` — must use Python's `zipfile`, not PowerShell's `Compress-Archive`, which emits path separators the Linux Functions host can't parse).

**Authorization gate:** the `az acr build` / `az deployment sub create` calls can hit a permission classifier that blocks until an operator explicitly authorizes. Treat that block as a stop sign — hand it to the operator, don't route around it.

At the end the script prints a ready-to-paste smoke-trigger `curl` command (one bank, `hdfc-bank-limited`) — use it to confirm the freshly-deployed image actually runs before trusting it with a full cohort.

For a scripted deploy+smoke in one shot:

```bash
node scripts/azops/deploy-smoke.js --cohort smoke-1 --env prod
node scripts/azops/deploy-smoke.js --cohort smoke-1 --env prod --skip-deploy   # smoke the currently-deployed image only
node scripts/azops/deploy-smoke.js --dry-run --yes
```

Exit codes worth knowing: `0` success + receipt landed, `1` business failure, `2` terminal execution but **no receipt blob** (the specific operational-trust failure this tool exists to catch loudly), `3` pre-flight failure, `4` deploy failed, `5` functions didn't load, `6` job-status endpoint unreachable, `7` operator declined the prod confirmation prompt.

---

## 8. Repair operations

### Restore a clobbered bank from local to blob

```bash
node scripts/azops/restore-banks-to-blob.js --banks axis-bank-ibu,canara-bank-ibu     # dry-run — prints plan only
node scripts/azops/restore-banks-to-blob.js --banks axis-bank-ibu,canara-bank-ibu --apply
```

Uploads local `output/latest/<code>_*` files over blob **unconditionally** for the named banks — the point is you've already decided local wins. Refuses to run without an explicit `--banks` list; skips any local file with 0 `rate_slabs` (never restores emptiness).

**Timing hazard:** do not run this while a cohort run is finalizing (its `push()` will re-upload everything and clobber your restore). Check `npm run cloud:status` first.

### Reconcile the domain registry to blob

```bash
node scripts/azops/push-bank-domains-merge.js --dry-run
node scripts/azops/push-bank-domains-merge.js
```

Merges local `data/bank-domains.json` into the cloud copy: local wins per-bank except run-authored fields (`cloud_block_status`, `cloud_capability`) where the newer `observed_at`/`updated_at` wins; cloud-only entries (sparse IBU stubs) are preserved, not dropped. This is **the only correct way to ship a registry fix to the cloud** — redeploying the image alone does not work, because `cloud/sync.js pull` overwrites the image's copy with blob's at the start of every run.

### Seed blob from local (NRI variant reconcile)

```bash
node scripts/azops/seed-latest-from-local.js                 # dry-run, scope=nri (default)
node scripts/azops/seed-latest-from-local.js --apply
node scripts/azops/seed-latest-from-local.js --apply --scope all --staging pack/dist-staging-cloud-2026-07-09/latest
```

One-way, `scraped_at`-guarded reconcile of local artifacts into blob — mirrors the safe-write shrink-guard logic symmetrically (never uploads an empty file over a populated blob copy, parks ambiguous shrinks in a REVIEW bucket printed in the plan but **not** auto-uploaded). `--scope all` requires `--staging <dir>` (a `pull-latest-from-blob.js` snapshot) because the per-blob `az` CLI path is too slow at full-fleet size.

---

## 9. The kill switch & the git channel

```bash
# Check current value on the deployed job
az containerapp job show --name caj-fira-rate-discovery-prod --resource-group rg-fira-rate-agent-prod-southindia \
  --query "properties.template.containers[0].env[?name=='FIRA_DISABLE_GIT_PUBLISH']"

# Flip it (ad hoc, no Bicep re-apply needed)
az containerapp job update --name caj-fira-rate-discovery-prod --resource-group rg-fira-rate-agent-prod-southindia \
  --set-env-vars FIRA_DISABLE_GIT_PUBLISH=0
```

Currently **`1`** (git-publish disabled — `cloud/git-publish.js` is a no-op). The git target is fully wired (branch `azure-openai-agent`, repo `samir-joshi/fixed-income-yield-advisor`, `github-pat` Key Vault secret) — flipping to `0` makes every successful cloud run also commit `output/latest/*.json`, `data/bank-domains.json`, and the rebuilt pack to that branch. `iac/deploy-image.sh` always **preserves** whatever value is currently deployed on every re-apply (reads it back before applying Bicep), specifically so a routine image deploy can't silently revert an operator's kill-switch choice — see `DISABLE_GIT_PUBLISH` in §7 if you need to override that preservation for one specific deploy.

---

## 10. Troubleshooting table

| Symptom | Likely cause | Fix |
|---|---|---|
| Bank extracts 0 slabs, `extraction_confidence: none` | Rate-page URL moved/404'd, or `--rates-only` trusted a stale cached URL | Run `node scripts/analysis/url-health-probe.js --cohort <name>` to confirm; if DEAD, re-run full discovery (no `--rates-only`) so the agent re-finds the page |
| `run-batch.js` reclassifies an exit-0 bank as `failed` (`zero_slab_extraction`) | Every produced rate file is empty and bare-file confidence is `none` — this is intentional (Sprint 009 Phase 2.5), not a bug | Investigate the extraction, don't treat the green ARM status as success |
| `quality-gate` BLOCKs a pack build | Real regression, or baseline mismatch | Read `pack/dist/QUALITY-GATE.json#block_reasons`; if genuine, fix extraction and rebuild — don't reach for `--accept-regression` by default |
| `publish.js` refuses to upload | No passing `QUALITY-GATE.json`, or gate never ran | Run `node pack/quality-gate.js` first (the pre-publish gate, not `npm run quality-gate`); check `pass` / `operator_override` |
| Registry fix doesn't take effect on next cloud run | `cloud/sync.js pull` overwrote the image's `bank-domains.json` with the stale blob copy | `node scripts/azops/push-bank-domains-merge.js` — never rely on the image alone |
| Restore silently disappears after a cohort run | Push-back race (backlog `#16`) — a concurrent cohort finalize re-uploaded all blobs after your restore | Check `npm run cloud:status` before restoring; never overlap with a finalizing run |
| Node script reads a mangled path like `C:\c\Users\...` | Git-Bash-style `/c/Users/...` path passed into a Node script | Use Windows-form `C:/Users/...` paths in Node scripts, not `/c/...` |
| JSON read via PowerShell pipe has a stray leading character | PowerShell pipes inject a UTF-16/BOM artifact | Read JSON via Node (`fs.readFileSync` + `JSON.parse`), not `Get-Content \| ConvertFrom-Json` |
| `az` calls fail with "bad interpreter" or spawn errors on Windows | `az` resolves to a Python shebang script that spawnSync can't launch directly | Use `az.bat` (already the default in azops scripts / `deploy-image.sh`); don't override `AZ_BIN` unless you know it's broken |
| TLS handshake errors / connection resets to `*.azure.com` only | Norton Safe Web MITM, or Jio Wi-Fi IPv6 reset | Disable Norton Safe Web for normal TLS work; for reads, `curl -4` to force IPv4 — az CLI writes usually complete server-side despite a client-side drop |
| `deploy-image.sh` hangs or errors at the `az acr build` / Bicep step | Permission/authorization classifier blocking the call | Hand off to the operator — do not attempt to bypass with elevated credentials |
| A `.pending.json` file appears next to a bank's rates file | Safe-write diverted an incoming write (curated-file protection, non-empty→empty, garbage, or shrink guard) — this is by design | Review the pending file manually; it is a review queue item, not an error to delete |

---

## 11. Safety rules recap

> - **Only** `bin/approve-accept.js` produces a valid signed quality-gate accept. Never hand-edit `pack/quality-gate-accepts.json`.
> - **Never** run a blob restore/seed operation while a cloud cohort run is finalizing — the push-back race will clobber it.
> - **Registry edits go to blob** (`push-bank-domains-merge.js`), never to the image alone — `cloud/sync.js pull` will overwrite the image's copy on every run.
> - **Local runs never feed the shipped pack.** The pack is always built from cloud-collected data (blob or, once the kill switch flips, the git channel).
> - **A permission/authorization classifier block on deploy/publish is a stop sign for the operator** — never worked around.
> - `output/latest/` holds real scraped data — never let a test suite or a "clean slate" impulse touch it.
> - Use Windows-form paths (`C:/Users/...`) in Node scripts on this box; read JSON via Node, not PowerShell pipes; don't override `AZ_BIN`.

---

## 12. Pointers

| Doc | What's there |
|---|---|
| [overview.md](overview.md) | Whole-system map; start here if you haven't |
| [deployment.md](deployment.md) | Azure topology, image lifecycle, trigger architecture — the design this guide operates against |
| [quality-checks.md](quality-checks.md) | The full safe-write / quality-gate / signed-accept model this guide's commands invoke |
| [architecture.md](architecture.md) | Local-vs-cloud runtime picture, engine control flow |
| `scripts.md` *(sibling, if written)* | Full `scripts/` toolbox reference (azops, pack, analysis, registry, recovery) |
| `sdlc/backlog.md` | Cross-sprint strategic items, incl. `#16` republish-only cloud mode |

---

*Written for handover, 2026-07-09. Commands verified against `run-discovery.js`, `run-batch.js`, `package.json`, `scripts/azops/*.js`, `pack/build-pack.js`, `pack/quality-gate.js` (invoked via `npm run quality-gate` → `scripts/quality-gate.js`), `pack/publish.js`, `bin/approve-accept.js`, `iac/deploy-image.sh`, `functions/start-discovery/`, and `scripts/analysis/url-health-probe.js` as of this date.*
