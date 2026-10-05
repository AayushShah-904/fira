# Testing

**Read [overview.md](overview.md) first** if you haven't — this page assumes you know the pipeline shape (per-bank discovery → `output/latest/` → pack build → quality gate → publish). The authoritative, deeper source for test philosophy is **[sdlc/test-strategy.md](../../sdlc/test-strategy.md)**; this page is the onboarding lens on top of it — read that doc for the full layered rationale (including what's explicitly *out of scope*, e.g. real-Claude-API e2e tests, load tests, chaos tests).

## Framing

Tests run on **Node's built-in test runner** (`node --test`) — no Jest, Mocha, or Vitest. This was a deliberate choice ([ADR-008](../../sdlc/decisions/ADR-008-test-runner.md)): the codebase is plain CommonJS, the test scope is bounded (parsers, validators, one mocked-LLM integration path, a few golden/snapshot suites), and a third-party framework would add dependency weight for features this project doesn't need. `node:test` is zero-dependency, uses the exact same engine as production, and is fast.

**Local-dev parity is non-negotiable.** Everything that runs in CI/cloud must also run on a developer laptop with a plain `npm test` — no Azure subscription required. Azure-specific storage tests (Azurite-backed) are *gated to skip cleanly*, not fail, when the emulator isn't running (see [ADR-009](../../sdlc/decisions/ADR-009-local-blob-emulation.md)).

## How to run

| Command | What it does |
|---|---|
| `npm test` | Full suite: runs `pretest` (write-discipline guard, see below) then `node --test --test-force-exit` over all of `tests/`. |
| `npm run test:golden` | Just the extractor golden suite (`node --test tests/extractors/golden.test.js`) — fast feedback loop when iterating on an extractor. |
| `npm run check:writes` | Runs only the write-discipline guard (`scripts/check-write-discipline.js`), standalone — same thing `pretest` runs before every `npm test`. |
| `node --test tests/<path>` | Run one file or one subfolder directly, e.g. `node --test tests/lib/rate-bounds.test.js` or `node --test tests/extractors/`. |

Notes:
- `--test-force-exit` is set on the `test` script because some suites (Azurite client, child-process spawns in `tests/iac/`) can leave the event loop non-empty; force-exit avoids a hang after the last assertion runs.
- There's no separate `test:integration` or `test:regression` npm script today, despite `sdlc/test-strategy.md` describing that layered model — those test kinds live as ordinary files under `tests/` and run as part of the one `npm test` pass (see Gaps below).
- Coverage isn't wired into a script; if you want it, run `node --test --experimental-test-coverage tests/` manually.

## Test layers, mapped to `tests/`

The `tests/` tree mirrors `sdlc/test-strategy.md`'s layered model (unit → integration → regression/golden) plus several **specialized** suites that exist because specific incidents demanded a regression guard. As of this writing there are **119 `*.test.js` files** across these folders:

| Folder | Layer | What it verifies |
|---|---|---|
| `tests/lib/` (68 files — by far the largest) | Unit + some integration | The engine: `lib/actions/*` (fetch, classify, extract via HTML/OCR/vision, commit), `lib/orchestrator.js`, storage adapters (`storage/memory.test.js`, `storage/fs.test.js`, `storage/azure-blob.test.js`), slug/registry logic, rate bounds, cost tracker, failure classifier. Mostly pure-function or fixture-driven; a few (`actions/action-chain.integration.test.js`) chain multiple actions together. |
| `tests/extractors/` | Regression/golden | Bank-family extractors (coop 3-col, generic HTML 3-col, LLM-fallback, currency matrix, Document Intelligence grid). `golden.test.js` is the flagship — see below. `_assert_traceability.test.js` guards the anti-fabrication rule (every output slab must carry `source_row_text`). |
| `tests/golden-html/` | Fixtures (not tests) | `<bank>.expected.json` + `.expected.meta.json` pairs — the golden **expected output** consumed by `tests/extractors/golden.test.js`. Some banks also have a captured `.html` companion (real captured page) or `.expected.extract.json` (frozen LLM-proposed template) for a fuller regression bite. |
| `tests/fixtures/` | Fixtures (not tests) | Hand-built/synthetic input JSON used by specific unit tests (e.g. `rates-qc/*_fcnr_rates.json` for rate-QC checks). |
| `tests/prompts/` | Guard/regression | `fragments-docs.test.js` — asserts every named prompt fragment resolves to a non-empty string sourced from `docs/agent/*.md`, and that a missing/renamed anchor throws a clear error rather than silently emptying the system prompt. This is the test that protects the **prompt single-source-of-truth**: `docs/agent/*.md` is assembled into the live agent prompt by `lib/prompts/fragments.js` + `build-prompt.js`, so a broken anchor here is a silent production regression (the agent runs with missing instructions) unless this guard catches it. |
| `tests/checks/` | Unit | `lib/checks/*` — semantic/structural rate-QC (`structural-checks.test.js`: ladder plausibility, senior-premium outliers, FCNR currency sanity) and `rate-reasonableness.test.js`. Each maps to a real Sprint-007/008 bug class, plus a negative control asserting no false positives. |
| `tests/confidence/` | Unit | `lib/confidence/*` scoring — `extraction_confidence` computation (ADR-016). |
| `tests/audit/` | Unit + fixture | `scripts/audit/cross-check-all.js` helpers (key parsing, slab hashing) and the LLM re-extraction prompt/agreement classifier used for sample correctness audits. |
| `tests/pack/` | Integration | `pack/build-pack.js` — walks a **fixture** `output/latest/`-shaped temp dir and asserts the assembled `rates-pack.json` has the right shape/counts, including variant-scoped assembly. |
| `tests/snapshot/` | Unit | `lib/snapshot/snapshot-store.js` — the source-snapshot substrate (content-addressed HTML/PDF capture). Uses a temp `SNAPSHOT_ROOT` env var so the real `output/snapshots` is never touched. |
| `tests/cloud/` | Unit + guard | `cloud/git-publish.js` kill-switch (`FIRA_DISABLE_GIT_PUBLISH`) and bootstrap behavior, `cloud/sync.js` upload/stale-marker logic. |
| `tests/functions/` | Unit | Azure Functions HTTP trigger (`functions/start-discovery`) — request validation, argv building, dispatch, independent of a running Functions host. |
| `tests/iac/` | Regression/guard | `iac/build-functions-zip.py` — pins the POSIX-forward-slash zip-entry contract; a real historical bug (`Compress-Archive` on Windows emitted backslash entries, causing 0 registered Functions in prod) is now a pinned regression test. |
| `tests/scripts/` (21 files) | Unit + integration | The `scripts/` toolbox: `check-write-discipline.test.js` (tests the guard itself), cohort loading, batch-run cohort logic, PDF rate-line parsing, column detection, comparison scripts. |
| `tests/bin/` | Unit | `bin/approve-accept.js` — the signed-accept CLI (agent-immune quality-gate override path). |
| `tests/_helpers/` | Shared helpers (not tests) | `azurite.js` (checks Azurite reachability, skips cleanly if absent — ADR-009), `storage-conformance.js` (shared contract tests run against every `Storage` implementation), `mock_session.js` (Playwright session mock). |

### The golden extractor suite in detail (`tests/extractors/golden.test.js`)

Two families in one file:
1. **Live golden tests** — for each `tests/golden-html/<bank>.expected.json`, if a matching `<bank>.html` companion exists, run it through the real extractor dispatcher (`lib/extractors/dispatch.js`) and assert slab count (±2 tolerance) and key rates (1y/2y/3y/5y, ±5bps) match the expected fixture. Missing `.html` companions **skip** (not fail) with a diagnostic — this is intentional; companions are backfilled incrementally.
2. **Synthetic round-trip tests** — for a hand-picked set of banks, take their *real* `output/latest/<bank>_rates.json`, synthesize a clean HTML table from each slab's `source_row_text`, run the extractor against that synthetic HTML, and assert it reconstructs the same slabs. This proves the extractor logic works end-to-end using production-derived data without waiting on more `.html` capture.

## Fixtures & golden HTML — the critical rule

**Tests must never read or write `output/latest/`.** That directory holds real scraped bank data — the working state of the whole pipeline — and is explicitly called out in the codebase (`docs/about/overview.md` §3: *"REAL scraped data — the working state. NEVER let tests touch it."*) and in project memory (`feedback_preserve_scraped_artifacts`). Every test that needs bank-shaped data either:
- reads from **checked-in fixtures** (`tests/fixtures/`, `tests/golden-html/`), or
- creates its own **temp directory** (`fs.mkdtempSync(path.join(os.tmpdir(), '<prefix>-'))`) and cleans it up in `test.after()` — see `tests/pack/build-pack.test.js` and `tests/snapshot/snapshot-store.test.js` for the pattern, or
- points at a `tmp/baseline-pre-reset/output-latest/` snapshot (a frozen historical copy used only for read-only synthetic round-trip fixtures in `golden.test.js` — not the live directory).

If you're writing a new test and find yourself tempted to point at `output/latest/` directly — don't. Copy the shape you need into a fixture or a temp dir instead.

## The write-discipline pretest guard

`pretest` (and `npm run check:writes`) runs `scripts/check-write-discipline.js` **before** the test suite. It scans `lib/`, `scripts/`, `cloud/`, `pack/`, `iac/`, plus the top-level runners (`run-discovery.js`, `run-pipeline.js`, `run-batch.js`), and fails the build if it finds a bare `fs.writeFileSync` / `fs.copyFileSync` call outside the canonical writer `lib/safe-write.js` that doesn't carry a `// safe-write-exempt: <reason>` comment.

This enforces **ADR-012's safe-write discipline**: all production writes should route through `lib/safe-write.js`, which implements the non-destructive rules described in [overview.md §5](overview.md#5-concepts-you-must-internalise-before-touching-code) and in more depth in **[quality-checks.md](quality-checks.md)** (never clobber curated files, never overwrite non-empty with empty, reject garbage, divert under-sized fresh extractions to `.pending.json`). `tests/` itself is excluded from the scan (test fixtures legitimately call `fs.writeFileSync` directly against temp dirs), and `tests/scripts/check-write-discipline.test.js` tests the guard's own logic.

If `npm test` fails at the `pretest` step, the fix is one of: (a) migrate the offending write to go through `lib/safe-write.js`, or (b) if the write is genuinely out of scope (logs, traces, non-rate-data output), add the exempt comment — never silently bypass it.

## Gaps & pragmatics — be honest with yourself here

- **The project historically ran on manual smoke testing** — `node run-discovery.js "<bank>"` against a known bank, eyeballing the output (`sdlc/test-strategy.md` §"Layer 4"). That habit predates most of the automated suite and is still the fallback for anything the automated layers don't cover (post-deploy checks, pre-release sanity, quarterly full-cohort comparisons). Manual smoke results, when logged, live under `sdlc/sprints/sprint-NNN/test/`.
- **Strong coverage:** pure parsers/validators (`lib/rate-bounds.js`, `lib/checks/structural-checks.js`), the extractor dispatch + golden-fixture regression path, storage adapters, the write-discipline guard itself, and several "this exact incident must never recur" pins (the IaC zip forward-slash bug, the git-publish kill switch).
- **Thinner coverage:** true end-to-end integration (the `sdlc/test-strategy.md` "Layer 2" vision of a fully mocked-LLM single-bank run through `run-discovery.js` with recorded fixture HTTP + Claude transcript replay) doesn't fully exist as described — most integration-shaped tests operate one level down, against `lib/orchestrator.js` or individual `lib/actions/*` rather than the full CLI entry point. There's also no dedicated `npm run test:integration` or `test:regression` script matching the strategy doc's naming — those layers are folded into the one `npm test` pass.
- **Azurite-gated tests** exist (`tests/lib/storage/azure-blob.test.js`, `tests/_helpers/azurite.js`) but require a locally running Azurite instance to actually exercise; without it they skip rather than fail, so it's easy to go a long time never running that code path locally. If you're touching `AzureBlobStorage`, start Azurite (`docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite`) and confirm those tests actually ran, not skipped.
- **Golden-HTML coverage is partial by design:** many `tests/golden-html/*.expected.json` fixtures have no `.html` companion yet, so their live-golden test silently skips. `golden.test.js`'s own summary test only asserts the fixture *count* (≥50), not that all of them execute — read the console output, not just the pass/fail, to know how much is really being exercised.

## Pointers

| Doc | For |
|---|---|
| **[sdlc/test-strategy.md](../../sdlc/test-strategy.md)** | The authoritative, deeper test-strategy doc — full layer rationale, coverage targets, explicit out-of-scope list |
| **[ADR-008: Test runner](../../sdlc/decisions/ADR-008-test-runner.md)** | Why `node --test` over Vitest/Jest/Mocha/Tap |
| **[ADR-009: Local blob emulation](../../sdlc/decisions/ADR-009-local-blob-emulation.md)** | Why Azurite (gated) + `MemoryStorage`, and how the skip-not-fail policy works |
| **[quality-checks.md](quality-checks.md)** | Safe-write rules (ADR-012), the quality gate, confidence scoring — the *production* rules this page's pretest guard enforces |
| **[extraction.md](extraction.md)** | The extractors under test in `tests/extractors/` and `tests/golden-html/` |
| **[overview.md](overview.md)** | Whole-system map; §3 names `output/latest/` as data tests must never touch |
