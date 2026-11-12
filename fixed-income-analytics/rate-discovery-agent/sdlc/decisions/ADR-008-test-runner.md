# ADR-008: Test runner

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — `node --test` (Node's built-in test runner) |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-05 |
| Sprint | 001 |
| Supersedes | — |

## Context

The agent currently has no automated tests. `package.json` has a placeholder `"test": "echo \"Error: no test specified\" && exit 1"`. As part of sprint 001, we are introducing unit, integration, and regression tests (per `sdlc/test-strategy.md`). We need to choose a test runner.

Constraints:
- Existing codebase is plain CommonJS Node (no transpilation step in production)
- Some files use ES module syntax (`extract_rates_pdf.mjs`)
- Tests must run in both local dev and the production container (per ADR-004)
- Speed matters — unit suite should run in seconds, not minutes
- Should be easy to run a single test file or a single test
- Coverage reporting is desirable but not gate-blocking

## Options considered

### Option 1: Node's built-in test runner (`node --test`)

**What it is:** Node 20+ ships with `node:test` — a TAP-format test runner built into the Node binary. No npm dependency required.

**Pros:**
- **Zero dependencies** — no `node_modules` bloat, no version conflicts
- Built into Node — uses the same JS engine and module resolver as production
- Supports both CommonJS and ES modules natively
- Built-in coverage (`--experimental-test-coverage` since Node 20, stable in Node 22)
- Watch mode (`--watch`)
- Concurrent execution (`--test-concurrency`)
- Test-name filter (`--test-name-pattern`)
- Standard `assert` and `node:test` API — boring and stable
- Fast startup (no large framework to load)

**Cons:**
- Less mature ecosystem than vitest/jest — fewer third-party plugins
- Snapshot testing requires a third-party assertion library (built-in doesn't include it)
- Mocking story is bare — uses `mock` from `node:test` but more limited than jest's mock system
- TAP output is functional but less pretty than vitest's reporter (third-party reporters available)
- Documentation less abundant than vitest/jest

### Option 2: Vitest

**What it is:** Modern test runner from the Vite ecosystem. Designed for speed, ES modules, and ergonomics.

**Pros:**
- Excellent developer experience — fast watch mode, pretty output
- First-class ES module support
- Built-in mocking (`vi.fn`, `vi.mock`)
- Built-in snapshot testing
- Compatible with most jest test syntax
- Active development, growing ecosystem

**Cons:**
- Adds Vitest + esbuild + dependencies (~50–100 packages)
- Designed primarily for Vite-based frontend projects; using it for plain Node is fine but feels off-spec
- Configuration file required (`vitest.config.js`)
- Behavior can differ from production Node (esbuild transpilation, custom resolution)

### Option 3: Jest

**What it is:** The historically dominant Node test framework, originally from Facebook.

**Pros:**
- Largest ecosystem, most documentation, most Stack Overflow answers
- Rich mocking, snapshot, watch features
- "Just works" out of the box for most projects

**Cons:**
- Heavy — adds ~200 packages, slow to install
- Was slow with ES modules historically (improved but still not great)
- Custom transformer / module resolution adds complexity
- Maintenance has slowed since Meta de-prioritized it
- Slower test execution than vitest or node:test
- Larger runtime footprint matters slightly for container image size

### Option 4: Mocha (+ Chai + Sinon)

**What it is:** The "BYO assertion / mocking library" classic Node test runner.

**Pros:**
- Highly flexible — pick your assertion library, mocking library, etc.
- Mature, stable
- Fast
- Light dependency footprint

**Cons:**
- Three packages to assemble (mocha + chai + sinon) instead of one batteries-included framework
- More configuration / setup than alternatives
- Ecosystem momentum has shifted to vitest/jest/node:test

### Option 5: Tap (node-tap)

**What it is:** TAP-protocol-native test framework with built-in coverage and snapshot.

**Pros:**
- Designed around TAP (which is also what `node --test` produces)
- Strong coverage reporting
- Used by npm itself

**Cons:**
- Smaller community than vitest/jest
- Less broadly known — onboarding cost for new contributors

## Tradeoffs

| Axis | node:test | Vitest | Jest | Mocha+Chai | Tap |
|---|---|---|---|---|---|
| Setup cost | None | Low | Medium | Medium | Low |
| Dependency weight | Zero | Medium | Heavy | Light | Light |
| Speed | Fast | Very fast | Slow | Fast | Fast |
| ES module support | Native | Excellent | Good (improved) | Good | Good |
| Mocking | Basic | Excellent | Excellent | Via Sinon | Good |
| Snapshot | Via 3rd party | Native | Native | Via 3rd party | Native |
| Coverage | Native | Native | Native | Via nyc | Native |
| Ecosystem | Small (growing) | Large | Largest | Mature | Small |
| Maturity | New (since Node 20) | Mature | Very mature | Very mature | Mature |
| Production parity | Perfect (same engine) | Slight transpilation | Some transformers | Perfect | Perfect |
| "Boringness" | High | Medium | Medium | High | Medium |

## Recommendation

**Option 1: `node --test` (Node's built-in test runner).**

Reasoning: The agent codebase is small, the test scope is bounded (parsers, validators, one mocked-LLM integration test, snapshot regression), and we don't need exotic features. Adding a third-party framework introduces a dependency to maintain, version-pin, and debug — for benefits we wouldn't actually use.

The only feature we'll likely miss is built-in snapshot testing for the regression suite (ADR mention in `test-strategy.md`). Workaround: write a tiny snapshot helper (~30 lines) that does `JSON.stringify(actual, null, 2)` and compares to a checked-in `.snap.json` file. If this gets unwieldy, we can adopt a snapshot library or switch to vitest later — the test source code is portable across runners with minor adjustment.

Vitest is the strong runner-up. If the test suite grows complex enough that the ergonomics of node:test become limiting (e.g., we need parameterized tests, sophisticated mocking, custom reporters), revisit and switch. The migration cost is small (~1 day).

Jest, Mocha+Chai+Sinon, and Tap are all reasonable but don't win on any axis we care about given the alternatives.

## Consequences

If chosen:
- `package.json` `"test"` script becomes `"node --test --test-concurrency=1 tests/"`
- Tests live under `tests/` (mirroring the source layout: `tests/lib/storage.test.js`, `tests/scripts/utils/parse-tenure.test.js`, etc.)
- Coverage reporting via `node --test --experimental-test-coverage` (Node 20) or stable in Node 22
- Snapshot regression: small helper in `tests/_helpers/snapshot.js`
- No additional dependencies in `package.json` `devDependencies`
- CI runs `npm test` plus a separate Azurite-gated integration pass (per ADR-009 if accepted)

Lock-in: very low. Test code using `node:test` is mostly portable to vitest with minor syntactic changes (`describe`/`it` are similar; the `assert` calls would migrate to `expect()`).

## Open questions (deferred to sprint 001 design phase)

These are minor preferences that don't change the choice; resolved when first tests are written.

1. Node 20+ requirement for development — likely fine since production container will use Node 20 anyway.
2. `npm test` default — watch mode or one-shot.
3. Snapshot format — plain JSON compare via small helper, or adopt a snapshot library.

## Decision log

- **2026-05-05** — Status: PROPOSED → DECIDED. Chosen option: **Option 1 (`node --test`)**.
  - Vitest was the strong runner-up but adds 50–100 packages for benefits the small codebase wouldn't actually exercise.
  - Jest ruled out as heavy and slowing in maintenance velocity.
  - Mocha+Chai+Sinon and Tap ruled out — ecosystem momentum has shifted away.
  - Snapshot-testing gap acknowledged: small ~30-line `JSON.stringify` helper covers the regression-suite need. Switch to vitest later if snapshot needs become complex (test source is portable).
  - Minor preferences (Node version requirement, watch mode default, snapshot format) deferred to sprint 001 design / first-tests-written.
