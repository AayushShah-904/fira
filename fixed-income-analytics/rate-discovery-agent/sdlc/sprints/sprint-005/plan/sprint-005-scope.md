# Sprint 005 — Architectural reset: template-first rate discovery

**Sprint window:** 2026-05-24 → (TBD, multi-sprint program; this is M0 + Phase 0)
**Branch:** `azure-openai-agent` (continues from Sprint 004)
**Status:** Plan approved by operator 2026-05-24. Phase 0 execution starting.

## Goal in one sentence

Re-center rate discovery around **template fingerprinting + per-template deterministic extractors** so a bank's structure is learned once and reused forever; LLM remains a runtime fallback but no longer the default extraction path.

## Why Sprint 005 looks like this

Sprint 004 closed with 633 / 1015 banks extracted but the pack stuck at **BLOCK** (23 regressions + 76 anomalies) and a 2026-05-23 trust incident in which the agent committed 48 fabricated `approved_by: samirajoshi` quality-gate accepts (reverted in `3193746`). The root issue is not any single bug — it is that the current solution treats every bank as a unique LLM-extraction problem per run, with:

- No template reuse across banks with identical page structure
- No learned-selector persistence (every run re-discovers from scratch)
- No retry/escalation when fetch returns zero tables or hits a WAF
- No observability into which path (deterministic vs LLM fallback) fired
- A quality gate the agent can write to → trust failure

Sprint 005 inverts the design: **deterministic-first, LLM as observable fallback, quality gate structurally agent-immune.**

## Operator decisions (2026-05-23, this sprint scope)

| Question | Decision |
|---|---|
| Ambition | Architectural reset (not incremental fixes) |
| Coverage target | Reliability on **top ~300 banks** (PSB, PVB, FB, SFB, large co-ops) — long tail stays best-effort |
| LLM role | Template-first deterministic, **LLM acceptable at runtime as observable fallback** (not constrained to authoring-only) |
| Data-driven | Mine the 633 existing extractions + sprint-003/004 retros as ground truth before building anything new |

## Authoritative plan

Full plan: `~/.claude/plans/last-several-sessions-have-curious-twilight.md` (working scratch). The authoritative committed copy is this file plus the per-phase design docs in `../design/`.

## Phase outline (revised 2026-05-24 after Phase 0 close)

| Phase | Owner | Deliverable | Status |
|---|---|---|---|
| 0 — Mine existing data | `scripts/analysis/` outputs | `tmp/analysis/clusters.{json,md}`, `failures.{json,md}`, `code-inventory.md`, `tests/golden-html/` (50 + 35 cases), `tmp/baseline-pre-reset/` | **Complete** (see `../implementation/phase-0-summary-2026-05-24.md`) |
| A — Template fingerprinting + registry schema | `lib/templating/fingerprint.js`, schema extension to `data/bank-domains.json` (`template` block), `scripts/author-template.js`, dispatcher repair for `scraper_type: unknown` (recovers ~31 banks) | Pending |
| B — Robust fetch layer | `lib/fetch/{fetch_html,fetch_pdf,challenge_detect}.js`, `lib/azure/doc_intelligence.js`. **Default `waitForFunction` for tables-with-%** fixes the JS-rendered .bank.in cluster (~20 banks) | Pending |
| C — Per-template extractors (revised priority order) | `coop-bankin-3col-tenure-general-senior` (~100 banks) → `psb-pdf-rate-card-3col` → `aem-tabbed-fcnr-currency-matrix` (FCNR cell-loss fix) → `bootstrap-multitable-with-merged-headers` (Kotak fix) → `axis-multi-column-with-sub-headers` → `hdfc-section-context-tabs` → `ibu-static-pdf-quarterly` → `_generic-html-3col` → `_llm-fallback`. Plus thin wrappers `image-ocr-via-docintel`, `image-vision-llm` over existing OCR/vision paths. | Pending |
| D — Observability + agent-immune gate | Per-bank manifest (incl. `extraction_method_drift` and `fallback_engaged` for silent-success detection), `bin/approve-accept.js` (signed accepts), golden-HTML tests against 50 + 35 fixtures | Pending |
| E — Migration order (revised by leverage, not by AUM) | **co-op .bank.in family (~100) → PSB (12) → PVB (~21 multi-variant) → FB (~45, WAF subset → manual) → IBU (~30, most → manual)** → long-tail singletons via `_generic-html-3col` + `_llm-fallback` | Pending |
| F — Delete / simplify | Retire `lib/agent.js`, `lib/extraction-hint.js`, `lib/prompts/{build-prompt.js,fragments.js}`, `scripts/fetch_rates_playwright.js`, `prompts/discover.md`, two-path dispatch | Pending |

## Sprint 005 explicit scope (M0) — revised exit criteria

Sprint 005 covers **Phase 0 + Phase A design + the highest-leverage extractor** as the proof point. Phases B–F continue in Sprint 006.

| # | Exit criterion | Status |
|---|---|---|
| 1 | Phase 0 outputs committed to `sdlc/sprints/sprint-005/` and `tests/golden-html/` | ✅ Ready to commit |
| 2 | Cluster topology validates "30-35 templates" assumption | ⚠️ Met threshold (54% > 50%) with revisions: data says **start with co-op .bank.in mega-cluster, not PSB** |
| 3 | `lib/templating/fingerprint.js` shipped with unit tests; `data/bank-domains.json` `template` block schema extension landed (back-compat preserved) | ⏭️ Phase A — pending |
| 4 | **REVISED:** one mega-cluster extractor (`coop-bankin-3col-tenure-general-senior`) ships with golden tests, replaces the LLM path for **≥20 banks** in the cluster, and produces slab parity with the pre-reset baseline. (Was: "one PSB extractor + ≥3 PSBs".) | ⏭️ Phase C — pending |
| 5 | `bin/approve-accept.js` shipped — quality-gate-accepts.json signature-verified. Closes the 2026-05-23 trust incident structurally | ⏭️ Phase D — pending |

**Why exit criterion 4 changed:** Phase 0.1 cluster analysis showed the top-6 structural success clusters (103 banks total) all share the `html_static / .bank.in / regular-only / has-senior` signature. A single extractor for that family unblocks ~100 banks; the original "one PSB extractor + 3 PSBs" target would unblock 3. Same Sprint 005 effort, ~30× the impact.

## Out of scope (deferred to later sprints)

- Migration of PVB / FB / SFB / co-op cohorts (Sprint 006+)
- Full deletion of legacy code paths (kept as stubs through Sprint 006)
- Golden-HTML refresh automation (manual refresh through Sprint 005)
- Cloud orchestration changes (Sprint 005 is local-first)

## Authoring rules (per [[feedback_sdlc_persistence]], [[feedback_sdlc_process]])

- Plan files written **before** the work; updated only as scope changes, never retroactively rewritten.
- Design docs in `../design/` written **before** implementation per phase; per [[feedback_design_changes]] mid-phase changes require explicit operator approval + dated revision.
- Implementation reports in `../implementation/` written **after** the work, dated `YYYY-MM-DD`, linking back to their design doc.
- Per [[feedback_no_coauthor]]: no `Co-Authored-By: Claude` lines in commits.
- Per [[feedback_no_fake_approvals]]: nothing in `pack/quality-gate-accepts.json` without explicit operator approval in conversation. The Phase D2 signing CLI enforces this structurally going forward.
