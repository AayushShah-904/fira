# Rate Discovery Agent — Onboarding Overview

**Read this first.** It gives you the whole system in one sitting: what the project is, how the pieces fit, where the data lives, and where to go next. The detailed docs are linked throughout — this page is the map, not the territory.

> **Audience:** an engineer taking over the project. By the end of this page you should know what runs, where, why, and be able to find any component in under a minute.

---

## 1. What this project is

The **Rate Discovery Agent** is an autonomous data-collection system that finds Indian banks' official websites, locates their deposit interest-rate pages, and extracts the rates into a standardised, machine-readable format. The end product is a **rates pack** — a single denormalised JSON bundle of deposit rates across ~1,900 Indian banks — consumed today by a Product Manager's standalone web UI and, eventually, by the parent **Fixed Income Yield Advisor (FIRA)** platform (formerly "FIRA").

It handles four deposit **product variants**:

| Variant | Meaning | Currency |
|---|---|---|
| **(regular)** | Domestic FD (resident term deposits) | INR |
| **NRE** | Non-Resident External account FD | INR |
| **NRO** | Non-Resident Ordinary account FD | INR |
| **FCNR** | Foreign Currency Non-Resident deposit | USD/GBP/EUR/… |
| **GIFT** | GIFT-City IBU (IFSC Banking Unit) offshore deposit | USD/… |

A "slab" is the atomic unit: **one bank · one variant · one currency · one tenure band = one rate slab.** Everything downstream counts slabs.

> **Mental-model correction (important):** despite the name "agent" and the `CLAUDE.md` framing, the automated pipeline is **not** a freeform LLM tool-loop. Sprint 010 retired that path. What runs today is **deterministic Node orchestration** (`lib/orchestrator.js` + `lib/actions/`) that calls **Azure OpenAI only inside specific actions** (web search, and HTML/PDF/vision extraction fallback). `CLAUDE.md` + `docs/agent/*.md` remain the behavioural contract and still drive the *interactive* Claude Code mode; see [agent-design.md](agent-design.md).

**Non-negotiable rule that defines the whole project: no fabrication.** Every slab must trace to a real source (the bank's own website or rate-card PDF — never an aggregator like bankbazaar). If rates can't be read, the output is an empty slab list with a `warnings` explanation. This honesty constraint shapes the confidence scoring, the quality gate, and the safe-write rules described below.

---

## 2. The pipeline in one picture

```
                 ┌─────────────── per-bank discovery/extraction ───────────────┐
  bank name  ──► │  find website → find rate page → classify → fetch → extract │ ──► per-bank JSON
  + category     │   (LLM + deterministic tools: Playwright, PDF, vision/OCR)  │     (config + rates)
                 └────────────────────────────────────────────────────────────┘
                                          │
             writes output/latest/<bank_code>_{config,rates,nre,nro,fcnr,gift}.json
                                          │
                                          ▼
                    ┌──────────── pack build ────────────┐
                    │  merge all per-bank files into one │ ──► pack/dist/rates-pack.json
                    │  denormalised rates-pack.json      │
                    └────────────────────────────────────┘
                                          │
                              quality gate (block big regressions)
                                          │
                                          ▼
                            publish → PM zip / blob container
```

Three ways this runs:

- **Interactive** — `claude` in the repo, then `> Discover rates for: HDFC Bank`. Claude Code reads `CLAUDE.md`. Good for one-off debugging and teaching the agent.
- **Local headless** — `node run-discovery.js "<bank>"` (one bank) or `node run-batch.js` / `node run-pipeline.js` (many). **Local runs are for debugging and development only.**
- **Cloud** — an Azure Container Apps Job runs `run-batch.js` against a **cohort**, syncs state to/from blob + git. **The cloud run is the source of truth for the rates pack.** (See the strategy note in §6.)

Three per-bank **modes** (flags on `run-discovery.js`):
- **discover** (default) — full: find website → rate pages → extract.
- **`--expand-nri`** — existing config; find and extract NRE/NRO/FCNR/GIFT pages.
- **`--rates-only`** — existing config with known URLs; just re-fetch and re-extract rates. Fast, cheap, but blind to URL changes (a bank moving its PDF silently yields zero).

---

## 3. Component map — where everything lives

```
fira-project/
├── CLAUDE.md                  # Lean router → the agent "brain" lives in docs/agent/
├── run-discovery.js           # Single-bank runner (the pipeline entry per bank)
├── run-batch.js               # Batch/cohort runner; does blob sync when FIRA_STORAGE=azure
├── run-pipeline.js            # Older orchestrated CSV runner (status-classifies, routes cheapest action)
│
├── docs/
│   ├── about/                 # ← YOU ARE HERE: onboarding guidebook
│   └── agent/                 # The agent's playbook (prompt fragments, SINGLE SOURCE OF TRUTH)
│
├── lib/                       # The engine
│   ├── prompts/               # fragments.js + build-prompt.js assemble prompts from docs/agent/*.md
│   ├── orchestrator.js        # Per-bank orchestration (variants expected, action selection)
│   ├── tier-router.js         # Model/tier selection + quality checks (two-tier cost model)
│   ├── actions/               # Deterministic tool implementations (fetch, classify, extract, commit)
│   ├── extractors/            # Bank-family-specific extractors (coop 3-col, PSB PDF, FB/PVB multi-variant, IBU PDF)
│   ├── quality-gate/          # Signed-accept verification
│   ├── safe-write.js          # Non-destructive write discipline (ADR-012)
│   ├── domain-cache.js        # Reads/writes data/bank-domains.json (the registry)
│   ├── confidence/, checks/   # Confidence scoring + rate QC
│   └── azure*, storage.js     # Azure OpenAI client + blob storage abstraction
│
├── data/
│   ├── bank-domains.json       # THE REGISTRY: slug → {domain, rate_pages, status, telemetry}
│   ├── cohorts/                # Named bank lists for batch/cloud runs (e.g. gold-11-nri-banks.json)
│   └── Indian_Banks_..._RBI.csv# Master list of ~1,900 banks
│
├── pack/                      # Pack build + publish + quality gate + baselines + shipped zips
│   ├── build-pack.js          # Merges per-bank files → rates-pack.json
│   ├── quality-gate.js        # Blocks big regressions vs baseline
│   ├── publish.js             # Ships the pack (blocked without a passing gate)
│   └── baseline/              # Fixed baseline pack the gate compares against
│
├── cloud/                     # sync.js (blob pull/push) + git-publish.js (durable git record)
├── iac/                       # Bicep (main.bicep) + deploy-image.sh — Azure infra as code
├── functions/                 # Azure Functions: HTTP trigger to start a cloud run + job-status
├── container-mgmt/            # Container Apps Job management helpers
├── scripts/                   # Big toolbox — azops/, pack/, analysis/, utils/, registry/, recovery/…
├── output/latest/             # REAL scraped data (per-bank JSON) — the working state. NEVER let tests touch it.
├── tests/                     # node --test suites (unit/integration/regression, fixtures, golden HTML)
└── sdlc/                      # Durable design record: architecture, deployment, data-model, ADRs, per-sprint docs
```

---

## 4. The two stores, and "cloud as source of truth"

State lives in **two places**, written on every cloud run:

1. **Blob** (`agent-state` container in Azure Storage) — the **live working state** and per-run audit trail. `output/latest/*` and `data/bank-domains.json` are pulled at run start and pushed at run end.
2. **Git** (`azure-openai-agent` branch) — the **durable, diffable, human-reviewable** record. `cloud/git-publish.js` commits the canonical rate JSON + registry after a successful run. Currently gated by a **kill switch** (`FIRA_DISABLE_GIT_PUBLISH=1`); flip to `0` to make git a live cloud channel.

**Strategy directive (operator, standing):** *The rates pack is always generated from data collected by **cloud** runs* (blob or the cloud git-publish channel). Local runs never feed the pack — they're for debugging only. The pack can be **assembled** anywhere (assembly is location-independent); what matters is that the **data** was cloud-collected. Two operator-approved carve-outs exist: (a) a one-time full-state blob seed grandfathered in locally-collected historical data as a migration baseline; (b) locally-collected data is allowed as a **labelled** fallback for banks the cloud can't reach (a `collected_via: cloud|local` provenance flag is a planned follow-up, backlog #17).

> **Gotcha that bites everyone:** `cloud/sync.js pull` downloads `bank-domains.json` from blob and **overwrites** the image's git copy. So a registry fix baked into the image does **not** take effect unless it's also pushed to blob first. Registry edits go to blob (`scripts/azops/push-bank-domains-merge.js`).

---

## 5. Concepts you must internalise before touching code

- **`bank_code` / slug.** Every output file and every `bank_code` JSON field uses the injected `$BANK_CODE` **verbatim** — never re-derived from the name. The canonical slug utility is `scripts/utils/slugify.js`; hand-composing slugs is the historical root cause of bank-count drift. IBUs get their own slug (e.g. `axis-bank-ibu`).
- **Safe-write discipline (ADR-012).** Writers never blindly clobber good data. `lib/safe-write.js` enforces four rules: (1) never overwrite curated files, (2) never overwrite non-empty with empty, (3) reject garbage, (4) if a fresh extraction is <50% of an established ≥8-slab non-stale ladder, divert to a `.pending.json` instead of overwriting. This is why you'll see `*.pending.json` files.
- **Quality gate.** `pack/quality-gate.js` blocks publish if the pack loses >10% of slabs globally, or if any high-confidence baseline bank loses >50% of its slabs. Overrides are explicit and recorded: an operator `--accept-regression "<reason>"` writes to `QUALITY-GATE.json`, and the **only** valid path to a *signed* accept is the CLI `bin/approve-accept.js` (agent-immune by design). **Never fabricate accept entries** — a 2026-05-23 incident where 48 fabricated accepts flipped a BLOCK to PASS is why this is a hard rule.
- **Confidence & tiered publication (ADR-016).** Rates carry an `extraction_confidence`; low-confidence data is flagged, not silently shipped. Honesty over coverage.
- **Two-tier model routing.** `lib/tier-router.js` picks a cheaper model first and escalates only when quality checks fail — a cost-control mechanism. **All LLM calls go through Azure OpenAI** (not the Anthropic API) for extraction and the judge.
- **Cohorts.** A cohort (`data/cohorts/*.json`) is a named list of banks (parents + IBUs) a run targets. The current focus is **`gold-11-nri-banks`** — 11 PM-chosen "gold standard" banks + their 7 GIFT-City IBUs (18 entities).

---

## 6. Where to go next — the doc map

### This guidebook (`docs/about/`)
| Doc | Read when you need to understand… |
|---|---|
| **[architecture.md](architecture.md)** | How the runtime fits together: local vs cloud, the engine's control flow, the data stores |
| **[agent-design.md](agent-design.md)** | The LLM agent: prompt fragments, orchestrator, tier-router, the three modes, cost model |
| **[crawling.md](crawling.md)** | Discovery: finding websites & rate pages, fetching, Playwright/anti-bot, page classification |
| **[extraction.md](extraction.md)** | Turning HTML/PDF into rate slabs: extractors, the rate schema, validation, tenure/currency parsing |
| **[quality-checks.md](quality-checks.md)** | Safe-write rules, the quality gate, confidence scoring, signed accepts, rate bounds |
| **[deployment.md](deployment.md)** | Azure topology, the container image, the Container Apps Job, Functions trigger, IaC/Bicep |
| **[testing.md](testing.md)** | Test layers, how to run them, fixtures & golden HTML, write-discipline checks |
| **[scripts.md](scripts.md)** | The `scripts/` toolbox — what each family (azops, pack, analysis, registry, recovery) does |
| **[operator-guide.md](operator-guide.md)** | **Day-to-day runbook**: run a cohort local & cloud, deploy the image, build/gate/publish a pack, reconcile blob/git, kill switch, troubleshooting |

### Deeper, authoritative sources (already in the repo — this guide points to them, doesn't replace them)
- **`docs/agent/`** — the agent's playbook and the **single source of truth** for its behaviour. `core.md` (identity + rules), `discovery-workflow.md`, `field-learnings.md` (tricky co-op sites), `nri-gift-ibu.md`, `schemas.md` (strict field names). The prompt builder reads these directly, so editing them changes the agent.
- **`sdlc/`** — the durable design record. `architecture.md`, `deployment.md`, `data-model.md`, `test-strategy.md`, `decisions/ADR-001…017` (every significant decision, with rationale), and per-sprint `sprints/sprint-NNN/` folders (plan / design / implementation / test / retro).
- **`sdlc/backlog.md`** — cross-sprint strategic items (notably: extracting this into its own repo + generalising to a domain-agnostic data-discovery agent).

---

## 7. Current state (as of handover, 2026-07-09)

- **Active sprint:** Sprint 011. Latest deliverable: the **gold-11 NRI rates pack** (18 entities, 1,188 slabs, quality gate PASS with one documented IDFC-GIFT exception) plus a PM quality report — shipped in `output/pm-2026-07-09/`.
- **Cloud infra is live:** Container Apps Job `caj-fira-rate-discovery-prod` in `rg-fira-rate-agent-prod-southindia`, storage `stfirarateagentprod01`, registry `crfirarateagentprod`. (Note: resources use the `fira` prefix after the FIRA→FIRA rename; do **not** bulk-rewrite existing "FIRA" references — see the rename note.)
- **Open backlog** lives in `sdlc/sprints/sprint-011/BACKLOG.md` and the task list. Highest-leverage open items: `#16` republish-only cloud mode (stop the push-back race that re-uploads all ~4,300 blobs and clobbers concurrent restores), `#27` fleet-wide `www`-subdomain URL audit, and a cluster of gold-bank parse-quality fixes (`#23–#32`).
- **One decision pending the operator:** whether to publish the gold-11 pack to the **live `rates-pack` container** (still serving the June-5 pack). Recommendation on record: restore curated versions of ~5 thinner banks first.

---

## 8. Environment gotchas (Windows dev box)

The primary dev machine is **Windows 11 / PowerShell**, which introduces a few recurring traps documented across the sprint notes:

- **Path mangling:** Git-Bash-style `/c/Users/...` paths get misread by Node as `C:\c\Users\...`. Use Windows-form `C:/Users/...` in Node scripts.
- **PowerShell BOM / UTF-16:** reading JSON through PowerShell pipes can inject a BOM. Strip with `.replace(/^﻿/, '')` or read via Node, not PS pipes.
- **`az.bat` with spaces** in its path breaks `spawnSync`. Don't override `AZ_BIN`; rely on `az.bat` on PATH.
- **Norton Safe Web / Jio IPv6** can MITM TLS or reset connections to Azure — the cause behind several `--strict-ssl=false` workarounds and `curl -4` habits. Disable Safe Web for normal TLS work.

---

*Written for handover, 2026-07-09. The area docs beside this one go a level deeper; the `sdlc/` and `docs/agent/` folders are the authoritative sources this guide indexes.*
