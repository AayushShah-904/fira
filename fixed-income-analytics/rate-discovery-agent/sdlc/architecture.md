# Architecture

The agent is a Node.js process that uses Claude (via Azure OpenAI) plus deterministic tools (Playwright, PDF text extraction, web fetch) to discover and extract bank deposit rates. It writes per-bank JSON files and a denormalized "rates-pack" bundle that downstream consumers (currently the PM's site) read.

This document covers the **runtime modes** and **components**. Schemas live in [`data-model.md`](data-model.md); deployment topology in [`deployment.md`](deployment.md). Architectural decisions are recorded in [`decisions/`](decisions/) — this document references them rather than re-stating the rationale.

## Runtime modes

The agent runs in two modes with **identical code paths** — only configuration differs.

### Local development

```
┌───────────────────────────────────────────────────────────┐
│  developer laptop                                         │
│                                                           │
│   node run-discovery.js <bank>                            │
│        │                                                  │
│        ├── reads .env  ─────►  Azure OpenAI endpoint     │
│        ├── reads/writes  ──►  ./output/latest/  (fs)     │
│        ├── reads  ──────────►  ./data/bank-domains.json  │
│        └── spawns Playwright  ──►  Chromium (npm-installed)
│                                                           │
│   node pack/build-pack.js                                │
│        └── writes  ─────────►  ./pack/dist/              │
│                                  (no upload to Azure)     │
└───────────────────────────────────────────────────────────┘
```

No containers, no cloud dependencies beyond Azure OpenAI itself. `npm test` runs unit and integration tests against the local filesystem. This is the **non-negotiable baseline** — every change must keep this working.

### Containerized (test / production)

```
┌──────────────────────────────────────────────────────────────────┐
│  Azure                                                           │
│                                                                  │
│   HTTP Function (function key auth)                              │
│        │                                                         │
│        ▼                                                         │
│   Container Apps Job  (image from ACR, scale-to-zero)           │
│        │                                                         │
│        ├── env from Key Vault refs  ──►  Azure OpenAI           │
│        ├── reads/writes via storage adapter  ──►  Blob:         │
│        │     agent-state/output/latest/                          │
│        │     agent-state/data/bank-domains.json                  │
│        ├── spawns Playwright  ──►  Chromium (in image)          │
│        └── on success: pack/publish.js  ──►  Blob:              │
│                                              rates-pack/         │
│                                                                  │
│   PM's server (third-party VM, eventually Azure)                │
│        └── service principal + bearer token  ──►  Blob:         │
│                                                    rates-pack/   │
└──────────────────────────────────────────────────────────────────┘
```

Same Node entry points. The only mode-aware code is the storage adapter and the publish step.

## Components

### 1. Agent runtime (existing)

The Node process under `run-discovery.js` / `run-batch.js` / `run-pipeline.js`. Already exists. Uses Claude via the OpenAI SDK pointed at Azure OpenAI. Tools: `fetch_url`, `run_playwright`, `fetch_pdf`, `web_search`. No changes required for sprint 001 beyond the storage adapter wrap.

### 2. Storage adapter (new in sprint 001)

Adapter pattern chosen — see [ADR-004](decisions/ADR-004-storage-abstraction.md). A thin wrapper that the agent uses for all reads/writes to `output/latest/` and `data/bank-domains.json`. Three implementations behind one interface:

| Adapter | Selected when | Backed by |
|---|---|---|
| `LocalFsStorage` | `BIRD_STORAGE=local` (or unset) | `fs/promises`, paths relative to repo root |
| `AzureBlobStorage` | `BIRD_STORAGE=azure` | `@azure/storage-blob`, container = `agent-state` (see [ADR-010](decisions/ADR-010-blob-layout.md)) |
| `MemoryStorage` | Tests where storage backend is incidental | In-process JS Map (see [ADR-009](decisions/ADR-009-local-blob-emulation.md)) |

Interface shape (canonical surface; details refined in `sprints/sprint-001-azure-foundation/design/storage-adapter.md`):

```ts
interface Storage {
  readJson(key: string): Promise<unknown>;
  writeJson(key: string, data: unknown): Promise<void>;
  readText(key: string): Promise<string>;
  writeText(key: string, text: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
```

Keys use forward slashes throughout, matching blob conventions. Local mode resolves relative to the repo root.

### 3. Trigger surface (new in sprint 001)

HTTP Function in front of Container Apps Job — see [ADR-005](decisions/ADR-005-trigger-architecture.md).

| Trigger | Local | Container |
|---|---|---|
| Manual run for one bank | `node run-discovery.js "Bank Name"` | `az containerapp job start --args ...` |
| Manual run for a batch | `node run-batch.js --banks list.txt` | HTTP POST to Function with bank list in body |
| Scheduled run | n/a (use cron on laptop if you must) | Container Apps Job cron — **deferred to sprint 002** |

The HTTP Function exists only to translate an authenticated HTTP call into a `containerapp job start` invocation. It does not run agent code itself.

### 4. Secret source

| Mode | Source |
|---|---|
| Local | `.env` file (gitignored), loaded by `dotenv` |
| Container | Container Apps secrets that reference Key Vault entries; injected as env vars at runtime |

Code reads `process.env.AZURE_OPENAI_API_KEY` either way. **No mode-aware secret handling.**

### 5. Pack publisher (new in sprint 001)

`pack/publish.js` — runs after `pack/build-pack.js`. Reads `pack/dist/rates-pack.json` (and schema + README), uploads to the `rates-pack` blob container with appropriate `Cache-Control` and `Content-Type` headers. Authenticates via the Container App's managed identity (production) — never invoked locally.

`pack/build-pack.js` itself is mode-agnostic and will keep working locally.

### 6. Distribution channel

Single Azure Storage account, two containers — see [ADR-010](decisions/ADR-010-blob-layout.md):

- `agent-state` — private, read/write by the Container App's managed identity. Holds `output/latest/`, `data/bank-domains.json`, per-run logs under `runs/<ISO-timestamp>/`.
- `rates-pack` — private, read by an Entra ID service principal granted to PM's server.

PM's server uses Azure SDK with service principal credentials (`tenant_id`, `client_id`, `client_secret`) — see [ADR-003](decisions/ADR-003-pm-auth-model.md). Each request goes out as `Authorization: Bearer <oauth-token>`. **No SAS tokens, no URLs with credentials.**

When PM's site moves to Azure, swap service principal for managed identity — same RBAC binding, no code change.

## Cross-cutting decisions (see ADRs)

| Decision | Reference |
|---|---|
| One repo, two modes (rather than a separate "cloud" branch) | Implicit in [ADR-004](decisions/ADR-004-storage-abstraction.md): adapter pattern lets the same code paths run against either backend; branch divergence avoided |
| Compute platform: Container Apps Jobs | [ADR-002](decisions/ADR-002-compute-platform.md) |
| IaC tool: Bicep | [ADR-001](decisions/ADR-001-iac-tool.md) |
| PM authentication: Entra ID service principal + bearer token (no SAS) | [ADR-003](decisions/ADR-003-pm-auth-model.md) |
| Storage abstraction: adapter pattern | [ADR-004](decisions/ADR-004-storage-abstraction.md) |
| Trigger architecture: HTTP Function → Job | [ADR-005](decisions/ADR-005-trigger-architecture.md) |
| Environment strategy: single env (`prod` only) | [ADR-006](decisions/ADR-006-environment-strategy.md) |
| Azure region: South India | [ADR-007](decisions/ADR-007-azure-region.md) |
| Test runner: `node --test` | [ADR-008](decisions/ADR-008-test-runner.md) |
| Local blob emulation: Azurite (gated) + `MemoryStorage` complement | [ADR-009](decisions/ADR-009-local-blob-emulation.md) |
| Blob layout: 1 storage account, 2 containers | [ADR-010](decisions/ADR-010-blob-layout.md) |

## What is intentionally not in this architecture (yet)

| Concern | Why deferred | Sprint where revisited |
|---|---|---|
| Scheduled runs | Manual trigger covers initial use | 002 |
| Multiple environments (dev/staging/prod) | One env is sufficient until pipeline changes need testing | 005 |
| Observability (App Insights, dashboards) | Container Apps logs cover sprint-001 needs | 003 |
| CI/CD on git push | Manual `az acr build` is acceptable at low change rate | 004 |
| VNet integration / private endpoints | No compliance driver yet | TBD |
| Per-bank cron schedules | Tiered approach covers ~95% of demand | TBD (after 002) |
