# Sprint 001 — Azure Foundation

**Status:** Plan approved (2026-05-05) — ready for design phase
**Goal:** Stand up the minimum viable Azure footprint so the agent can be triggered manually in the cloud and the pack can be fetched by PM's site under proper auth — while keeping local development fully functional without containers.

**Foundational decisions:** All 10 ADRs (001 through 010) are DECIDED. See [`../../../decisions/`](../../../decisions/) for the full set. Sprint 001 implements those decisions; it does not re-litigate them.

## Scope

### In scope

1. **Storage adapter** (`lib/storage.js`) per [ADR-004](../../../decisions/ADR-004-storage-abstraction.md):
   - `LocalFsStorage` (default; selected by `BIRD_STORAGE=local` or unset)
   - `AzureBlobStorage` (selected by `BIRD_STORAGE=azure`) — container = `agent-state` per [ADR-010](../../../decisions/ADR-010-blob-layout.md)
   - `MemoryStorage` for unit tests per [ADR-009](../../../decisions/ADR-009-local-blob-emulation.md)
   - Refactor agent code (`run-discovery.js`, `run-batch.js`, `run-pipeline.js`, helpers) to read/write through the adapter rather than direct `fs` calls. **No behavior change in local mode.**

2. **Container image** (`Dockerfile`) based on `mcr.microsoft.com/playwright:vX-jammy`:
   - Bundles Node 20, npm dependencies, the agent code
   - Entrypoint takes a bank list and runs the existing batch flow
   - Local devs do **not** need to build or run this image to develop

3. **Pack publisher** (`pack/publish.js`):
   - Uploads `pack/dist/*` to the `rates-pack` blob container with appropriate `Content-Type` and `Cache-Control`
   - Authenticates via `DefaultAzureCredential` (managed identity in container, dev's Azure CLI session locally if explicitly invoked)
   - Invoked from a single npm script (`npm run publish-pack`); not invoked by `pack/build-pack.js` itself

4. **Bicep modules** per [ADR-001](../../../decisions/ADR-001-iac-tool.md), under `iac/`:
   - `acr.bicep`, `storage.bicep`, `keyvault.bicep`, `container-apps-env.bicep`, `container-apps-job.bicep`, `function-app.bicep`
   - `main.bicep` composes them
   - One `parameters.prod.bicepparam` file (env name encoded in resource names per [ADR-006](../../../decisions/ADR-006-environment-strategy.md))
   - References the existing Azure OpenAI resource in South India per [ADR-007](../../../decisions/ADR-007-azure-region.md) — no provisioning of a new OpenAI resource
   - `what-if`-clean apply against a fresh resource group
   - Container Apps Environment provisioned without VNet integration per [ADR-002](../../../decisions/ADR-002-compute-platform.md)

5. **Entra ID app registration** for PM's read access per [ADR-003](../../../decisions/ADR-003-pm-auth-model.md):
   - `app-bird-pm-rates-reader-prod` service principal
   - `Storage Blob Data Reader` role assignment scoped to `rates-pack` container only
   - Documented handoff: tenant ID, client ID, initial client secret to PM (out-of-band channel)
   - Secret rotation procedure documented

6. **HTTP Function trigger** (`functions/start-discovery/`) per [ADR-005](../../../decisions/ADR-005-trigger-architecture.md):
   - Single HTTP endpoint, function key auth
   - Body: `{ "banks": ["slug1", "slug2"] }` or `{ "category": "PSB" }`
   - Validates input, invokes `az containerapp job start` equivalent via the Azure SDK with the bank list as job args
   - Returns the job execution ID

7. **Test scaffolding** per [ADR-008](../../../decisions/ADR-008-test-runner.md) and [ADR-009](../../../decisions/ADR-009-local-blob-emulation.md):
   - `node --test` runner wired up; `npm test` script
   - Storage adapter unit tests against `LocalFsStorage` and `MemoryStorage`
   - Azurite-gated tests against `AzureBlobStorage` (skip cleanly when Azurite absent)
   - Integration test for one bank end-to-end with mocked LLM
   - Regression snapshot test for the rates pack

8. **End-to-end smoke test:**
   - Single command from a clean Azure subscription provisions everything
   - Manual trigger via Function for one bank (HDFC)
   - Verify: container starts, agent runs, blob updated in `agent-state`, pack rebuilt, pack uploaded to `rates-pack`, PM credentials can fetch the pack

### Out of scope (deferred — see `deferred.md`)

- Scheduled / cron triggers (sprint 002)
- Multiple environments — dev/staging/prod (sprint 005)
- CI/CD on git push (sprint 004)
- Application Insights, dashboards, alerting (sprint 003)
- VNet integration, private endpoints (no current driver)
- Per-bank cron schedules (deferred indefinitely; tiered approach planned for sprint 002)
- Pack versioning / historical packs (revisit if PM requests)
- Authentication migration from client secret to managed identity for PM (auto-resolves when PM moves to Azure)

## Success criteria

A reviewer can confirm sprint 001 is done by running each of these:

1. **Local dev still works:**
   ```
   git clone <repo> && cd rate-discovery-agent
   npm install
   cp .env.example .env  # populate AZURE_OPENAI_API_KEY etc.
   node run-discovery.js "HDFC Bank Limited"
   # → produces output/latest/hdfc-bank-limited_*.json
   node pack/build-pack.js
   # → produces pack/dist/rates-pack.json
   ```
   No Azure infra required for any of the above.

2. **Provisioning is repeatable:**
   ```
   az deployment group create --resource-group rg-bird-rate-agent-prod-southindia \
     --template-file iac/main.bicep --parameters iac/parameters.prod.bicepparam
   ```
   Brings up all resources from scratch in under 10 minutes. `what-if` returns no changes on a second apply.

3. **Manual cloud trigger works:**
   ```
   curl -X POST -H "x-functions-key: <key>" \
     "https://func-bird-trigger-prod.azurewebsites.net/api/start-discovery" \
     -d '{"banks": ["hdfc-bank-limited"]}'
   ```
   Returns a job execution ID. Within ~5 minutes:
   - The Container Apps Job execution shows succeeded
   - `agent-state` container has updated `output/latest/hdfc-bank-limited_*.json`
   - `rates-pack` container has updated `rates-pack.json`

4. **PM can read the pack with bearer token (no SAS in URL):**
   ```
   # Using PM's tenant ID, client ID, client secret:
   az login --service-principal -u <client-id> -p <secret> --tenant <tenant>
   az storage blob download \
     --account-name <storage> --container-name rates-pack \
     --name rates-pack.json --auth-mode login --file /tmp/pack.json
   ```
   Succeeds. `Authorization: Bearer ...` is the only credential header.

5. **Tests are green:**
   ```
   npm test
   ```
   - Unit tests pass (parsers, validators, slug, storage adapter local mode)
   - Integration test passes for one bank with mocked LLM, both `BIRD_STORAGE=local` and (if Azurite is running) `BIRD_STORAGE=azure`
   - Regression snapshot test passes against the checked-in golden pack

6. **Cost guardrail in place:**
   - Cost Management alert at $100/month on the resource group
   - First week of operation stays under $5 of infra cost (excluding any large agent runs)

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Storage adapter refactor breaks current agent behavior in local mode | Medium | Keep all existing tests passing; add storage-adapter unit tests with `LocalFsStorage` first; refactor incrementally per file |
| `mcr.microsoft.com/playwright` base image doesn't include all needed Chromium deps for our extraction | Low | Smoke test in container before considering image done; fall back to building from `node:20` + `npx playwright install` if needed |
| Container Apps Job startup latency (cold start) makes per-bank manual triggers feel sluggish | Medium | Acceptable for sprint 001 (manual trigger expected to be infrequent); revisit if it impacts UX |
| Azure OpenAI rate limits hit when batch run includes too many banks | Medium | Sprint 001 only requires one-bank smoke test; throughput tuning is sprint 002+ |
| PM service principal client secret is leaked during handoff | Medium | Use 1Password share / equivalent; rotate within 24h if any concern; secret has 90-day expiry by default |
| Bicep modules accumulate copy-paste from MS docs without understanding | Low | Each module reviewed against the resource's actual ARM schema; `what-if` reviewed before each apply |

## Dependencies

- Azure subscription with Contributor access on a new resource group ✅ (assumed available)
- Tenant Admin or Application Administrator role for the Entra ID app registration ⚠ (verify before starting)
- Azure CLI ≥ 2.50 installed locally
- Bicep CLI installed (`az bicep install`)
- An existing Azure OpenAI resource in South India with deployments for the models the agent uses ✅ (confirmed during ADR-007 — exists, will be referenced)

## Estimated effort

| Workstream | Estimate |
|---|---|
| Bicep learning curve (decider new to Bicep — Terraform-AWS background) | 1–2 days |
| Storage adapter + refactor + tests | 1.5–2 days |
| Bicep modules + first apply + smoke | 1.5–2 days |
| Container image + entrypoint + ACR push | 0.5–1 day |
| HTTP Function + RBAC + manual trigger smoke | 0.5–1 day |
| Pack publisher + PM SP setup + handoff | 0.5–1 day |
| Documentation (design/, implementation/, test/) | 0.5–1 day |
| **Total** | **~6–10 working days** |

## Sprint artifacts

- `plan/scope.md` — this document
- `plan/deferred.md` — items consciously left out, with revisit conditions
- `design/` — to be populated during the sprint (storage-adapter interface, Bicep module decisions, Function entrypoint contract)
- `implementation/` — to be populated as work progresses (deviations from design, gotchas)
- `test/` — to be populated with manual smoke logs and test results
- `retrospection/` — to be written at sprint close
