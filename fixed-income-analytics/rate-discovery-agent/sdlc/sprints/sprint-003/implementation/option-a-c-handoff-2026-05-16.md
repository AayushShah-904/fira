# Option A+C — implementation handoff (2026-05-16)

> **Sprint 003 closed 2026-05-18.** Authoritative retro at `../retrospection/retro.md`. Sprint 004 plan at `../../sprint-004/plan/sprint-004-scope.md`. This handoff is preserved as the line-level evidence trail for Phases 1–4 of option A+C.

Resume point after a context clear. Read this first, then the plan, then dive into Phase 3.

## 2026-05-18 update — Phase 4 + prompt-improvement complete

- Step 1 A/G shipped — `ef24c79` (BOI-IBU GIFT URL seeded + `domcontentloaded` default).
- Phase 4 single-fetch + cost tracking shipped — `ddce343` (`fetch_page` action; `cached_body` plumbing through classify + extract; `llm_usages` rolled into `summary.json` total_cost_usd).
- Anti-fabrication LLM chunking shipped — `debb627` (per-table chunks, `source_row_text` post-validation, new prompt with hard rules + `errors[]` field). Design doc: `prompt-improvement-2026-05-18.md`.
- **5-bank smoke at `output/runs/smoke-p4c2/`**: 153 trustworthy slabs. BOI-IBU 24 hallucinated → 68 real (USD/EUR/GBP/JPY × 17 tenures × 2 deposit tiers). SBI FCNR 24 hallucinated → 36 real (= 6×6 layout, matches live page). SBI total 59. AU SFB 24. HDFC regressed 71 → 2 — captured as `hdfc-regression-2026-05-18.md` follow-up.
- Tests: 442 pass / 0 fail / 8 skip with `SKIP_PLAYWRIGHT_TESTS=1`.

The strategy doc's 80% coverage goal was reached at the cost-tracker level (Step 1) and exceeded under the trust-but-verify rule (post-fix slabs all trace back to actual HTML). HDFC is a known carve-out per the strategy doc's "Stop conditions" section.

## Current state

**Branch:** `azure-openai-agent`
**Last commit:** `cb3ce7e` — `actions: route orchestrator HTTP through Playwright session (Phase 3 of option A+C)` (committed 2026-05-16).
**Test count:** 420 passing, 8 skipped (1 pre-existing skip + 7 env-gated playwright suite).
**5-bank smoke after Phase 3:** 31/174 slabs = 18 % of LLM-path coverage (was 40/174 = 23 % pre-P3). See `output/runs/smoke-p3-cb3ce7e/REPORT.md`.

> **Tomorrow's first read:** `sdlc/sprints/sprint-003/implementation/to-80-percent-strategy-2026-05-16.md` — 6-step plan to reach ≥ 80 % coverage. Starts with quick wins (BOI-IBU rate_pages seed + raise 512 KB cap + `domcontentloaded`).

## The plan

The canonical spec for what we're building lives at:

- `sdlc/sprints/sprint-003/design/option-a-c-implementation-plan.md`

Read it before doing anything else. It includes:
- The 5-bank smoke baseline showing orchestrator at ~17% slab coverage vs LLM path
- Architecture review identifying the WAF + plain-Node-HTTP gap as root cause
- The phased plan (0–6) for routing all orchestrator HTTP through one per-bank Playwright session, then tightening the cheerio extractor

Also relevant:
- `sdlc/sprints/sprint-003/design/two-path-architecture.md` — broader context on the dual-path setup (orchestrator + LLM-prompt coexisting; orchestrator is the eventual single path with LLM at well-bounded action seams)
- `sdlc/sprints/sprint-003/design/action-contracts.md` — input/output schemas for each action

## What's done

| Phase | Commit | What it did |
|---|---|---|
| 0 | `3182212` | Snapshot the plan into sprint docs + cross-link from two-path-architecture.md |
| 1 | `71f7b3c` | Consolidate HTTP into `lib/actions/_http.js`. Drop local httpRequest from find_website + classify_rate_page. Add `truncated` flag + `logger.warn` on byte-cap overflow. Raise default maxBytes 32 KB → 512 KB. New `tests/lib/actions/_http.test.js` (14 tests). |
| 1.5 | `0659cdb` | Fold in: `find_rate_page` trusts cached_path under WAF when HEAD fails (parallel to classify's cached_kind trust). |
| 2 | `4e55901` | New `lib/actions/_playwright_session.js` exposing `createSession({logger,headless})` → `{ fetch, close, _internals }`. fetch returns `_http.js`-compatible `{statusCode, headers, body, truncated, finalUrl}`. Per-bank lifecycle. Auto-scroll + accordion expansion built in. New `tests/lib/actions/_playwright_session.test.js` (7 tests, env-gated via `SKIP_PLAYWRIGHT_TESTS=1`). |
| 3 | `<pending commit>` | Route orchestrator HTTP through per-bank Playwright session. `_http.js` `httpRequest`/`headCheck` accept a `session` option that delegates to `session.fetch` and auto-falls-back to Node HTTP on session throw. `find_website`, `find_rate_page`, `classify_rate_page` thread session through. `orchestrator.js` creates one session per `orchestrate()` via `actions.createSession` DI, gated on `RDA_USE_PLAYWRIGHT_SESSION!='0'`, closed in `finally`. Skip rules: session bypassed when `headers` is non-empty (Bing/AOAI calls stay on Node HTTP). New `tests/_helpers/mock_session.js`. +4 `_http.test.js` tests + 3 orchestrator tests (lifecycle, createSession-throws, flag bypass). |

## What's next (Phase 4 — cached_body plumbing)

**Goal:** each rate page is fetched exactly once per `orchestrate()`, not three times (find_rate_page anchor parse + classify_rate_page sniff + extract_html_table fetch all currently hit it).

### Concrete edits

1. **`lib/actions/classify_rate_page.js`** — change output schema to include `body_html` (the rendered DOM string captured during the GET sniff). For non-HTML kinds (`pdf`, `image`), `body_html` is `null`.

2. **`lib/orchestrator.js`** — when `classify` succeeds with non-null `body_html`, pass it into `extract_html_table` as `hints.cached_body`. The action already supports the path; just thread the field.

3. **`lib/actions/extract_html_table.js`** — verify the cached-body path stays preferred when `session` AND `hints.cached_body` are both present (don't re-fetch). Today the action already prefers cached_body when present; no change expected, just confirm.

### Done when

Per-bank trace shows exactly one `session.fetch` per (bank, product) pair, not 2–3. AOAI cost remains $0. Update orchestrator happy-path test to assert `extract_html_table` receives non-empty `hints.cached_body` and `session.fetch` count == N (products), not 2N/3N.

### Verification before commit

```bash
npm test                                        # 423+ all pass (3 new for cached_body)
SKIP_PLAYWRIGHT_TESTS=1 npm test                # CI parity
node run-discovery.js "HDFC Bank Limited" --path orchestrator --output-dir /tmp/smoke-p4 --log-level debug
# expect: trace count of session.fetch == count of (product) ≤ 4
```

## After Phase 4

- **Phase 5** — extraction quality (Option C). TENURE_RE expansion (AU SFB `1 Yr` blind spot), relax `extractSlabsFromTable` row filter, add `inferColumnMapping(rows)` helper.
- **Phase 6** — re-run 5-bank smoke, update `two-path-architecture.md` with the metrics table. Target: orchestrator ≥70% of LLM-path slab counts.

## Phase 3 verification ran in this session

- `node --test tests/lib/actions/_http.test.js` — 18 pass (was 14, +4 new session-delegation tests).
- `node --test tests/lib/orchestrator.test.js` — 22 pass (was 20, +2 new tests for createSession-throws + RDA_USE_PLAYWRIGHT_SESSION=0 bypass).
- `SKIP_PLAYWRIGHT_TESTS=1 npm test` — 420 pass, 8 skipped (1 pre-existing + 7 env-gated playwright suite), 0 fail.
- **Not yet run:** HDFC live smoke. Block before committing if Playwright isn't installed in the smoke environment — `RDA_USE_PLAYWRIGHT_SESSION=0` lets the orchestrator run unchanged.

## Key files (cheat sheet)

| Path | Purpose |
|---|---|
| `lib/orchestrator.js` | Sequencer. DI override via `input.actions`. Phase 3 added `createSession` to DEFAULT_ACTIONS + session lifecycle. |
| `lib/actions/_http.js` | Shared httpRequest + headCheck. Phase 3 added `session` delegation + auto-fallback. |
| `lib/actions/_playwright_session.js` | NEW (Phase 2). The session being injected. |
| `lib/actions/find_website.js` | Phase 3 — accepts + forwards `session`. |
| `lib/actions/find_rate_page.js` | Phase 3 — accepts + forwards `session`. |
| `lib/actions/classify_rate_page.js` | Phase 3 done; Phase 4 still pending — return `body_html`. |
| `lib/actions/extract_html_table.js` | Phase 4 — rely on `hints.cached_body` from orchestrator. Already supports it. |
| `tests/_helpers/mock_session.js` | NEW (Phase 3). Mock matching `_playwright_session.createSession()` shape. |
| `lib/actions/_cheerio_tables.js` | Phase 5a — expand TENURE_RE. |
| `scripts/extract_rates.js` | Phase 5b/c — relax row filter, add column inference. |
| `scripts/fetch_rates_playwright.js` | Untouched in Phase 3 — Phase 2 left the CLI as-is. Eventually folds into the session module but not in A+C scope. |
| `scripts/analysis/compare-paths.js` | Existing harness. Re-run after Phase 5 to measure improvement. |

## Smoke-run artifacts from this session

- `/tmp/5bank-llm/` — staged LLM-path baseline (SBI, HDFC, AU SFB, Abhyudaya, BOI-IBU)
- `/tmp/5bank-orch/` — last orchestrator run; mixed results (SBI 28 slabs ✓, HDFC 0, AU 7, Abhyudaya 5, BOI-IBU 0). Will be re-run after Phase 3 and again after Phase 5.
- `output/runs/compare-sbi-v6/report.md`, `compare-sbi-v7/report.md` — SBI-only progressions through cheerio + IBU cheerio + currency hints.

## Open notes

- **Norton Safe Web HTTPS scanning**: the dev's Windows machine had it ON for most of this session, MITMing every TLS handshake with "Norton Web/Mail Shield Root". Many `--strict-ssl=false` and `tolerant: true` workarounds traced to it. User disabled it; strict TLS now works for normal hosts. Phase 3's `tolerant: true` path can be revisited and probably narrowed once the WAF question is fully separated from the TLS question.
- **LLM use inside orchestrator is allowed** at well-bounded per-action seams. Not in A+C scope but not forbidden — `extract_html_table` already has an LLM-fallback path (`lib/actions/extract_html_table.js:202`). The strategic goal is ONE eventual path (orchestrator) that uses LLM where it earns its keep, not zero LLM.
- **The orchestrator path is wired via `--path orchestrator`** in `run-discovery.js`. The LLM-prompt path (`--path llm`, default) still works and is the production runner. The dual-path window stays open until orchestrator coverage justifies retiring CLAUDE.md.
