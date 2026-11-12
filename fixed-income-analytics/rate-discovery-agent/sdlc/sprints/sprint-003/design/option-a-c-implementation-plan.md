# Plan: Option A + C — Playwright-everywhere + Extraction quality

## Context

A 5-bank smoke comparing the orchestrator path against the LLM path showed the orchestrator extracts ~17% of slabs (40 of 227) even though `extract_html_table` already uses Playwright for `html_js` pages. Two distinct root-causes:

1. **Network layer.** Three of four fetching actions (`find_website`, `find_rate_page`, `classify_rate_page`) use plain Node HTTP. Indian bank WAFs reject these but accept real browsers. Symptoms: 403 on HEAD, ECONNRESET on GET (HDFC, AU SFB homepages; BOI-IBU when no cached rate page exists).
2. **Extraction quality.** Even when Playwright runs, the cheerio multi-table picker picks correctly but `extractSlabsFromTable` emits only a fraction of slabs (AU SFB: 2 of 12 per variant; HDFC: 0 of any). The tenure regex misses common abbreviations (`Yr`, `Mo`, `p.a.`) and the default column mapping is too rigid.

A series of piecemeal workarounds (tolerant TLS, `cached_kind` short-circuit, "trust the cache after HEAD fails") have papered over the symptoms but the real fix is structural: route every orchestrator HTTP fetch through one Playwright session per bank, then improve the picker/extractor.

Goal: orchestrator coverage ≥70% of LLM-path slab counts on the 5-bank smoke, and the ~80 lines of workaround code go away. AOAI tokens may be spent inside specific actions where they earn their keep (see "LLM in the orchestrator" below); the cost should stay materially below the LLM-prompt path's whole-bank chat loop (which is ~50k tokens/bank for the full discover-extract sequence).

## LLM in the orchestrator (architecture note)

The orchestrator is NOT defined by "deterministic Node only, no LLM." Individual actions may invoke LLM for narrow, focused sub-tasks where the LLM earns its keep — e.g., `find_website` already uses Azure OpenAI Responses API for web search; `extract_html_table` already has an LLM-fallback path when deterministic returns zero slabs (`lib/actions/extract_html_table.js:202`). The strategic intent is: ONE eventual path (the orchestrator), with LLM used at well-bounded per-action seams. CLAUDE.md and the legacy `runAgent` chat loop retire once orchestrator coverage justifies it.

Implication for Option A+C:
- The Phase 3 session is the right place for LLM-driven HTML interpretation IF deterministic + cheerio still come up short on a specific bank. Not a goal of A+C itself, but not a violation either.
- "LLM fallback" is NOT out of scope; it remains a normal action-level capability. The cost discipline is: only call LLM when the cheaper path fails, and only with focused, JSON-shaped prompts that operate on a fixed body (no exploration loop).

---

## Architecture findings (from Phase 1 explore)

**Landmines:**

- **L1 (critical):** Three action files have independent embedded `httpRequest()` copies. `lib/actions/_http.js` exists but only `find_rate_page` uses it. Must consolidate before adding session routing or we'd build three diverging implementations.
  - `lib/actions/find_website.js` lines 324–360 (with tolerant-TLS support `_http.js` already has)
  - `lib/actions/classify_rate_page.js` lines 196–245
- **L2 (medium):** `lib/actions/extract_html_table.js:203` calls `extractHtmlStatic`/`extractHtmlJs` from `scripts/extract_rates.js`, which does its own bare HTTP for `html_static` and subprocess-spawns `scripts/fetch_rates_playwright.js` for `html_js`. To make the session truly authoritative, either pre-fetch the body and use the existing `hints.cached_body` short-circuit (preferred), or refactor the dispatcher.
- **L3 (medium):** No HTTP-mock infrastructure in action unit tests. Adding a `session` parameter requires a `tests/helpers/mock_session.js` stub.
- **L4 (low):** `extract_pdf_table.js` spawns its own subprocess and uses its own HTTP. Out of scope for Option A — PDFs aren't WAF-blocked in our smoke.

**Existing reuse points:**

- `lib/orchestrator.js` already has a DI pattern (`DEFAULT_ACTIONS` override via `input.actions`). 20 mock-based tests in `tests/lib/orchestrator.test.js` use it. Adding `session` is non-breaking.
- `lib/actions/_http.js` exists with `httpRequest({tolerant})` — the right home for session routing.
- `lib/actions/_cheerio_tables.js` already handles `<table>`, `[role="table"]`, and div-grids with scoring. 15 unit tests in `tests/lib/actions/_cheerio_tables.test.js`.
- `scripts/fetch_rates_playwright.js` already returns `page_html`; needs a library-mode refactor.
- `extract_html_table.js` already supports `hints.cached_body` to skip live fetch — the plumbing target.
- `--path llm|orchestrator` flag in `run-discovery.js` controls the outer choice; Option A applies inside the orchestrator path only.

---

## Extraction quality findings (from Phase 1 diagnosis)

Ranked by impact:

1. **TENURE_RE too narrow** — `lib/actions/_cheerio_tables.js:35` requires `\b(days?|months?|years?|weeks?)\b` with full words. Misses `Yr`, `Yrs`, `Mo`, `Mos`, `Wk`, `p.a.`, and bare `X to Y` ranges. AU SFB's cells say "1 Yr" — invisible to the scorer. Fix: expand regex + add unit fixtures.
2. **`extractSlabsFromTable` over-strict** — `scripts/extract_rates.js:158` requires `slab.tenure_text && slab.rate_general_pct != null`. When a table has senior-rate or super-senior columns but `rate_general_pct` is missing/null in some rows, the whole row is dropped. Fix: accept rows with `tenure_text` + ANY rate field.
3. **Column-mapping default is rigid** — `{0: tenure_text, 1: rate_general_pct, 2: rate_senior_pct}` doesn't fit AU SFB's 4-col layout (tenure / deposit-range / general / senior). Fix: detect column shape from first 2–3 data rows and infer mapping; fall back to default.

---

## Recommended approach: 7 phases

Each phase is one commit, independently shippable, with explicit done-criteria.

### Phase 0 — Snapshot this plan into sprint docs

Goal: persist the architectural review + plan so future contributors (and re-onboarded operators) inherit the reasoning, not just the diffs.

- Copy this plan file (verbatim, including the architecture findings and extraction-quality diagnosis) to `sdlc/sprints/sprint-003/design/option-a-c-implementation-plan.md`.
- Add a one-line entry to `sdlc/sprints/sprint-003/design/` README or index (if one exists) pointing at it.
- Cross-link from `sdlc/sprints/sprint-003/design/two-path-architecture.md` — append a "See also" pointer to the new plan doc.

**Done when:** the file lands on the `azure-openai-agent` branch with a single small commit. No code changes.

### Phase 1 — Consolidate HTTP utility (foundation, no behavior change)

Reuse path: `lib/actions/_http.js` is the consolidation target.

- `lib/actions/find_website.js`: delete the local `httpRequest` (lines 324–360), import from `_http.js`. Confirm tolerant-TLS option is in `_http.js` (it is).
- `lib/actions/classify_rate_page.js`: same swap (lines 196–245).
- Verify `lib/actions/_http.js` exposes redirect handling + partial-body recovery (cross-check against the three embedded copies; port any missing options).

**Done when:** No file declares its own `httpRequest`. All 400 existing tests pass.
**Tests:** Add `tests/lib/actions/_http.test.js` covering tolerant TLS, redirect chain, GET fallback on 403/405.

### Phase 2 — Refactor `fetch_rates_playwright.js` into a library

Split the CLI into:
- `lib/actions/_playwright_session.js` (new, follows the `_underscore` convention used by `_http.js` and `_cheerio_tables.js`). Exports `createSession({ logger })` returning `{ fetch(url, { waitFor, scroll, accordions }), close() }`. `fetch` does `page.goto` + `waitForLoadState('networkidle')` + `page.content()` and returns `{ status, contentType, body }`.
- `scripts/fetch_rates_playwright.js` — slim CLI wrapper consuming the new module. Existing CLI behavior preserved bit-for-bit.

**Done when:** `node scripts/fetch_rates_playwright.js <url>` produces identical output. The `_playwright_session` module is callable from Node without spawning a subprocess.
**Tests:** `tests/lib/actions/_playwright_session.test.js` against a local in-process HTTP server fixture. Gate the suite on env (`SKIP_PLAYWRIGHT_TESTS=1`) for CI.

### Phase 3 — Wire session through orchestrator DI (Option A core)

- `lib/orchestrator.js`: at start of `orchestrate()`, create one session via `_playwright_session.createSession()`. Pass it as `input.session` into every action call (alongside the existing `actions` DI). `finally { await session.close() }` ensures cleanup on any path including errors.
- `lib/actions/_http.js`: extend signature to `httpRequest(url, opts)` where `opts.session?` exists. When `session` is provided, delegate to `session.fetch(url)`; else fall through to today's Node http. Same return shape `{ statusCode, headers, body }`.
- `find_website.js`, `find_rate_page.js`, `classify_rate_page.js`: accept `session` from input and thread it into their `httpRequest` calls.
- `extract_html_table.js`: skip its own fetch when `hints.cached_body` is already present (no change needed — already does this).
- Feature flag `RDA_USE_PLAYWRIGHT_SESSION` (default on; set to `0` to bypass and use Node HTTP) for back-out without revert.

**Session lifecycle decision: per-bank.** One session per `orchestrate()` invocation, closed in `finally`. Justification:
- Per-process leaks memory across long batch runs and risks cookie bleed between banks.
- Per-action wastes ~500ms+ browser startup per call (4 variants × 3 actions = 12 startups per bank).
- Per-bank matches the natural unit of work, lets each bank get a fresh `context.newContext()`, and the orchestrator-level `try/finally` is the right scope for cleanup.

Error handling: `session.fetch` exceptions are caught inside actions; actions fall back to plain Node HTTP for that single call (graceful degradation, logged). `session.close()` failure logs but doesn't mask the run result.

**Done when:** Running orchestrator against SBI, HDFC, AU SFB, Abhyudaya, BOI-IBU shows successful HTTP responses where the prior smoke saw 403/ECONNRESET. Trace logs include `session_fetch=true` per call.
**Tests:** Add a `mock_session` helper. Extend 4 happy-path orchestrator tests to inject it. Add 1 fault-injection test (session.fetch throws → fallback path used).

### Phase 4 — Plumb `hints.cached_body` through the orchestrator

Goal: each rate page is fetched exactly once per orchestrate(), not three times.

- `lib/actions/classify_rate_page.js`: change output schema to include `body_html` (the rendered DOM string from `session.fetch`). For non-HTML kinds (pdf, image), `body_html` is null.
- `lib/orchestrator.js`: when `classify` succeeds, pass `body_html` into `extract_html_table` as `hints.cached_body`. The action already supports this path.
- `lib/actions/extract_html_table.js`: ensure cached-body path stays preferred when `session` AND `hints.cached_body` are both present (don't re-fetch).

**Done when:** Per-bank trace shows exactly one `session.fetch` per (bank, product) pair, not two or three. AOAI cost remains $0.
**Tests:** Update orchestrator happy-path test to assert `extract_html_table` receives non-empty `hints.cached_body` and `session.fetch` is called exactly N times for N products, not 2N.

### Phase 5 — Extraction quality (Option C)

Three fixes from the diagnosis, ranked by impact:

- **5a (highest):** `lib/actions/_cheerio_tables.js` line 35: expand TENURE_RE to include `Yrs?|Mos?|Wks?|Hrs?|p\.?a\.?` and bare ranges `\d+\s*(?:to|-|–)\s*\d+`. Add 4 new fixtures to `tests/lib/actions/_cheerio_tables.test.js` covering each pattern.
- **5b:** `scripts/extract_rates.js` `extractSlabsFromTable()`: loosen the rate-row filter so a row with `tenure_text` + ANY of `rate_general_pct|rate_senior_pct|rate_super_senior_pct` is accepted, not strictly `rate_general_pct`. Add unit fixtures for "senior-only" tables.
- **5c:** New helper in `scripts/extract_rates.js` (or `lib/extract/_column_inference.js`): `inferColumnMapping(rows)` — sample first 3 data rows, detect which columns parse as percentages vs tenure phrases, build a per-table mapping. Use detected mapping in preference to config default; fall back to config if inference is inconclusive.

**Done when:** AU SFB extracts ≥10 slabs per variant (was 2). HDFC extracts ≥1 slab per variant (was 0). Existing tests stay green.
**Tests:** Golden fixtures `tests/fixtures/html/au_sfb_rates.html`, `hdfc_rates.html`. Snapshot tests against `extract_html_table` with each fixture in `tests/lib/actions/extract_html_table.fixtures.test.js`.

### Phase 6 — Smoke benchmark and telemetry

The comparison harness `scripts/analysis/compare-paths.js` already exists. Lightweight additions:

- `lib/orchestrator.js`: emit timing per action into `phase_events` (already records duration; ensure aggregate per-product is captured in summary).
- Update `sdlc/sprints/sprint-003/design/two-path-architecture.md` with the post-A+C metrics table from a fresh 5-bank smoke.

**Done when:** Comparison report shows orchestrator/LLM ratio ≥70% across the 5-bank set. Documented in the architecture note.

---

## Critical files

- `lib/orchestrator.js` — Phase 3, 4 (session DI, body plumbing)
- `lib/actions/_http.js` — Phase 1, 3 (consolidation + session routing)
- `lib/actions/_playwright_session.js` — Phase 2 (NEW)
- `lib/actions/find_website.js` — Phase 1, 3 (drop local httpRequest, accept session)
- `lib/actions/find_rate_page.js` — Phase 3 (accept session)
- `lib/actions/classify_rate_page.js` — Phase 1, 3, 4 (drop local httpRequest, accept session, return body_html)
- `lib/actions/extract_html_table.js` — Phase 4 (rely on cached_body when present)
- `lib/actions/_cheerio_tables.js` — Phase 5a (TENURE_RE expansion)
- `scripts/fetch_rates_playwright.js` — Phase 2 (CLI wrapper around new module)
- `scripts/extract_rates.js` — Phase 5b, 5c (relax extractor, column inference)

## Test plan

**New fixtures:**
- `tests/fixtures/html/au_sfb_rates.html`
- `tests/fixtures/html/hdfc_rates.html`
- `tests/fixtures/html/blocked_403.html` (WAF simulation)

**New helpers:**
- `tests/helpers/mock_session.js` — `{ fetch: async (url) => ({status, contentType, body}), close: async () => {} }`

**New test files:**
- `tests/lib/actions/_http.test.js` — Phase 1
- `tests/lib/actions/_playwright_session.test.js` — Phase 2 (env-gated)
- `tests/lib/actions/extract_html_table.fixtures.test.js` — Phase 5

**Existing tests needing updates:**
- `tests/lib/orchestrator.test.js` — 4 happy-path tests gain `session: mockSession()` in input.

---

## Risks

1. **Playwright cold-start slows simple cases.** Phase 3 may slow banks that aren't WAF-blocked. Mitigation: the `RDA_USE_PLAYWRIGHT_SESSION=0` env-flag bypasses session use without code change. If smoke shows >2× slowdown overall, consider an opportunistic path (Node HTTP first, escalate to Playwright on block) — not in scope for first pass.
2. **TENURE_RE expansion may match non-tenure text** (e.g., "5 to 7 days return policy" in page footers). Mitigated by scoring being applied at table level — only tables with multiple matching rows score high enough to be picked.
3. **`session.fetch` semantics on JS-heavy pages.** `networkidle` may timeout (banks with infinite polling). Default 30s timeout; configurable per call. If timeout, fall back to Node HTTP for that call.
4. **`cached_body` may not be set** when `extract_html_table` runs because classify_rate_page failed. Action already handles missing cached_body by falling back to its dispatcher — no new failure mode.
5. **Cookie bleed between products** within one bank. Per-bank session shares cookies across fd/fd_nre/fd_nro/fd_fcnr fetches; that's typically desirable (auth cookies, session warmup). Documented assumption.

**Back-out plan:** Each phase is independently revertable. Phase 3's `RDA_USE_PLAYWRIGHT_SESSION=0` flag bypasses session use at runtime, so if a deployed Phase 3 misbehaves we can disable it without reverting commits. Phases 1 + 2 + 5 are all net-positive on their own and ship safely without Phase 3.

---

## Out of scope (deferred)

- **Widening LLM use** beyond the existing action-level seams (`find_website` web search, `extract_html_table` LLM-fallback, `extract_via_vision`). The existing seams stay; A+C doesn't add new ones. If Phase 5 leaves HDFC or another bank still empty, an LLM-fallback inside `extract_html_table` may earn its keep — but that's a Phase 7+ decision, not part of A+C.
- Per-bank selector hints / config-driven column maps (column inference should obviate this).
- Proxy / UA rotation (only needed if Playwright alone doesn't defeat WAFs; smoke will tell us).
- Cross-run caching of fetched HTML (orthogonal to A+C).
- Migrating `extractHtmlStatic` and the subprocess `extractHtmlJs` paths to the new session module. Leave the subprocess path intact as a working fallback during Phases 2–3.
- Concurrent per-bank Playwright sessions (run-batch already parallelizes via child processes; in-orchestrator parallelism is a memory/leak risk).

---

## Verification

End-to-end sequence per phase (each phase's commit should be verified before starting the next):

1. **All phases:** `npm test` passes (400+ tests).
2. **Phase 0:** `sdlc/sprints/sprint-003/design/option-a-c-implementation-plan.md` exists and matches this plan file. Cross-link from `two-path-architecture.md` resolves.
3. **Phase 1:** No file declares its own `httpRequest`. `grep -rn "function httpRequest" lib/` returns only `_http.js`.
4. **Phase 2:** `node scripts/fetch_rates_playwright.js https://example.com/` produces the same JSON output as before. New unit tests pass.
5. **Phase 3:** Run `node run-discovery.js "HDFC Bank Limited" --category "Private Sector Bank (Indian)" --path orchestrator --output-dir /tmp/smoke-p3` — find_website, find_rate_page, classify_rate_page all complete with 2xx responses (visible in trace).
6. **Phase 4:** Same run shows `session.fetch` count = product count, not 3× product count.
7. **Phase 5:** Re-run the 5-bank smoke (SBI, HDFC, AU SFB, Abhyudaya, BOI-IBU). Aggregate slabs ≥150 (vs current 40). Comparison report at `output/runs/compare-5bank-final/report.md`.
8. **Phase 6:** Architecture note updated; final smoke report committed under `sdlc/sprints/sprint-003/implementation/`.
