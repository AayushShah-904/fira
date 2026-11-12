# Sprint 006 — wire it in, migrate the pilot, retire the legacy

**Sprint window:** 2026-05-24 → TBD (continues Sprint 005's architectural reset)
**Branch:** `azure-openai-agent` (continues from Sprint 005)
**Status:** Plan approved by operator 2026-05-24. SDLC scaffolding ready; Step 1 starting.

## Goal in one sentence

Wire the Sprint 5 foundation primitives into the runtime path, migrate a **50-bank mixed pilot** to deterministic extraction, and begin retiring the legacy LLM-chat extraction path.

## Why Sprint 006 looks like this

Sprint 5 shipped the foundation primitives (`lib/templating/`, `lib/quality-gate/signed-accepts.js`, `bin/approve-accept.js`, `lib/extractors/coop-bankin-...` + dispatcher) and structurally closed the 2026-05-23 trust incident, but **none of it is wired into the runtime path yet**. Sprint 6 connects the wiring and proves the architecture at the pilot scale.

The 50-bank mixed pilot is deliberate: it forces ~4-5 new extractor templates to be authored (proving the architecture beyond the single coop-bankin extractor), exercises the new fetch layer against diverse bank types (.bank.in co-op, PSB PDFs, PVB multi-variant HTML, FB, IBU), and is small enough that the operator can review every per-bank parity diff before promotion.

## Operator decisions (2026-05-24)

| Question | Decision |
|---|---|
| Scope ambition | **All five carryover phases (B + D1 + C+ + E + F)** in one sprint |
| Migration cohort | **50-bank mixed pilot across bank types** |
| Cloud orchestration | **Stay local-first.** Cloud re-wiring waits for Sprint 7 |

## Authoritative plan

Full plan: `~/.claude/plans/last-several-sessions-have-curious-twilight.md` (working scratch). The authoritative committed copy is this file plus the per-phase design docs in `../design/`.

## Five steps

| # | Step | Owner | Status |
|---|---|---|---|
| 1 | **Phase B foundation** — `lib/fetch/{fetch_html,fetch_pdf,challenge_detect}.js`, `lib/azure/doc_intelligence.js`, `scripts/author-template.js` (Phase A.3), `scripts/analysis/harvest-golden-html.js`, Phase A.4 deep fix (re-attempt-via-orchestrator) | `lib/fetch/`, `scripts/` | In progress |
| 2 | **Phase D1 per-bank manifest** — `lib/manifest/per-bank-manifest.js` + run-summary rollup + extraction_method_drift detection + wire into `run-discovery.js` | `lib/manifest/` | Pending Step 1 |
| 3 | **Phase C+ split + new extractors** — Split `lib/actions/extract_html_table.js` (1,870 LOC) into `_generic-html-3col.js` + `_llm-fallback.js`. Author 4 new template extractors: `psb-pdf-rate-card-3col`, `pvb-multi-variant`, `fb-multi-variant`, `ibu-static-pdf-quarterly` | `lib/extractors/` | Pending Steps 1+2 |
| 4 | **Phase E pilot migration** — Author template blocks for 50 banks via `scripts/author-template.js`. Per-bank parity check. Pre-emptive `bin/approve-accept.js` for controlled-cleanup banks. Pack quality-gate PASS | `data/bank-domains.json` | Pending Step 3 |
| 5 | **Phase F begin retirement** — Unify `source_row_text` across paths. Deprecation notice on `lib/agent.js`. One-shot `lib/extraction-hint.js` migration + deletion | `lib/agent.js`, `lib/extraction-hint.js` | Concurrent with Step 4 |

## Exit criteria

| # | Criterion | Verification |
|---|---|---|
| 1 | Phase B fetch layer ships; JS-rendered .bank.in cluster (~20 banks) recovers | Re-extract 5 representative html_js .bank.in banks; assert ≥1 slab each |
| 2 | Per-bank manifest emitted on every run; roll-up surfaces `fallback_engaged` + `needs_template_authoring` | Run pilot 50; `_manifest_summary.json` shows deterministic % > 70 |
| 3 | `extract_html_table.js` split into `_generic-html-3col.js` + `_llm-fallback.js`; legacy file is a thin shim | All existing extract_html_table tests pass against shim |
| 4 | 4 new extractor modules shipped (PSB, PVB, FB, IBU) with unit tests | `npm test` includes new extractor tests; each passes ≥2 synthetic fixtures |
| 5 | 50-bank pilot migrated to deterministic path; pack quality-gate PASS | `node scripts/quality-gate.js` exit 0; manifest shows 50 banks on deterministic templates |
| 6 | `lib/agent.js` carries deprecation notice + warning log; `lib/extraction-hint.js` deleted after migration | grep for callers; assert warning fires; assert hint resolver gone from runtime |

## Out of scope (deferred to Sprint 7)

- `lib/agent.js` deletion (kept as deprecated stub through Sprint 6)
- `scripts/fetch_rates_playwright.js` deletion (kept until Phase B proven on pilot)
- `prompts/discover.md` deletion (kept until `lib/agent.js` deletes)
- Cloud orchestration re-wiring (Container Apps Job, blob streaming)
- Long-tail migration (banks 51-~300)
- Recovery of WAF-blocked FB cluster (Amex/Barclays/Nova Scotia → manual via `bin/approve-accept`)
- BoI-IBU / IndusInd-IBU recovery (need vendor-specific PDF research)

## Authoring rules (per [[feedback_sdlc_persistence]], [[feedback_sdlc_process]])

- Design docs in `../design/` written BEFORE implementation per step. Step 1 does not start code until `fetch-layer-hardening.md` is committed.
- Implementation reports in `../implementation/` written AFTER the work, dated `YYYY-MM-DD`, linking back to design.
- Per [[feedback_design_changes]]: mid-step design changes require explicit operator approval + dated revision.
- Per [[feedback_no_coauthor]]: no `Co-Authored-By: Claude` in commits.
- Per [[feedback_no_fake_approvals]]: nothing in `pack/quality-gate-accepts.json` without explicit operator approval. The Sprint 5 Phase D2 signing CLI enforces this structurally.
