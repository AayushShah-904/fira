# Design — Function trigger (`start-discovery`)

**Status:** Design draft 2026-05-06; implementation pending review
**Implements:** [ADR-005](../../../decisions/ADR-005-trigger-architecture.md)
**Touches:** new directory `functions/start-discovery/` — Function code; Bicep module `function-app.bicep` provisions the host
**New runtime deps:** `@azure/identity` (MIT, MSAL-backed), `@azure/arm-appcontainers` (MIT, ARM SDK)

## Scope

This doc fixes the HTTP contract (request/response shapes, validation, error responses), the dispatch logic (how the Function turns a request into a Container Apps Job execution), the auth model (function key for sprint 001), and the polling story (designed but not implemented in sprint 001). The architectural choice (HTTP Function in front of the Job) is decided in ADR-005.

The Function is intentionally small — ~80–120 lines of code, plus packaging metadata. It owns three responsibilities and nothing else: input validation, ARM dispatch, audit log. **All bank-domains lookup and category expansion stay on the Job side** — see "Why no blob access from the Function" below for the RBAC reasoning.

## HTTP contract

### Endpoint

```
POST https://func-bofia-trigger-prod.azurewebsites.net/api/start-discovery
```

**Auth:** function key — header `x-functions-key: <key>` OR query string `?code=<key>`. Per ADR-005 deferred item 4, this is single-operator auth; revisit when shared.

**Content type:** `application/json`

**Methods supported:** `POST` only. `GET`, `PUT`, `DELETE` etc. return `405 Method Not Allowed`.

### Request body

The body uses one of three discriminated shapes — exactly one of `banks`, `category`, or `cadence` must be supplied:

```ts
type Request =
  | { banks: string[]; dryRun?: boolean }            // explicit slug list
  | { category: BankCategory; dryRun?: boolean }     // expand by category (Job-side)
  | { cadence: RefreshCadence; dryRun?: boolean };   // expand by refresh tier (sprint 002 hook)

type BankCategory =
  | 'PSB' | 'PVB' | 'SFB' | 'PB' | 'FB' | 'RRB'
  | 'SUCB' | 'NSUCB' | 'SSCB' | 'NSSCB' | 'DCCB'
  | 'LAB' | 'FI' | 'IBU' | 'HFC';

type RefreshCadence = 'daily' | 'weekly' | 'monthly';
```

**Why discriminated rather than mix-and-match:** if both `banks` and `category` were allowed, semantics would be ambiguous (intersection? union?). Forcing exactly one removes the question.

**Why include `cadence` in sprint 001 even though it's a sprint 002 feature:** the field is documented and the Function returns `400 not_implemented` if invoked. This nails down the API shape so PM / external integrators don't hit a breaking change when sprint 002 lands.

### Validation rules

| Rule | Failure mode |
|---|---|
| Body is valid JSON | `400 invalid_json` |
| Body is an object (not array, not primitive) | `400 invalid_body_shape` |
| Exactly one of `banks` / `category` / `cadence` is present | `400 ambiguous_request` (zero or multiple keys) |
| `banks`: non-empty array of strings | `400 invalid_banks` |
| `banks`: every entry matches `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` (slug regex from `CLAUDE.md`) | `400 invalid_slug` |
| `banks`: array length ≤ 150 | `400 too_many_banks` (150 fits within ARM's 4096-char `args` ceiling at ~25 chars/slug; see "Args size limit" below) |
| `category`: must be one of the hardcoded enum values above | `400 invalid_category` |
| `cadence`: returns `400 not_implemented` in sprint 001 | (no failure path — explicit not-yet-supported response) |
| `dryRun`: boolean if present | `400 invalid_dry_run` |

The category enum is **hardcoded in the Function source code**, not fetched from `bank-domains.json`. This is deliberate — see "Why no blob access from the Function" below. Adding a category to BIRD's bank classification requires updating the enum constant (one line) and redeploying the Function.

The validator is a small hand-written function. We considered `zod`/`ajv` and rejected the dependency for ~30 lines of validation — not worth the install footprint in a Functions Consumption plan (cold-start sensitive).

### Response — success (202 Accepted)

For an explicit `banks` request:
```json
{
  "executionId": "caj-bofia-rate-discovery-prod-2tfq8",
  "jobName": "caj-bofia-rate-discovery-prod",
  "startedAt": "2026-05-06T14:23:17.342Z",
  "bankCount": 3,
  "dryRun": false,
  "statusUrl": "https://func-bofia-trigger-prod.azurewebsites.net/api/job-status/caj-bofia-rate-discovery-prod-2tfq8"
}
```

For a `category` request:
```json
{
  "executionId": "caj-bofia-rate-discovery-prod-2tfq8",
  "jobName": "caj-bofia-rate-discovery-prod",
  "startedAt": "2026-05-06T14:23:17.342Z",
  "category": "PSB",
  "dryRun": false,
  "statusUrl": "https://func-bofia-trigger-prod.azurewebsites.net/api/job-status/caj-bofia-rate-discovery-prod-2tfq8"
}
```

**Field semantics:**
- `executionId` — the Container Apps Job execution name returned by ARM. Looks like `<jobName>-<5-char-suffix>`.
- `bankCount` — present **only** for `banks` requests where the Function knows the count. Omitted for `category` requests since the Function doesn't expand them; caller checks the resolved count via `az containerapp job execution show` or job logs.
- `category` — present only when the request used `category`; echoes the validated value back. Same pattern would apply for `cadence` in sprint 002.
- `statusUrl` — points at a `GET /api/job-status/{executionId}` endpoint **whose URL is reserved but not implemented in sprint 001**. Documented so callers store it today and the endpoint just-works when sprint 003 adds it. If a caller hits the URL in sprint 001 it returns `404 not_implemented` (designed-but-not-built endpoints get an explicit response, not a generic 404).
- `dryRun: true` — for `banks` requests, returns `202` with `resolvedBanks: string[]` and does **not** start the job. For `category` requests, the Function still dispatches the Job with `--dry-run` argv; the Job expands the category, prints the resolution to its log, and exits 0 without any LLM calls (~30s of cold-start cost, $0 LLM cost).

`202 Accepted` is correct (not `200`/`201`): the work is async and the response is acknowledgment, not completion.

### Response — error shape

All errors return:

```json
{
  "error": {
    "code": "invalid_slug",
    "message": "Bank slug 'HDFC Bank' contains uppercase letters and spaces; expected a lowercase-hyphenated slug.",
    "details": { "field": "banks", "index": 0, "value": "HDFC Bank" }
  }
}
```

Status codes:
- `400` — validation failures (request shape problem)
- `401` — missing or invalid function key
- `405` — unsupported method
- `500` — unexpected server error (uncaught exception, ARM SDK throw)
- `502` — ARM dispatch failed (job exists but the start call returned an error from Azure)

**Why distinguish 502 vs 500:** 502 means "the dispatch call to ARM specifically failed" (transient Azure issue, retryable by the caller); 500 means "Function code itself broke" (not retryable; bug). Useful for caller logic.

There is no `503` — under Option B, the Function has no dependency on the agent storage account, so storage-availability failures are not in the Function's response surface. (They surface inside the Job execution, which the caller observes via execution status.)

### Examples

**Explicit slugs:**
```bash
curl -X POST -H "Content-Type: application/json" -H "x-functions-key: $KEY" \
  "https://func-bofia-trigger-prod.azurewebsites.net/api/start-discovery" \
  -d '{"banks": ["state-bank-of-india", "hdfc-bank-limited"]}'
```

**Category expansion (Job-side):**
```bash
curl -X POST -H "Content-Type: application/json" -H "x-functions-key: $KEY" \
  "https://func-bofia-trigger-prod.azurewebsites.net/api/start-discovery" \
  -d '{"category": "PSB"}'
```

**Dry run on a category** (Function dispatches Job with `--dry-run`; Job logs the resolved bank list and exits 0):
```bash
curl -X POST -H "Content-Type: application/json" -H "x-functions-key: $KEY" \
  "https://func-bofia-trigger-prod.azurewebsites.net/api/start-discovery" \
  -d '{"category": "PSB", "dryRun": true}'
# → 202; check job log for the resolved slug list
```

## Why no blob access from the Function

The Function MI is granted **no role on the agent storage account** (`stbofiarateagentprod01`). The only blob access path it has is to its own runtime account (`stbofiafuncprod01`) — Functions internals.

This is a deliberate isolation choice. Two paths were considered for category expansion:

1. **Function reads `bank-domains.json` from `agent-state` container** — would require `Storage Blob Data Reader` scoped to that container. Pro: Function returns a synchronous `bankCount` to the caller. Con: weakens the cross-account isolation that drove the two-account split in [bicep-modules.md](./bicep-modules.md). The Function would have a foot in the data plane it's supposed to be insulated from.

2. **Function delegates expansion to the Job (chosen).** Function passes `--category PSB` through as Job argv. The Job's existing MI has `Storage Blob Data Contributor` on `agent-state` — it reads `bank-domains.json`, expands the category, and proceeds. Function has zero blob roles on the agent account. Trade-off: response omits `bankCount` for category requests; caller looks up the resolved count from job logs.

Choice (2) preserves the principle that the trigger surface is auth + dispatch only, with the data plane fully owned by the Job. The cost (no synchronous bank count) is mild — operators routinely check job logs anyway.

**Cadence (sprint 002)** will follow the same pattern: Function passes `--cadence weekly` to the Job; Job expands using `bank-domains.json`'s `refresh_cadence` field.

## Dispatch logic

### Step 1: Build the argv for the Job

| Request shape | Job argv |
|---|---|
| `{banks: ['a', 'b']}` | `['a', 'b']` (existing `run-batch.js` CLI: positional slug list) |
| `{banks: ['a', 'b'], dryRun: true}` | `['--dry-run', 'a', 'b']` |
| `{category: 'PSB'}` | `['--category', 'PSB']` |
| `{category: 'PSB', dryRun: true}` | `['--category', 'PSB', '--dry-run']` |
| `{cadence: 'weekly'}` | (rejected at validation; sprint 002) |

The Job's entrypoint (see [container-image.md](./container-image.md)) honors these flags. `run-batch.js` already accepts a positional slug list and `--category` from local CLI use — `--dry-run` is the one new flag to add for sprint 001 (prints resolved bank list, exits 0, no LLM calls).

**Args size limit:** Azure Container Apps Jobs accept up to 4096 chars of `args` per ARM docs. At ~25 chars per slug + delimiter, that caps explicit `banks` requests at ~150 entries. The validator rule `banks.length ≤ 150` is set under the args ceiling so the validator catches oversize inputs before ARM rejects them with a less-helpful error. `category` requests are short (~20 chars total argv) — no concern.

If a future request shape exceeds the limit (e.g., explicit lists of >150 banks), the path is: write the slug list to a blob in the Function's own storage account, pass the blob ref as argv, Job fetches via SDK using its existing storage credential. Not built in sprint 001.

### Step 2: Start the Container Apps Job execution

Using `@azure/arm-appcontainers`:

```js
const { ContainerAppsAPIClient } = require('@azure/arm-appcontainers');
const { DefaultAzureCredential } = require('@azure/identity');

const credential = new DefaultAzureCredential();
const client = new ContainerAppsAPIClient(credential, subscriptionId);

const execution = await client.jobs.beginStartAndWait(
  resourceGroup,
  jobName,
  {
    template: {
      containers: [{
        name: 'rate-discovery',
        image: undefined,            // inherit from job spec
        args: jobArgv,               // built in step 1
        env: [
          { name: 'TRIGGER_SOURCE', value: 'function' },
          { name: 'TRIGGER_REQUEST_ID', value: invocationContext.invocationId },
        ],
      }],
    },
  }
);

return {
  executionId: execution.name,            // e.g. 'caj-bofia-rate-discovery-prod-2tfq8'
  startedAt: execution.properties.startTime,
};
```

**Why `beginStartAndWait`:** it polls the Long-Running Operation until ARM confirms the execution is created (not until the job finishes — that would be minutes). Typically returns in 1–3 seconds. We could use `beginStart` (fire-and-forget) but `beginStartAndWait` gives us the canonical execution name in the response, which is what the caller wants.

**Why `args` not `env` for the bank list:** Container Apps Jobs treat `args` as the container's command-line arguments — `node run-batch.js state-bank-of-india hdfc-bank-limited`. Env vars are configuration; argv is input. The agent's `run-batch.js` already accepts argv per the existing CLI.

### Step 3: Build the response

For `banks` requests, set `bankCount: banks.length`. For `category` requests, set `category: <validated-value>` (no count). Always set `executionId`, `jobName`, `startedAt`, `dryRun`, `statusUrl`.

Log a structured entry to the Function's Application Insights trace (sprint 003 picks up the dashboard side; the trace itself is automatic). Return `202`.

## Code structure

```
functions/
└── start-discovery/
    ├── function.json              (Functions v3 binding metadata)
    ├── index.js                   (handler — orchestrates validate → dispatch → respond)
    ├── lib/
    │   ├── validate.js            (request validator + hardcoded category enum)
    │   ├── build-argv.js          (request shape → Job argv array)
    │   └── dispatch.js            (ARM SDK call wrapper)
    └── package.json               (deps: @azure/identity, @azure/arm-appcontainers)
```

Note: no `resolve-banks.js` module — there is no resolution to do.

`function.json` (v3 binding):
```json
{
  "bindings": [
    {
      "authLevel": "function",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["post"],
      "route": "start-discovery"
    },
    {
      "type": "http",
      "direction": "out",
      "name": "res"
    }
  ]
}
```

We use Functions v4 isolated worker model? — **No**, in-process v3 with `function.json`. The isolated model is the modern path but adds packaging complexity (separate process, more cold-start) for our trivial use case. In-process v3 + Node 20 is fully supported and sufficient. Open question 1 below tracks the migration.

## Async / polling story

Sprint 001 returns `202` and an `executionId`. There is **no** in-product status endpoint in sprint 001 — the operator polls via Azure CLI:

```bash
az containerapp job execution show \
  --name <executionId> \
  --job-name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia
```

The `statusUrl` in the response points at a future `GET /api/job-status/{executionId}` endpoint which is **reserved but not implemented**. Calling it in sprint 001 returns:

```json
{
  "error": {
    "code": "not_implemented",
    "message": "GET /api/job-status/{executionId} is reserved for sprint 003. Use 'az containerapp job execution show' for now."
  }
}
```

with `404`. Sprint 003 (observability) implements it as a thin wrapper over the same ARM SDK (`client.jobsExecutions.get(...)`), returning execution status + start time + completion time + exit code + log link.

**Why design the URL now if we're not building it:** the response shape is part of the API contract. Adding a field later is fine; renaming or moving an endpoint URL later is breaking. Pin it now.

## Idempotency

Sprint 001: no idempotency logic. Two identical requests start two job executions. This is acceptable because:
- ADR-010 specifies last-writer-wins concurrency at the file level
- The agent's discovery is read-only on the world (re-running just costs LLM tokens, doesn't corrupt data)
- The caller is the operator; double-clicks are their responsibility

Sprint 002 may add: a per-bank "last successful run" timestamp in `bank-domains.json`; the Job-side resolution of `category`/`cadence` requests can filter out recently-run banks. The Function stays out of this — consistent with Option B's separation.

## Cold-start budget

Functions Consumption (Y1) cold-start for Node 20 typically ~1.5–2.5s. Adding `@azure/identity` + `@azure/arm-appcontainers` to the bundle adds ~300–500ms of first-request import overhead. Total worst-case cold response ~3s.

The operator's perspective: they're starting a batch that will run for minutes. 3 seconds of dispatch latency is invisible. No optimization needed.

If cold-start ever becomes a problem (e.g., a UI that pings the trigger frequently), migrate to Flex Consumption (FC1) — open question 4 in [bicep-modules.md](./bicep-modules.md).

## Audit / observability

Sprint 001:
- Functions runtime logs every invocation to Application Insights automatically (request URL, status code, duration, source IP)
- The handler emits one `context.log.info({...})` line per invocation summarizing the request shape and the dispatched execution ID
- All Application Insights data in the Function App's default workspace; queryable via the portal

Sprint 003 will add:
- A KQL dashboard showing trigger invocations vs. job executions, success/failure correlation
- An alert on dispatch failure rate >1% over 1 hour

## Testing approach

Per ADR-008 (`node --test`):

**Unit tests** — `tests/functions/start-discovery/`:
- `validate.test.js` — every validation rule (positive + negative cases)
- `build-argv.test.js` — request → argv mapping for every supported request shape including dryRun variants
- `dispatch.test.js` — ARM SDK call shape, with the SDK mocked

No `resolve-banks.test.js` — no resolution to test.

**Integration test** — runs the Function locally with `func start`, hits it with `curl`, verifies:
- `400` cases return the documented error shapes
- A valid `dryRun: true` request on `banks` returns `202` with `resolvedBanks` and does not call ARM (verified via mock)
- A valid request without `dryRun` calls ARM with the expected payload (argv shape verified)

**End-to-end smoke** — covered by sprint 001 success criterion 3 (real Function → real Job → real blob update).

## Open implementation questions

1. **Functions in-process v3 vs isolated v4 worker.** In-process v3 chosen for sprint 001 — lower cold-start, simpler packaging. Migration to v4 isolated tracked in sprint 004 (CI/CD) when the build pipeline can absorb the packaging shift.
2. **Validator library.** Hand-rolled for sprint 001 (~30 LOC, no dependency). If validation grows past ~6 fields, switch to `zod`. Not blocking.
3. **Function key rotation.** Function keys live in the Function App's `host.json` keystore. Rotation is a portal click / az CLI command. Not in code; documented in `entra-app-pm-access.md` rotation runbook (the same runbook covers PM SP secret rotation — operationally adjacent).
4. **CORS.** No browser callers in sprint 001 (operator uses curl; PM uses server-side SDK). CORS stays default (none) — easier to enable later than to lock down later.
5. **`run-batch.js --dry-run` flag.** Sprint 001 needs to add this small flag to the agent's CLI: parse argv, expand category if `--category` present, print resolved slug list to stdout, exit 0. ~10 LOC change. Tracked under the agent-side implementation work, not the Function-side.

## Acceptance criteria

The design is implemented when:

- `functions/start-discovery/index.js` + supporting files commit; `func start` runs locally
- The validation rule table is fully covered by `tests/functions/start-discovery/validate.test.js`
- A local `func start` accepts `curl` requests with the documented shapes and returns the documented responses
- Deployed to the Function App, the smoke test from `scope.md` success criterion 3 passes (curl with `{"banks": ["hdfc-bank-limited"]}` → 202 → job execution succeeds → blob updated)
- The Application Insights trace shows one structured log per invocation
- The reserved `GET /api/job-status/{executionId}` endpoint returns the `not_implemented` 404 when called
- The Function App's MI has zero role assignments on the agent storage account (verified via `az role assignment list --assignee <function-mi-principal-id>`)
- The agent's `run-batch.js` accepts `--dry-run` and exits 0 after printing the resolved slug list
