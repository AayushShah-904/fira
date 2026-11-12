# ADR-009: Local emulation for blob storage in tests

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — Azurite (gated to skip when unavailable), plus a complementary `MemoryStorage` adapter implementation |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-05 |
| Sprint | 001 |
| Supersedes | — |

## Context

The storage adapter (ADR-004) has two implementations: `LocalFsStorage` (local fs) and `AzureBlobStorage` (Azure Blob SDK). Unit tests for the agent will use `LocalFsStorage` against a `tmp/` directory — these run anywhere with no setup.

The question: how do we test the `AzureBlobStorage` implementation itself without requiring a live Azure subscription on every developer's laptop?

Two scenarios where this matters:
- A developer changes the adapter and wants to verify both implementations behave identically
- CI runs the test suite — should it spin up real Azure resources, or use a local emulator, or skip Azure-side tests entirely?

## Options considered

### Option 1: Azurite (Microsoft's official Azure Storage emulator)

**What it is:** Microsoft-maintained, open-source emulator for Azure Blob, Queue, and Table services. Runs as a Node app, Docker container, or VS Code extension. Implements the Azure Storage REST API locally.

**Pros:**
- Official Microsoft tool; behavior closely matches production Azure Blob
- Free, no licensing
- Runs as a container (`mcr.microsoft.com/azure-storage/azurite`) or `npm install -g azurite`
- Supports the full blob API surface we need (read, write, list, delete, RBAC simulation is limited but sufficient for our adapter tests)
- Same connection-string / SDK call pattern as production — only the endpoint changes
- Used by Microsoft's own SDK test suites — high confidence in fidelity

**Cons:**
- Adds a runtime dependency for the test environment (developer must install or run a container)
- Some advanced features (managed identity, full RBAC enforcement) are not emulated — auth-related tests need to be structured around this
- Slight startup overhead (~1s) per test run if not kept running

### Option 2: In-memory mock (custom or library)

**What it is:** Write a `MemoryStorage` implementation of the same `Storage` interface that holds data in a JS Map. Use it in tests.

**Pros:**
- Zero runtime dependencies
- Instant — no container startup
- Trivial to inspect / mutate state during tests

**Cons:**
- **Tests the interface, not the actual `AzureBlobStorage` implementation.** A bug in the Azure SDK call wiring would slip through.
- Doesn't catch real Azure Blob behavior quirks (case sensitivity, eventual consistency on list, etag handling)
- Useful as a complement to other approaches but not a substitute

### Option 3: LocalStack

**What it is:** Multi-cloud emulator (AWS-focused, with limited Azure support).

**Pros:**
- Single tool for multi-cloud scenarios

**Cons:**
- Azure support is incomplete and second-class compared to AWS
- Heavier than Azurite (multi-service Docker image)
- We're Azure-only — no benefit from the multi-cloud aspect
- Microsoft's own emulator (Azurite) is the obvious choice for Azure
- Disqualifying: not the right tool for the job

### Option 4: Skip Azure-side tests entirely; rely on production smoke

**What it is:** Test only `LocalFsStorage` in unit tests. Catch Azure-side issues by smoke-testing in production after each deploy.

**Pros:**
- No emulator setup
- Lowest CI complexity

**Cons:**
- Bugs in `AzureBlobStorage` only surface in production
- Adapter parity (the explicit goal of having two implementations) is not actually verified
- Failure feedback loop is slow (push image → deploy → smoke fails → debug)
- Cheapens the whole "two implementations behind one interface" approach — if we don't test the Azure side, we don't really know it works

### Option 5: Real Azure subscription with a dedicated test storage account

**What it is:** Provision a real Azure storage account just for tests. CI uses it; developers can opt-in.

**Pros:**
- Highest fidelity — production-identical behavior
- No emulator quirks

**Cons:**
- Requires Azure credentials in CI (secret to manage)
- Costs ~$1/mo plus per-operation cost (small but real)
- Tests that hit real Azure are slower and flakier (network)
- Tests can interfere with each other (shared state) unless careful
- Onboarding friction for new contributors (must have Azure access just to run tests)
- Catastrophic if a test bug accidentally writes to the wrong storage account

## Tradeoffs

| Axis | Azurite | In-memory mock | LocalStack | Skip | Real Azure |
|---|---|---|---|---|---|
| Tests `AzureBlobStorage` code | Yes | No (just interface) | Yes | No | Yes |
| Setup cost (developer) | Low (container or npm) | None | Medium (Docker, configure) | None | High (Azure access) |
| Setup cost (CI) | Low | None | Medium | None | Medium (secrets) |
| Speed | Fast (~1s startup) | Instant | Slow (multi-service) | N/A | Slowest (network) |
| Fidelity | High | None | Medium | N/A | Perfect |
| Cost | $0 | $0 | $0 | $0 | ~$1+/mo + per-op |
| Maintained by | Microsoft | Us | LocalStack team | N/A | Microsoft (live service) |

## Recommendation

**Option 1: Azurite, gated so tests skip cleanly when unavailable.**

Reasoning: It's the only option that actually exercises the `AzureBlobStorage` code without requiring real Azure. Microsoft maintains it specifically for this purpose. The setup cost is genuinely low — `docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite` or `npm install -g azurite && azurite-blob` works on any machine.

The "gated to skip" part is important: a developer cloning the repo without Azurite installed should be able to run `npm test` and see all tests pass except Azure-blob-specific ones, which print "skipped: Azurite not running on localhost:10000" rather than failing. CI installs and runs Azurite; local devs can opt-in.

In-memory mock (Option 2) is useful as a *complement* — for unit tests that just need a `Storage` instance and don't care which backend, the in-memory version is faster than Azurite. But it doesn't replace Azurite for testing the `AzureBlobStorage` adapter itself.

The other options are either disqualified (LocalStack — wrong tool) or don't actually solve the problem (skip — defeats the purpose; real Azure — too much friction for routine testing).

## Consequences

If chosen:
- Add `azurite` to `devDependencies` (or document as optional with `mcr.microsoft.com/azure-storage/azurite` Docker)
- `tests/_helpers/azurite.js` — utility that checks if Azurite is reachable on `localhost:10000` and returns a configured `AzureBlobStorage` instance pointed at it (with the well-known development connection string)
- `AzureBlobStorage` tests use `before()` to check Azurite availability and `t.skip()` cleanly if not present
- CI step: start Azurite container, run tests, stop Azurite
- Document in README: "To run the full test suite locally, install Azurite (`docker run -d -p 10000:10000 mcr.microsoft.com/azure-storage/azurite`)"
- Add an in-memory `MemoryStorage` implementation as well, for unit tests where the storage backend is incidental — small additional cost, real ergonomic gain

Lock-in: very low. Azurite gating is a few lines of helper code; switching to a different emulator or removing it is mechanical.

## Open questions (resolved + deferred)

1. **Continuous-run Azurite in dev?** DEFERRED — minor preference, resolved when first developer onboarding doc is written. Docker Compose recipe optional but recommended.
2. **Add `MemoryStorage`?** RESOLVED — yes. Fast unit tests where the backend is incidental. ~50 lines of code, useful complement to Azurite.
3. **RBAC-dependent tests:** DEFERRED to real-Azure smoke tests post-deploy — acceptable. Azurite's limited RBAC fidelity is documented. Sprint 001's smoke-test list (`test/smoke-tests/`) explicitly covers PM-SP-can-only-read-rates-pack as a post-deploy verification.

## Decision log

- **2026-05-05** — Status: PROPOSED → DECIDED. Chosen option: **Option 1 (Azurite, gated to skip when unavailable) + complementary `MemoryStorage` adapter**.
  - In-memory mock alone (Option 2) ruled out as the sole approach: tests the interface but not the actual `AzureBlobStorage` code; Azure SDK wiring bugs would slip through. Adopted as a complement, not a substitute.
  - LocalStack ruled out — Azure support is second-class.
  - Skip-entirely ruled out — would defeat the purpose of having two implementations behind one interface.
  - Real-Azure-for-tests ruled out — too much friction (Azure access required for every contributor) and flaky.
  - Azurite gating policy: tests print "skipped: Azurite not running on localhost:10000" rather than failing when Azurite is absent. CI installs Azurite container; local devs opt-in.
  - Three storage implementations exist after this: `LocalFsStorage` (default for local dev), `AzureBlobStorage` (production + Azurite-backed tests), `MemoryStorage` (unit tests where backend is incidental).
