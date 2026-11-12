# ADR-004: Storage abstraction for local-vs-cloud parity

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — Adapter pattern (`lib/storage.js` with `LocalFsStorage` and `AzureBlobStorage` implementations) |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-04 |
| Sprint | 001 |
| Supersedes | — |

## Context

The agent currently reads/writes JSON files directly to the local filesystem (`output/latest/`, `data/bank-domains.json`, `pack/dist/`). When deployed to Azure (sprint 001), the same code must instead read/write Azure Blob Storage — but local development must continue to use the filesystem with no Azure dependency, per explicit requirement.

The agent code that touches storage today is spread across:
- `run-discovery.js`, `run-batch.js`, `run-pipeline.js` (entry points)
- `lib/` (shared helpers — there are several `fs.readFileSync` / `fs.writeFileSync` calls)
- `scripts/` (utilities like `analyze-gaps.js`, `extract_rates_pdf.mjs`)
- `pack/build-pack.js` (reads from `output/latest/`, writes to `pack/dist/`)

The number of touch points is small (~30 call sites estimated) but they're not centralized.

## Options considered

### Option 1: Adapter pattern (`lib/storage.js` with two implementations)

**What it is:** Define a `Storage` interface with methods like `readJson(key)`, `writeJson(key, data)`, `list(prefix)`, `exists(key)`, `delete(key)`. Two implementations: `LocalFsStorage` (default) and `AzureBlobStorage` (selected by env var). Refactor every `fs.readFileSync` call site to go through the adapter.

**Pros:**
- Single seam between code and storage backend; easy to reason about
- Swappable backends (could add `S3Storage` or `MemoryStorage` for tests later)
- Test-friendly — mock the interface, test agent logic without I/O
- Path-vs-blob-key concerns isolated in one place
- Fits standard Node patterns (no "magic" abstraction)

**Cons:**
- Refactor cost: every existing `fs.readFileSync('output/latest/...')` becomes `await storage.readJson('output/latest/...')`
- Every direct call site needs to become `async` — synchronous reads (`readFileSync`) are common in current code
- Path semantics differ subtly (relative vs absolute, slashes, encoding) — adapter must normalize
- Some tools (Playwright, PDF extractor) write temp files via raw `fs` — those don't need the adapter, but the boundary needs to be clear

### Option 2: Mount blob as a filesystem (Azure Container Apps storage volume)

**What it is:** Use Azure Container Apps' Azure Files volume mount to expose the blob storage as a directory inside the container. Code continues to use `fs.readFileSync` etc. — the OS makes blob-backed files appear local.

**Pros:**
- Zero code changes — existing `fs.*` calls work as-is
- True "write once, run anywhere" for the storage layer
- No async refactor

**Cons:**
- Azure Files (SMB / NFS) is **not** the same as Azure Blob Storage — different access model, no SAS, different billing, different RBAC
  - Would have to provision an Azure Files share, not a blob container
  - PM's `rates-pack` consumption flow doesn't work with a file share (PM expects blob)
  - So we'd end up with a file share for agent state + blob container for PM access — two storage models, separate
- File share I/O is slower than direct blob SDK calls for small files
- File mount semantics on container restart can be tricky (lock files, partial writes)
- Solves the wrong problem — the issue isn't "we need a filesystem in the cloud," it's "we need blob storage that the code can read"

### Option 3: Feature-flag the existing fs calls (no abstraction)

**What it is:** Add an `if (process.env.BIRD_STORAGE === 'azure') { /* blob SDK */ } else { /* fs */ }` block at every storage call site. No interface, no class.

**Pros:**
- Conceptually simple, no new abstraction
- Easy to understand in isolation per call site

**Cons:**
- ~30 if/else blocks scattered across the codebase
- Drift between branches — Azure path forgets to handle a case the fs path handles, or vice versa
- Untestable as a unit — to test "does Azure path work," you have to invoke it through the parent code path
- Maintenance nightmare in a year
- Violates DRY in the worst way

### Option 4: Two parallel codebases / branches

**What it is:** Maintain a `local` branch with `fs` calls and a `cloud` branch with blob SDK calls. Cherry-pick or merge between them.

**Pros:**
- No abstraction overhead in either branch

**Cons:**
- Branch divergence is guaranteed and cumulative
- Every feature change requires double work
- Breaks the "local dev must stay functional" requirement at a planning level (you'd be developing on the `local` branch but running `cloud` in production — the two will diverge)
- Disqualified by basic software engineering hygiene

### Option 5: Defer cloud storage entirely; agent runs locally and pushes to blob

**What it is:** Agent always uses local fs. After each run, a separate process uploads the changed files to blob storage. The cloud-deployed agent runs in a container with an ephemeral filesystem; on completion, the upload step copies state out before the container exits.

**Pros:**
- Zero changes to agent storage code
- Cloud deployment is "agent + sync sidecar" rather than "agent that knows about blob"

**Cons:**
- State must be re-downloaded at the start of every cloud run (or assumed to be ephemeral / reconstructed)
- For an agent that reads `bank-domains.json` and incrementally updates it, the download-modify-upload cycle introduces real latency and complicates concurrency
- Two sync points (start of run + end of run) are two places to fail
- Pushes the abstraction problem one layer out without eliminating it
- Doesn't actually save complexity, just moves it

## Tradeoffs

| Axis | Adapter | File mount | Feature flag | Branches | Sync sidecar |
|---|---|---|---|---|---|
| Code changes required | Medium | None | Heavy (scattered) | None | Light |
| Local dev unchanged | Yes | N/A (irrelevant) | Yes | Yes | Yes |
| Maintainability | Good | Good | Poor | Disastrous | OK |
| Testability | Excellent | Poor (needs mount) | Poor | N/A | OK |
| Storage model fits Azure-native | Yes | Awkward (Files not Blob) | Yes | Yes | Yes |
| Cost of getting it wrong | Refactor | Re-architect | Per-site fix | Catastrophic | Re-architect |

## Recommendation

**Option 1: Adapter pattern.**

Reasoning: It's the only option that simultaneously (a) keeps local dev with `fs` semantics, (b) uses Azure Blob (not Azure Files) which fits the PM consumption flow, (c) is testable in isolation, and (d) doesn't drift over time. The refactor cost is real but bounded — ~30 call sites, with a clear pattern for each. The async-ification is a one-time cost that improves the codebase regardless of cloud deployment.

File mount is a clever-but-wrong answer: Azure Files isn't Azure Blob, and we'd end up with two storage backends. Feature flag is a maintenance debt accelerator. Branches are obviously bad. The sync-sidecar pattern adds complexity to avoid a refactor that's worth doing on its own merits.

## Proposed interface (subject to refinement during sprint 001 design phase)

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

Keys are forward-slash-separated strings. `LocalFsStorage` resolves them relative to the repo root. `AzureBlobStorage` uses them as blob names within a configured container.

The interface is intentionally minimal. We will add methods (e.g., `copy`, `streamRead`) only when a real call site needs them.

## Consequences

If the adapter pattern is chosen:
- New file `lib/storage.js` with the interface and two implementations
- Selected via `BIRD_STORAGE` env var: `local` (default) or `azure`
- Azure mode requires `AZURE_STORAGE_ACCOUNT_NAME` and authentication via `DefaultAzureCredential` (works with managed identity in Azure, dev's `az login` locally)
- All `fs.readFileSync('output/latest/...')` etc. calls in agent code refactored to `await storage.readJson(...)` — touches multiple files
- Tests use `LocalFsStorage` against a `tmp` directory by default; `AzureBlobStorage` tests run against Azurite (see ADR-009)
- Tools that write transient files (Playwright PDFs, intermediate caches) can keep using raw `fs` — the boundary is "agent state and pack data go through Storage; ephemeral working files don't"

Lock-in: medium. Moving away from the adapter (e.g., to a different storage system) means changing the interface, but the call-site pattern is uniform — refactoring is mechanical.

## Open questions (deferred to sprint 001 design phase)

These are interface-design details to be resolved in `sprints/sprint-001-azure-foundation/design/storage-adapter.md`. None changes the architectural choice of an adapter pattern.

1. Should the adapter handle binary blobs (PDFs, images) as well as JSON/text, or keep those out of scope?
2. Should `list` return full keys or just the segment after the prefix?
3. Should there be a `streamRead` / `streamWrite` for large files?
4. Path normalization rules — case-sensitivity (Azure Blob is case-sensitive; Windows fs is not), encoding of special characters in keys.

## Decision log

- **2026-05-04** — Status: PROPOSED → DECIDED. Chosen option: **Option 1 (adapter pattern)**.
  - File-mount option (Option 2) ruled out: Azure Files is not Azure Blob, and PM's pack consumption flow requires Blob — using a file mount for agent state would force two storage models.
  - Feature-flag option (Option 3) ruled out: ~30 scattered if/else blocks would drift over time and are individually untestable.
  - Branches and sync-sidecar options ruled out as either operationally untenable or as displacement rather than solution.
  - Refactor cost (~30 call sites becoming async) accepted as a one-time investment that improves the codebase regardless of cloud deployment.
  - Interface details deferred to sprint 001 design phase.

- **2026-05-05** — **Implementation revision (decision unchanged):** the adapter pattern is implemented on top of [`unstorage`](https://unstorage.unjs.io/) rather than hand-rolled.
  - Original ADR drafting did not consider third-party storage abstraction libraries — that was a gap. The adapter pattern is a generic problem with mature solutions; building it from scratch was disproportionate to the value.
  - **`unstorage`** evaluated against `flydrive` and direct `@azure/storage-blob` + custom wrapper. Chosen for: built-in drivers we need (`fs`, `azure-storage-blob`, `memory`), MIT license, active maintenance by UnJS team (production use in Nitro/Nuxt), TypeScript first, ~50KB footprint. `flydrive` was the runner-up but unstorage's broader driver ecosystem and key-value model fit the blob semantics better than flydrive's file-storage model.
  - **License confirmation:** unstorage MIT (Copyright Pooya Parsa); peer dep `@azure/storage-blob` MIT (Microsoft). No GPL / AGPL / copyleft exposure.
  - **Wrapper retained (~80 lines):** thin layer over `unstorage` for our typed error hierarchy (`StorageNotFoundError` etc.), key validation rules (lowercase, no `?#\\`, etc.), and convenience methods (`readJson`/`writeJson` instead of `getItem` + `JSON.parse` at every call site). Wrapper isolates us from any future unstorage API churn.
  - **Net effect:** ~400 fewer lines of code to write and own; one ~50KB dependency added; no change to the architectural decision (adapter pattern, three implementations, env-based selection) or to the refactor scope (~30 call sites still touched).
  - Implementation details captured in `sprints/sprint-001-azure-foundation/design/storage-adapter.md`.
