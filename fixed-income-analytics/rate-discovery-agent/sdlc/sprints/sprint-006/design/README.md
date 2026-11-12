# Sprint 006 — design

Design documents land here per step. Per `../plan/sprint-006-scope.md`:

| File | Step | Status |
|---|---|---|
| `fetch-layer-hardening.md` | 1 — Phase B `lib/fetch/{fetch_html,fetch_pdf,challenge_detect}.js` + `lib/azure/doc_intelligence.js` refactor + Phase A.4 deep fix | Pending |
| `author-template-cli.md` | 1 — Phase A.3 `scripts/author-template.js` interactive CLI | Pending |
| `per-bank-manifest.md` | 2 — Phase D1 manifest schema + run-summary rollup + extraction_method_drift detection | Pending |
| `extract-html-table-split.md` | 3a — Single biggest refactor in repo (1,870 LOC). Splits into `_generic-html-3col.js` + `_llm-fallback.js`. Design lands BEFORE code. | Pending |
| `extractor-psb-pdf-rate-card-3col.md` | 3b — PSB PDF rate cards | Pending |
| `extractor-pvb-multi-variant.md` | 3b — PVB multi-variant HTML | Pending |
| `extractor-fb-multi-variant.md` | 3b — Foreign bank multi-variant | Pending |
| `extractor-ibu-static-pdf-quarterly.md` | 3b — IBU GIFT City quarterly PDFs | Pending |
| `migration-runbook.md` | 4 — Per-bank promotion + pre-emptive accepts + parity-check protocol | Pending |
| `legacy-retirement-checklist.md` | 5 — Deprecation notice for `lib/agent.js`, one-shot `extraction-hint.js` migration | Pending |

Each doc starts with a **Context** section, names files it will modify, references reusable functions, and ends with a **Verification** section. See `sdlc/sprints/sprint-005/design/*` for the established shape.

Design docs are written **before** their step's implementation begins. Per [[feedback_design_changes]]: any mid-step design change requires operator approval and a new dated revision — never a silent in-place rewrite.

The sprint-005 design files for Phase B / D / C / E are STARTING POINTS that should be lifted into the Sprint 6 versions and updated with the wiring/integration details. Specifically:

- `sdlc/sprints/sprint-005/design/fetch-layer-hardening.md` → lift into `fetch-layer-hardening.md`
- `sdlc/sprints/sprint-005/design/observability-and-gate.md` → the D1 section lifts into `per-bank-manifest.md` (D2 already shipped in Sprint 5)
- `sdlc/sprints/sprint-005/design/extractor-registry.md` → reference from each new extractor design doc; the contract is unchanged
- `sdlc/sprints/sprint-005/design/migration-plan.md` → lift into `migration-runbook.md` with the Sprint 6 pilot specifics
