# Sprint 004 — design

Design documents land here as each track produces them. Per the scope doc
(`../plan/sprint-004-scope.md`):

| File | Owner track |
|---|---|
| `tier-header-propagation.md` | A — A4 fix |
| `cohort-smoke-50-categories.md` | A — 50-bank smoke selection |
| `operator-trigger-cli.md` | B — start-cohort.js UX |
| `incremental-blob-upload.md` | B — per-bank push sequencing |
| `top-200-cohort.md` | C — cohort composition |
| `pack-quality-gate.md` | Late-sprint — pack publish gate (build → gate → publish) |
| `orch1-multi-table-extraction.md` | Late-sprint — orchestrator multi-table HTML extraction + section-context interpretation (closes the HDFC class of gaps where one page carries multiple rate tables for multiple variants) |
| `orch2-html-fulfills-product.md` | Late-sprint — HTML `fulfills_product` hints; extends M2.6's PDF mechanism so one HTML rate page can fulfill multiple variants (closes HDFC NRE/NRO via the domestic page) |
| `ocr-fallback.md` | M3 — OCR fallback (Azure Document Intelligence) for image-based rate cards and text-empty PDFs (Tamilnad Mercantile JPEG, scanned bank circulars, image-PDFs). Gated on operator approval for Azure provisioning. |
| `cohort-pm-q2-pre-flight.md` | Late-sprint — pre-flight checklist for the 513-bank pm-refresh-2026-q2 re-run: engine quick wins (IDBI/ICICI/triage), operational readiness (OCR cost telemetry, output cleanup, smoke cohort), dual-baseline quality-gate setup, and cohort execution plan |

Each doc starts with a Context section, names the files it will modify,
references reusable functions, and ends with a Verification section. See
sprint-003/design/* for the established shape.
