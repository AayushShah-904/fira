# Design — Storage adapter

**Status:** Design approved 2026-05-05; implementation pending
**Implements:** [ADR-004](../../../decisions/ADR-004-storage-abstraction.md), [ADR-009](../../../decisions/ADR-009-local-blob-emulation.md), [ADR-010](../../../decisions/ADR-010-blob-layout.md)
**Touches:** `lib/storage.js` (new — thin wrapper over [unstorage](https://unstorage.unjs.io/)), every storage call site in `run-discovery.js`, `run-batch.js`, `run-pipeline.js`, `pack/build-pack.js`, `scripts/`, helpers in `lib/`
**New runtime dep:** `unstorage` (MIT) + `@azure/storage-blob` (MIT, peer dep, used by `azure-storage-blob` driver)

## Scope

This design pins down the `Storage` interface, its three implementations, error semantics, key conventions, and the refactor surface for sprint 001. The architectural choice (adapter pattern) and backend layout are already decided in the ADRs above; this doc is the implementation-level contract.

The implementation rests on [unstorage](https://unstorage.unjs.io/) — a mature storage abstraction with the drivers we need (`fs`, `azure-storage-blob`, `memory`) all built in. We add a thin (~80 line) wrapper for our typed error hierarchy, key validation, and JSON/text/binary convenience methods. See ADR-004's 2026-05-05 decision-log entry for the library-evaluation reasoning.

## Interface

```ts
interface Storage {
  // JSON / text
  readJson(key: string): Promise<unknown>;
  writeJson(key: string, data: unknown): Promise<void>;
  readText(key: string): Promise<string>;
  writeText(key: string, text: string): Promise<void>;

  // Binary (PDFs, images, anything that should persist as bytes)
  readBinary(key: string): Promise<Buffer>;
  writeBinary(key: string, data: Buffer): Promise<void>;

  // Existence + listing
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;   // returns full keys

  // Delete
  delete(key: string): Promise<void>;
}
```

All methods are async. All take string keys with the same convention regardless of backend. No streaming methods in v1 — added later if a real call site demands it.

### Method semantics

| Method | Returns / behavior | Throws on |
|---|---|---|
| `readJson(key)` | Parsed JSON value | `StorageNotFoundError` if key absent; `StorageParseError` if content is not valid JSON; `StorageNetworkError` / `StorageAuthError` for backend failures |
| `writeJson(key, data)` | Resolves on durable write (atomic) | `StorageAuthError`, `StorageNetworkError` |
| `readText(key)` | UTF-8 string | `StorageNotFoundError`, backend errors |
| `writeText(key, text)` | Resolves on durable write (atomic) | Backend errors |
| `readBinary(key)` | `Buffer` | `StorageNotFoundError`, backend errors |
| `writeBinary(key, data)` | Resolves on durable write (atomic) | Backend errors |
| `exists(key)` | `true` / `false` — never throws on absence | Backend errors only (auth, network) |
| `list(prefix)` | Array of full keys whose names start with `prefix`. Empty array if prefix matches nothing. Order is unspecified. | Backend errors |
| `delete(key)` | Resolves on completion. **No-op (no throw) if key absent** — idempotent. | Backend errors |

"Atomic" means: a partial write never leaves a partial-state file readable by another process. Implementation strategy differs per backend (see implementations below).

## Error model

```ts
class StorageError extends Error {
  constructor(message: string, public readonly key?: string, public readonly cause?: Error) {
    super(message);
    this.name = this.constructor.name;
  }
}

class StorageNotFoundError extends StorageError {}
class StorageAuthError extends StorageError {}
class StorageNetworkError extends StorageError {}
class StorageParseError extends StorageError {}
class StorageKeyError extends StorageError {}    // invalid key (validation failure)
```

Callers catch by type:

```js
try {
  const cfg = await storage.readJson(`output/latest/${slug}_config.json`);
  // ...
} catch (err) {
  if (err instanceof StorageNotFoundError) {
    // handle "no config yet" case
  } else {
    throw err;  // bubble auth/network/parse errors
  }
}
```

`Error.cause` is set on auth / network errors so the original SDK error is preserved for debugging.

## Key conventions

### Format rules

1. **Forward slashes only** — no backslashes (Windows path separators rejected).
2. **No leading slash** — keys are always relative to the container/repo root.
3. **Lowercase** — all keys lowercased; if a caller passes `Output/Latest/...`, the adapter throws `StorageKeyError` (uppercase is a programming bug worth surfacing loudly).
4. **No `?`, `#`, `\`, control chars** — these have special meaning in URLs / filesystems. Adapter throws `StorageKeyError`.
5. **No empty segments** — `output//latest/` is invalid (double slash).
6. **No trailing slash** — `output/latest/` is invalid as a key (it's a prefix, not a key). Use `list("output/latest/")` for prefix queries.

### Validation point

A single `validateKey(key: string): void` helper runs at the top of every method on every adapter implementation. Cheap (regex), and centralizes the rules.

### Examples

| Input | Outcome |
|---|---|
| `output/latest/hdfc-bank-limited_rates.json` | Valid |
| `data/bank-domains.json` | Valid |
| `cache/pdfs/icici-bank-limited/abc123def456.pdf` | Valid |
| `Output/Latest/file.json` | `StorageKeyError` (uppercase) |
| `/output/latest/file.json` | `StorageKeyError` (leading slash) |
| `output/latest/file?v=2.json` | `StorageKeyError` (`?`) |
| `output//latest/file.json` | `StorageKeyError` (empty segment) |
| `output/latest/` | `StorageKeyError` (trailing slash) — use `list()` |

## Implementations — three unstorage drivers behind one wrapper

Our `lib/storage.js` exports a single `Storage` class plus a `createStorage()` factory. Internally it constructs an unstorage instance configured with one of three drivers; the wrapper translates between our typed API (`readJson`/`writeJson`/etc.) and unstorage's untyped key-value API (`getItem`/`setItem`/etc.).

```js
// lib/storage.js (sketch)
const { createStorage: createUnstorage } = require('unstorage');
const fsDriver = require('unstorage/drivers/fs').default;
const azureBlobDriver = require('unstorage/drivers/azure-storage-blob').default;
const memoryDriver = require('unstorage/drivers/memory').default;

class Storage {
  constructor(driver) {
    this._unstorage = createUnstorage({ driver });
  }

  async readJson(key) {
    validateKey(key);
    const raw = await this._unstorage.getItem(toUnstorageKey(key));
    if (raw == null) throw new StorageNotFoundError(key);
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { throw new StorageParseError(key, { cause: e }); }
  }
  // ... readText, writeJson, writeText, readBinary, writeBinary, exists, list, delete
}
```

### Mode 1: `local` (default — local development)

Driver: `unstorage/drivers/fs` configured with `base: <repo-root>`.

Construction:
```js
const storage = new Storage(fsDriver({ base: path.resolve(__dirname, '..') }));
```

**Atomicity:** the `fs` driver writes via temp-file-then-rename internally — the partial-state concern from the original design is already handled by unstorage. We do not need to layer our own atomicity logic.

**Listing:** `getKeys(prefix)` recursively walks the prefix subtree.

**Concurrent runs:** last-writer-wins per ADR-010. The atomic-rename gives "no partial state" but does not give "no overwrite" — if two writers both finish, one wins.

### Mode 2: `azure` (production + Azurite tests)

Driver: `unstorage/drivers/azure-storage-blob`.

Construction:
```js
// Production (DefaultAzureCredential — managed identity in Container App, az login locally)
const storage = new Storage(azureBlobDriver({
  accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME,
  containerName: process.env.AZURE_STORAGE_CONTAINER_NAME,
}));

// Azurite (connection string)
const storage = new Storage(azureBlobDriver({
  accountName: 'devstoreaccount1',
  containerName: 'agent-state',
  connectionString: AZURITE_DEV_CONNECTION_STRING,
}));
```

The `azure-storage-blob` driver internally uses `@azure/storage-blob` and supports both auth paths (DefaultAzureCredential when no connection string, shared-key from connection string otherwise).

**Atomicity:** native to Azure Blob — single-blob upload is atomic.

**Listing:** driver wraps `listBlobsFlat`.

**Container creation:** the driver does **not** create the container — Bicep provisions `agent-state` and `rates-pack` per ADR-010. App fails fast on missing container, which surfaces Bicep bugs immediately rather than auto-healing.

**Error mapping:** unstorage normalizes some Azure SDK errors to its own throws; our wrapper maps them further to our typed hierarchy:
- 404 / `getItem` returns `null` → `StorageNotFoundError` (when method semantics demand)
- 401/403 from underlying SDK → `StorageAuthError`
- Network failures → `StorageNetworkError`
- JSON parse failure in our wrapper → `StorageParseError`

The wrapper preserves the original error via `Error.cause`.

### Mode 3: `memory` (unit tests where backend is incidental)

Driver: `unstorage/drivers/memory`.

```js
const storage = new Storage(memoryDriver());
```

Backed by an in-process map. Atomicity trivial. Used in unit tests that need *some* `Storage` instance but don't care which (e.g., rate-pack assembler tests against fixture inputs).

### Key translation (forward slashes ↔ unstorage internal)

unstorage's internal key separator is `:` by historical convention; the `fs` driver maps `:` → `/` for paths but its key format is colon-internal. To keep our public API consistent (forward slashes everywhere — see "Key conventions" below), the wrapper translates at the boundary:

```js
function toUnstorageKey(key) { return key.replace(/\//g, ':'); }
function fromUnstorageKey(key) { return key.replace(/:/g, '/'); }
```

`getKeys` results are translated back before returning to callers.

This is encapsulated in the wrapper — no caller ever sees colons.

## Configuration / instantiation

The adapter is constructed at the top-level entry point of each entry script (`run-discovery.js`, `run-batch.js`, `run-pipeline.js`, `pack/publish.js`). A small factory in `lib/storage.js` reads `process.env.BIRD_STORAGE` and constructs the right implementation:

```js
function createStorage() {
  const mode = process.env.BIRD_STORAGE || 'local';
  if (mode === 'local') {
    return new Storage(fsDriver({ base: path.resolve(__dirname, '..') }));
  }
  if (mode === 'azure') {
    return new Storage(azureBlobDriver({
      accountName: requireEnv('AZURE_STORAGE_ACCOUNT_NAME'),
      containerName: requireEnv('AZURE_STORAGE_CONTAINER_NAME'),  // typically "agent-state"
    }));
  }
  throw new Error(`Unknown BIRD_STORAGE mode: ${mode}`);
}
```

`pack/publish.js` constructs its own `Storage` instance pointed at the `rates-pack` container (different container, otherwise same driver).

Tests construct `Storage` instances directly with the driver of their choice — they don't go through the env-based factory.

## Binary storage layout and lifecycle

Binary content (PDF rate cards, occasional rate-table images) lives alongside other per-bank data under `output/latest/` — same convention as `_config.json` / `_rates.json`. No separate `cache/` folder.

**Naming:** `output/latest/<bank-slug>_source_<source-hash>.<ext>`

Where `<source-hash>` is the first 16 hex chars of the SHA-256 of the source URL. For banks with multiple variant PDFs (FCNR / NRE separate from main FD), use a variant infix: `<bank-slug>_source_<variant>_<source-hash>.pdf`.

Examples:
```
output/latest/icici-bank-limited_source_a1b2c3d4e5f60718.pdf
output/latest/axis-bank-limited_source_fcnr_9f8e7d6c5b4a3210.pdf
```

**Why hash in the name:**
- Source URL is the natural identity but contains characters that violate our key conventions (`?`, `#`, `:`, `/`)
- Hash gives stable, validation-clean naming
- Re-fetching the same URL produces the same hash, enabling the deferred cache-hit-skip optimization (sprint 002): "does this hash already exist?" → skip download. Without the hash, that check degrades to "does any source PDF exist for this bank?" which produces false hits when banks publish a fresh PDF at a new URL (date-stamped URLs are common).
- Multiple PDFs per bank can coexist (different URLs → different hashes) without overwriting each other

**Lifecycle:** Azure Blob lifecycle policy on the storage account auto-deletes binary files under `output/latest/` matching `*_source_*.pdf` / `*_source_*.png` / etc. older than 3 years (1095 days). The same TTL applies to per-run audit data under `runs/` (see `bicep-modules.md`'s storage module). Cost impact at our volume is ~$25/year — well worth the audit headroom. Tightening or extending is a one-line `runsRetentionDays` parameter change in `parameters.prod.bicepparam`. Note: lifecycle policies match by name pattern, not file type — the `_source_` infix is the marker the policy uses to distinguish binary cache from durable JSON outputs.

**Local-mode behavior:** files written to `<repo>/output/latest/` per the same naming. No automatic lifecycle locally — operator cleans up if needed.

**Cache-hit-skip optimization** (deferred to sprint 002): the agent computes the hash before fetching, checks `storage.exists()`, and if present skips the network fetch — using the cached PDF directly. Sprint 001 always fetches; cache is just for re-inspection / debugging.

## Refactor scope

Estimated ~30 storage call sites across the codebase. Inventory (to be confirmed at implementation time by `grep -rn 'fs\.\(read\|write\|exists\)'`):

| File | Approximate touches | Notes |
|---|---|---|
| `run-discovery.js` | ~5 | Reads bank-domains.json; writes config + rates files |
| `run-batch.js` | ~3 | Reads bank list; writes per-run summary |
| `run-pipeline.js` | ~3 | Similar to run-batch |
| `lib/domain-cache.js` | ~3 | Reads/writes bank-domains.json with merge logic |
| `lib/azure-openai-responses.js` | 0 | No storage calls |
| `lib/tools.js` | ~2 | `fetch_pdf` writes downloaded PDF (will switch to `writeBinary`) |
| `pack/build-pack.js` | ~5 | Reads many `output/latest/*.json`; writes pack files |
| `scripts/analyze-gaps.js` | ~3 | Reads bank-domains, writes gap lists |
| `scripts/extract_rates_pdf.mjs` | ~2 | Reads input PDF (will use `readBinary`); writes JSON output |
| `scripts/run-domain-discovery.js` | ~2 | Reads CSV; writes bank-domains updates |
| `scripts/fetch_rates_playwright.js` | ~1 | Writes output JSON |

**Refactor strategy:**
1. Land `lib/storage.js` with the wrapper + `fs` and `memory` driver wiring first; tests against both.
2. Refactor one entry script + its dependencies through to its leaves; verify locally; commit.
3. Repeat per entry script. Each commit keeps the agent fully working.
4. Add `azure-storage-blob` driver path + Azurite-gated tests once local-mode refactor is fully green.
5. Smoke-test in container with `BIRD_STORAGE=azure` against real Azure last.

## Testing approach

Per [test-strategy.md](../../../test-strategy.md) and [ADR-009](../../../decisions/ADR-009-local-blob-emulation.md):

**Unit tests** — for each driver, exhaustive method-by-method coverage of the wrapper API:
- `tests/lib/storage/fs.test.js` — wrapper + `fs` driver against a `tmp` directory created per test
- `tests/lib/storage/memory.test.js` — wrapper + `memory` driver, fresh per test
- `tests/lib/storage/azure-blob.test.js` — wrapper + `azure-storage-blob` driver against Azurite if available, else `t.skip()` cleanly

**Shared test helper** — `tests/_helpers/storage-conformance.js` exports a `runConformanceSuite(makeStorage)` that exercises every interface method against any wrapper instance. The three test files above each invoke it with their respective driver. Eliminates per-driver test drift.

unstorage's own driver tests are not duplicated — we test our wrapper's behavior (key validation, error mapping, JSON parsing), not whether unstorage's `fs` driver correctly persists to disk.

**Test cases to include:**
- Round-trip read/write for JSON, text, binary
- `readJson` of non-existent key → `StorageNotFoundError`
- `readJson` of corrupted content → `StorageParseError`
- `writeJson` then `readJson` returns the same data
- Atomic write — interrupt simulation (kill the write coroutine mid-flight, verify no partial file readable). Skip on Azure (atomic by construction).
- `list` on empty prefix returns `[]`
- `list` returns full keys (not segment-after-prefix)
- `delete` of non-existent key is no-op
- Key validation throws `StorageKeyError` for each forbidden form
- `exists` returns `true`/`false` correctly
- Binary write/read preserves bytes exactly (use a fixture PDF)

## Open implementation questions

These are decided during implementation (not blocking design):

1. **Buffer pool / streaming for large PDFs** — current PDFs are <5MB; if a future bank publishes a 50MB rate book, we may need streaming. Not blocking sprint 001.
2. **Retry policy on `StorageNetworkError`** — does the adapter retry transient failures internally, or push that to the caller? Recommendation: rely on Azure SDK's built-in retry (default: 3 retries with exponential backoff); don't add a second retry layer.
3. **`readJson` strictness** — accept JSON5 / comments? No — strict JSON only. Agent's outputs are always strict JSON.
4. **Logging hooks** — should the adapter emit debug logs (e.g., "writing 12kb to output/latest/foo.json")? Recommendation: minimal — error-level log on auth/network failure only; debug logs go through the agent's existing logger if needed.
5. **Azurite container provisioning in tests** — Bicep does not run for tests. The Azurite-gated test setup needs to provision the container itself before tests start. Approach: `tests/_helpers/azurite.js` calls the Azure SDK directly to ensure the container exists at suite start; the wrapper itself never auto-creates.

## Acceptance criteria

The design is implemented when:

- `lib/storage.js` exports the `Storage` class + `createStorage()` factory + error subclasses
- `unstorage` and (transitively) `@azure/storage-blob` added to `package.json` dependencies
- `tests/lib/storage/*.test.js` runs green for the `fs` and `memory` drivers on a clean clone with no Azure setup
- The same suite runs green for the `azure-storage-blob` driver when Azurite is reachable; skips cleanly when not
- All ~30 identified call sites refactored through the wrapper
- Local-dev smoke (`node run-discovery.js "<bank>"`) produces identical output to pre-refactor (verified by snapshot diff against a checked-in reference)
- `BIRD_STORAGE=azure` smoke against Azurite produces identical output structure
