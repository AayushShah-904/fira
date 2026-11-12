# Test strategy

The agent has been operated to date with manual smoke testing — running `node run-discovery.js "<bank>"` against a known bank and eyeballing the output. That model has scaled poorly: the gap-fill batch surfaced regressions (Tier 2 retry deleting good Tier 1 files, Playwright timeouts, FCNR currency assignment) that automated tests would have caught.

This document describes the layered test approach the agent should adopt as part of sprint 001 onwards. **Local-dev parity is enforced at the test layer**: every test that runs in CI / containerized mode must also runnable on a developer laptop with `npm test`.

## Layers

### 1. Unit tests — pure functions, no I/O

| Target | Examples |
|---|---|
| `scripts/utils/parse-tenure.js` | "7 days to 45 days" → `{ min: 7, max: 45 }`; "5 years and above" → `{ min: 1826, max: null }` |
| `scripts/utils/parse-csv.js` | Quote-aware split on `"Apani Sahakari Bank Ltd., Ahmedabad", ...` |
| `scripts/utils/validate-rates.js` | Reject negative rates, rates > 20%, malformed currency codes; variant-specific bounds (FCNR ≤ 7%, regular ≤ 10%) |
| Slug derivation | "Cosmos Co-operative Bank Ltd." → `cosmos-co-operative-bank-ltd` per the rule in `CLAUDE.md` |
| Rate-pack assembly | Given fixture per-bank files, produce expected `rates-pack.json` shape and counts |

**Runner:** `node --test` (Node's built-in test runner) — see [ADR-008](decisions/ADR-008-test-runner.md). Already available, no dependencies. Move to a heavier framework only if test-organization friction shows up.

**Speed target:** the full unit suite runs in under 5 seconds on a developer laptop.

### 2. Integration tests — agent loop, mocked LLM

One bank end-to-end, using **fixture HTTP responses** for every external call:

- `fetch_url` returns canned HTML for the bank's homepage and rate page
- `run_playwright` returns canned `JSON_OUTPUT` blocks
- `web_search` returns canned hit lists
- The Claude API call is replaced with a recorded transcript replay

The test asserts:

- The agent writes `output/latest/<slug>_config.json` and `output/latest/<slug>_rates.json` with expected shape
- `bank-domains.json` is updated correctly
- Token / cost telemetry is recorded
- No unexpected files are written or deleted

**Fixtures live in** `tests/fixtures/<bank-slug>/` — one folder per recorded scenario. New fixtures are recorded by running the real agent against the bank with a recorder flag, then trimming to the minimum needed.

**Storage adapter dimension** (see [ADR-009](decisions/ADR-009-local-blob-emulation.md)): integration tests run twice — once with `BIRD_STORAGE=local` against a `tmp` directory, once with `BIRD_STORAGE=azure` against [Azurite](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite). Both must pass. Azurite is launched by a `npm run test:integration` setup step (or explicitly skipped if the developer doesn't have it installed — Azurite-mode tests skip with a warning, not a failure, so local-only flow stays green). A `MemoryStorage` adapter implementation is also available for unit tests where the storage backend is incidental.

### 3. Regression tests — snapshot diff against golden fixtures

A small **fixed bank list** (e.g., 5 representative banks: one PSB, one PVB with NRE/NRO/FCNR, one SFB, one SUCB, one IBU) is run end-to-end with mocked LLM responses. The resulting `rates-pack.json` is byte-compared to a checked-in golden snapshot.

This is the safety net for the "Tier 2 deleted Tier 1 files" class of bug. If the pack changes unexpectedly, the test fails and the diff is surfaced.

Golden snapshots are updated only via `npm run test:regression -- --update`, with the diff reviewed in the PR.

### 4. Manual smoke — post-deploy and pre-release

| When | What |
|---|---|
| After every Bicep deploy | `az containerapp job start` for one known-stable bank (e.g., HDFC), verify pack is published and PM-readable |
| Before promoting a refreshed pack to PM | Eyeball `rates-pack/README.md` for sane counts; spot-check one bank's slabs in the JSON |
| Quarterly | Full re-run against the priority list, compare slab counts to baseline, investigate any > 10% drop |

Manual smoke results are logged in `sdlc/sprints/sprint-NNN-<slug>/test/` for the active sprint.

## What is explicitly out of scope (initially)

| Concern | Why skipped | When to revisit |
|---|---|---|
| End-to-end tests against the **real** Claude API | Cost + flakiness; the API behavior is not the agent's responsibility to test | If a Claude API change ever breaks production silently |
| Load tests on Container Apps Job | Concurrency model is one-job-per-batch; load is not a current risk | If we move to per-bank concurrent jobs |
| Chaos tests (network failures, partial blob writes) | Last-writer-wins is acceptable, no transactional guarantees claimed | If we ever need transactional pack updates |
| Visual regression on PM's UI | Not our system to test | Never (PM owns this) |

## Coverage targets

No numeric coverage threshold is enforced. Coverage is measured (`node --test --experimental-test-coverage`) and reported in PR comments, but the bar is qualitative:

- Every parser / validator has at least one positive and one negative test
- Every variant (regular, nre, nro, fcnr, gift) has at least one fixture in the regression set
- Every storage-adapter method has a test against both `LocalFsStorage` and (Azurite-gated) `AzureBlobStorage`

## Local vs. containerized parity — concrete obligations

The non-negotiable rules:

1. `npm test` must pass on a freshly cloned repo with no Azure setup, by skipping (not failing) Azurite-gated tests.
2. The same `npm test` must pass inside the production container image with `BIRD_STORAGE=local` against the container's tmp filesystem.
3. CI runs `npm test` plus an additional `BIRD_STORAGE=azure` pass against a CI-provisioned Azurite container.

If a test fails only in one mode, that's a parity bug — the production code is wrong, not the test.
