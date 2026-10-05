# Architecture

> Part of the [onboarding guidebook](overview.md). Read [overview.md](overview.md) first if you haven't — this page assumes you already know what the project does and just want the runtime/system picture.

## 1. Framing

The Rate Discovery Agent is, at its core, **one Node.js process**: an LLM (Claude, called through **Azure OpenAI** — never the Anthropic API directly) paired with a fixed set of **deterministic tools** (Playwright for JS-rendered pages, PDF text extraction, HTTP fetch, vision/OCR for scanned pages). The LLM does judgment work (find the right page, decide what a table means); the deterministic tools do everything that can be pinned down in code (fetch, parse, validate, write). Per bank, this produces a handful of JSON files under `output/latest/`; across banks, those files get merged into one denormalised "rates pack" that downstream consumers read. See [overview.md §1–§2](overview.md) for the product framing and the one-picture pipeline diagram — this doc goes one level deeper into *how the process runs* and *what the code looks like inside*.

## 2. Runtime modes: local vs cloud, identical code

The single most important architectural fact: **local dev and the cloud container run the exact same code paths.** The only thing that differs is configuration — principally the `FIRA_STORAGE` env var, which selects a storage backend, plus where secrets come from. There is no "cloud branch" of the code and no parallel implementation to keep in sync (see [ADR-004](../../sdlc/decisions/ADR-004-storage-abstraction.md)).

### Local development

```
┌─────────────────────────────────────────────────────────────┐
│  developer laptop                                           │
│                                                               │
│   node run-discovery.js "<bank>"                             │
│        │                                                     │
│        ├── .env  ─────────────►  Azure OpenAI endpoint/key   │
│        ├── fs r/w  ───────────►  ./output/latest/            │
│        ├── fs read  ──────────►  ./data/bank-domains.json    │
│        └── spawns Playwright ─►  Chromium (npm-installed)    │
│                                                               │
│   node pack/build-pack.js                                    │
│        └── writes  ───────────►  ./pack/dist/  (no upload)   │
└─────────────────────────────────────────────────────────────┘
```

`FIRA_STORAGE` is unset (defaults to `local`). Everything reads/writes the repo's filesystem directly. No containers, no Azure dependency beyond the Azure OpenAI API call itself. This is the baseline every change must keep working — `npm test` runs entirely against it.

### Cloud (Azure Container Apps Job)

```
┌────────────────────────────────────────────────────────────────────┐
│  Azure                                                              │
│                                                                      │
│   HTTP Function (function-key auth)                                 │
│        │  translates an authenticated call into a job start         │
│        ▼                                                             │
│   Container Apps Job  (image from ACR, scale-to-zero, FIRA_STORAGE=azure)
│        │                                                             │
│        ├── env from Key Vault refs  ──────►  Azure OpenAI            │
│        ├── storage adapter r/w  ───────────►  Blob agent-state/      │
│        │        output/latest/*, data/bank-domains.json              │
│        ├── spawns Playwright  ─────────────►  Chromium (in image)    │
│        └── on success: pack + publish  ────►  Blob rates-pack/       │
│                                                                      │
│   PM's server (service principal + bearer token)  ──►  Blob rates-pack/
└────────────────────────────────────────────────────────────────────┘
```

Same `run-discovery.js` / `run-batch.js` entry points, same orchestrator, same extractors. The only mode-aware code is the storage adapter (`lib/storage.js`) and the publish step. See [deployment.md](deployment.md) for the full Azure topology (Container Apps Job, Bicep, Functions trigger) — that detail is out of scope here.

## 3. The three runners

Three top-level entry points, all under the repo root, all requiring `dotenv` config and all ultimately calling into the same orchestrator/actions engine:

| Runner | Scope | When to use |
|---|---|---|
| **`run-discovery.js`** | One bank | The atomic unit of work. Three modes via flags: default (`discover` — full find-website→rate-pages→extract), `--expand-nri` (existing config, find NRE/NRO/FCNR/GIFT pages), `--rates-only` (existing config with known URLs, just re-fetch/re-extract). Interactive Claude Code sessions and single-bank debugging use this directly. |
| **`run-batch.js`** | A cohort or list of banks | The **cloud entry point**. Accepts CSV mode, a slug list, or a `--category` filter, and (new) `--cohort <name>` to load `data/cohorts/*.json`. Internally shells out to `run-discovery.js` per bank (`spawnSync`/`spawn`). When `FIRA_STORAGE=azure`, it also drives the blob sync: `cloud/sync.js pull` at start, `cloud/sync.js push` (+ `cloud/git-publish.js`) at end. This is what the Container Apps Job runs. |
| **`run-pipeline.js`** | A master CSV, self-routing | The **older**, CSV-driven orchestrator. Classifies every bank's current status (`pending` / `stale` / `parse_fail` / `current` / `blocked` / …) and routes each to the *cheapest sufficient* action — deterministic re-extraction if a config with captured selectors exists, full LLM discovery only if not. Supports resume/checkpoint. Still used for large sweeps across the ~1,900-bank master list, but `run-batch.js` + cohorts is the newer, narrower-scope path for targeted cloud runs (e.g. the current `gold-11-nri-banks` cohort). |

All three ultimately delegate the actual per-bank work to the same machinery described next — none of them re-implements discovery logic.

## 4. Per-bank control flow (conceptual)

```
run-discovery.js (one bank)
      │
      ├─ lib/tier-router.js:selectDiscoveryAction()
      │     reads data/bank-domains.json → skip (operator-curated / terminal
      │     status) or proceed with a model tier (mini vs full — cost control)
      │
      ├─ lib/orchestrator.js
      │     deterministic Node sequence (NOT itself an LLM loop):
      │       1. find_website(bank_name, type, state)         → lib/actions/find_website.js
      │       2. commit_to_registry({domain, confidence})     → lib/actions/commit_to_registry.js
      │       3. for each applicable product (fd, fd_nre, fd_nro, fd_fcnr, fd_gift):
      │            a. find_rate_page                          → lib/actions/find_rate_page.js
      │            b. classify_rate_page (html_static/html_js/pdf/image) → classify_rate_page.js
      │            c. extract, by kind:
      │                 html → extract_html_table.js (+ lib/extractors/ family dispatch)
      │                 pdf  → extract_pdf_table.js
      │                 image→ extract_via_vision.js / extract_via_ocr.js
      │            d. commit_rates(bank_code, variant, slabs)  → lib/actions/commit_rates.js
      │       4. classify_outcome                              → lib/actions/classify_outcome.js
      │
      └─ writes per-bank JSON via lib/safe-write.js (ADR-012 non-destructive writes)
            output/latest/<bank_code>_{config,rates,nre,nro,fcnr,gift}.json
            output/latest/<bank_code>.summary.json / .log
```

Key architectural point: **the orchestrator itself makes no LLM calls** — it's a fixed Node sequence over `lib/actions/*` (each action is a small, independently testable function: `find_website`, `find_rate_page`, `fetch_page`, `classify_rate_page`, `extract_html_table`, `extract_pdf_table`, `extract_via_vision`, `extract_via_ocr`, `classify_outcome`, `commit_to_registry`, `commit_config`, `commit_rates`). The LLM is invoked *inside* specific actions (website discovery's judgment call, HTML-table interpretation via `lib/extractors/`'s LLM-fallback path, vision/OCR for image-only pages) via `lib/tier-router.js`'s tier selection and a two-tier cost model (cheap "mini" model first, escalate to a fuller model only when a post-run quality check fails — zero slabs, low confidence, unexpected failure).

Product eligibility is decided per bank in `lib/orchestrator.js` (`productsForBank`): IBUs get GIFT-only (`fd_gift`); PSB/PVB/FB and a handful of large SFBs get domestic FD + NRE/NRO/FCNR; everyone else gets domestic FD only.

This is intentionally a *conceptual* summary. The mechanics of finding/classifying pages and fighting anti-bot defenses belong to **[crawling.md](crawling.md)**; the mechanics of turning HTML/PDF/images into validated rate slabs (extractor families, schema validation, tenure/currency parsing) belong to **[extraction.md](extraction.md)**. The LLM-facing side of all this — prompt fragments, `docs/agent/*.md`, the tier/cost model in depth — is **[agent-design.md](agent-design.md)**.

## 5. The two data stores

State lives in two places, both written on every cloud run (see [overview.md §4](overview.md#4-the-two-stores-and-cloud-as-source-of-truth) for the "cloud as source of truth" policy — that's the operator directive; this section is the mechanics):

1. **Blob** (`agent-state` container) — the live working state and per-run audit trail: `output/latest/*` and `data/bank-domains.json`, pulled at run start / pushed at run end by `cloud/sync.js` (a separate process, `spawnSync`'d from `run-batch.js`, so the agent code itself stays storage-agnostic). No-ops entirely when `FIRA_STORAGE` isn't `azure`, which is how the same `run-batch.js` works unmodified locally.
2. **Git** (`azure-openai-agent` branch) — the durable, diffable, human-reviewable record. `cloud/git-publish.js` commits `output/latest/*.json`, `data/bank-domains.json`, and `pack/dist/rates-pack.json` (if rebuilt) after a successful cloud run — fetch/rebase/push with retry. Currently behind a kill switch (`FIRA_DISABLE_GIT_PUBLISH=1`).

Both stores are fronted by the same abstraction: **`lib/storage.js`**, a thin typed wrapper (`readJson`/`writeJson`/`readText`/`writeText`/`readBinary`/`writeBinary`/`exists`/`list`/`delete`) over the [`unstorage`](https://unstorage.unjs.io/) library. `createStorage()` picks a driver by `FIRA_STORAGE`: `local` → `unstorage/drivers/fs` rooted at the repo, `azure` → `unstorage/drivers/azure-storage-blob` against the `agent-state` container, `memory` → an in-process driver for tests. Keys are forward-slash, lowercase, validated (`lib/storage.js`'s `validateKey`) — the same key format works against either backend, which is what makes "identical code paths" true rather than aspirational.

Two additive-state subtleties worth knowing before you touch a runner: pack rebuilds and blob pulls are non-trivial across multiple runs (each run must not clobber the accumulated state from prior runs) — this is codified in [ADR-011](../../sdlc/decisions/ADR-011-additive-state-semantics.md). And `output/latest/`'s writers all route through `lib/safe-write.js` (ADR-012) rather than raw `fs.writeFileSync`, precisely so a bad or partial extraction can't stomp a good prior one.

## 6. Boundaries — what lives where

| Path | What it is | Sibling doc |
|---|---|---|
| `lib/` | The engine: orchestrator, tier-router, actions, extractors, storage, safe-write, confidence/checks, prompts | [agent-design.md](agent-design.md), [crawling.md](crawling.md), [extraction.md](extraction.md) |
| `data/` | Registry (`bank-domains.json`) + cohort definitions (`cohorts/*.json`) + master bank CSV | [overview.md §3](overview.md), [operator-guide.md](operator-guide.md) |
| `output/latest/` | Per-bank working state (config/rates/summary/log JSON) — **real scraped data, never let tests touch it** | [testing.md](testing.md) |
| `pack/` | Build (`build-pack.js`), quality gate, publish, baselines — assembles `output/latest/*` into `pack/dist/rates-pack.json` | [quality-checks.md](quality-checks.md) |
| `scripts/` | Operational toolbox: `azops/` (Azure ops), `pack/`, `analysis/`, `utils/` (incl. canonical `slugify.js`), `registry/`, `recovery/` | [scripts.md](scripts.md) |
| `cloud/`, `iac/`, `functions/`, `container-mgmt/` | Cloud plumbing: blob/git sync, Bicep IaC, HTTP trigger Function, job-management helpers | [deployment.md](deployment.md) |
| `docs/agent/` | The LLM agent's playbook — single source of truth for prompt content | [agent-design.md](agent-design.md) |
| `sdlc/` | Durable design record: architecture, data model, ADRs, per-sprint plan/design/implementation | table below |

## 7. Pointers table — authoritative sources

| Topic | Source |
|---|---|
| Full runtime-modes + components writeup (this doc's source material) | [`sdlc/architecture.md`](../../sdlc/architecture.md) |
| File schemas + storage layout in detail | [`sdlc/data-model.md`](../../sdlc/data-model.md) |
| Compute platform choice (Container Apps Jobs) | [ADR-002](../../sdlc/decisions/ADR-002-compute-platform.md) |
| Storage abstraction (adapter pattern, why) | [ADR-004](../../sdlc/decisions/ADR-004-storage-abstraction.md) |
| Blob container/layout (`agent-state`, `rates-pack`) | [ADR-010](../../sdlc/decisions/ADR-010-blob-layout.md) |
| Additive state across cloud runs (don't clobber prior runs' data) | [ADR-011](../../sdlc/decisions/ADR-011-additive-state-semantics.md) |
| Non-destructive write discipline (`lib/safe-write.js`) | [ADR-012](../../sdlc/decisions/ADR-012-write-discipline.md) |
| IaC tool choice (Bicep) | [ADR-001](../../sdlc/decisions/ADR-001-iac-tool.md) |
| PM auth model (service principal, no SAS) | [ADR-003](../../sdlc/decisions/ADR-003-pm-auth-model.md) |
| Trigger architecture (HTTP Function → Job) | [ADR-005](../../sdlc/decisions/ADR-005-trigger-architecture.md) |
| Environment strategy (single `prod` env) | [ADR-006](../../sdlc/decisions/ADR-006-environment-strategy.md) |
| Confidence scoring / tiered publication | [ADR-016](../../sdlc/decisions/ADR-016-confidence-scoring-tiered-publication.md) |
| Full ADR index | [`sdlc/decisions/README.md`](../../sdlc/decisions/README.md) |

---

*Onboarding-lens summary — for full rationale and edge cases, follow the links above rather than treating this page as exhaustive.*
