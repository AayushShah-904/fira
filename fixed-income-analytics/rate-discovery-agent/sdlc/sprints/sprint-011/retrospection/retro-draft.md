# Sprint 011 — Retrospective (DRAFT — not yet closed)

**Sprint:** 011
**Branch:** `azure-openai-agent`
**Opened:** 2026-06-11
**Retro written:** 2026-06-19
**Status:** DRAFT — awaiting operator approval to close

---

## What the sprint was supposed to deliver

Six Tier 1 exit criteria from the scope doc:

| # | Criterion | Outcome |
|---:|---|---|
| 1 | Extension 2 work committed + pushed | ✅ Done — `f06f9d8` at sprint open |
| 2 | D4 profile drain verified | ⚠️ Not documented — assumed done at sprint open, no verification record |
| 3 | "Clean-but-significant-drop" safe-write rule (item 12) shipped with tests | ❌ Not started |
| 4 | Axis single-bank cloud smoke passes (item 1) | ❌ Not started |
| 5 | Cohort watchdog Function deployed (item 2) | ❌ Not started |
| 6 | Sprint retro committed | 🔄 This document (draft) |

Tier 2 and Tier 3 items (13–17) were explicitly deferred if budget ran short; none started.

---

## What the sprint actually did

### Shipped — item A (Extension 2 handover)

`f06f9d8` committed the Extension 2 working tree: best-per-variant chooser, pack 9,202 slabs, FCNR cohort scripts. This was the only planned engineering commit and it landed correctly at sprint open.

### Cohort data runs (uncommitted)

216 output files are modified in the working tree, representing one or more cohort re-runs during the sprint period. These capture updated rate data for banks including PSBs (Union Bank, Bank of Baroda, etc.) and NRI/FCNR variants. These changes are uncommitted as of retro time — they should be committed or reviewed before Sprint 012 opens.

### Unplanned but high-value — QA & Data Quality design

The sprint pivoted substantially into architecture design. A comprehensive design document was produced:

**`sdlc/sprints/sprint-011/design/qa-data-quality-draft.md`**

This covers 10 design axes and a 4-section appendix:

1. Automated detection (statistical, structural, source-freshness, confidence calibration)
2. Context-aware collection (per-bank operational profile, failure taxonomy, extraction invariants)
3. Human QA sampling (structured findings, risk-scored queue, feedback paths, trust score)
4. Temporal awareness (MPC calendar, rate diff log, profile inheritance)
5. External ground truth (RBI repo rate, DBIE category averages, exchange filings)
6. Rate data versioning (git-tracked output, rollback, diff computation)
7. Coverage vs. accuracy (UNVERIFIABLE gate state, WAF decoy detection)
8. Agent as a white box (prompt versioning, reasoning trace mining, regression testing)
9. Bank tiering and data SLAs (T1 = all PSBs + major PVBs; tiered quality gates; manual entry as first-class workflow; T1 daily liveness check)
10. Orchestration architecture (axes: scope/automation/cost/trigger; specialised agent network; model selection; agent-assisted QA; data lineage; feedback loop)
11. Action granularity (decomposing `extract_html_table`, `extract_pdf_table`, `classify_rate_page` into single-responsibility sub-actions; typed I/O contracts; Azure OpenAI structured outputs)
12. Context propagation (three-layer design: declared context + manifest + content store; context sub-tree structure; orchestrator-owned mutation; QA judge clean-room independence)

Appendix covers four deferred threads: prompt regression corpus management, cold-start bootstrapping, multi-language extraction, error budget operationalisation.

This document is the primary deliverable of Sprint 011 and drives Sprint 012 scope.

---

## Why the engineering items didn't land

The sprint opened with items 18–21 (FCNR variant coverage, per-table variant classification, cohort builder UNION rule, LLM extraction QC) as acute Tier 1 problems surfaced during the 2026-06-15 FCNR refresh session. These were added to the scope after the original scope was written and effectively displaced the original items 12, 1, 2 in the work queue — but none of the four new items shipped either.

The pivot to QA design exploration was the primary activity of the sprint period. This was a productive use of time (the design document represents weeks of future sprint clarity) but it meant no engineering items closed.

---

## Items carrying forward to Sprint 012

### Carry from Sprint 011 Tier 1 (original)

| # | Item | Note |
|---:|---|---|
| 12 | "Clean-but-significant-drop" safe-write rule | 36 banks / 421 slabs of loss observed; high leverage |
| 1 | Axis single-bank cloud smoke (Phase 5 fix verification) | Still unconfirmed in real cloud |
| 2 | Out-of-process cohort watchdog | Prerequisite before next large cloud cohort |

### Carry from Sprint 011 Tier 1 (added mid-sprint, items 18–21)

| # | Item | Note |
|---:|---|---|
| 18 | Agent must extract ALL configured variants — no early-stop after first PDF | Blocks every NRI/FCNR refresh for multi-PDF banks |
| 19 | Per-table variant classification + footnote capture in `extract_via_ocr` | 36/71 Axis FCNR slabs currently mis-tagged as FCNR |
| 20 | Cohort builder UNION rule | 13 banks silently excluded from FCNR cohort |
| 21 | Per-bank dedup + effective-date sanitisation on LLM-extracted files | BoB FCNR has garbage effective_date; 5 duplicate slabs |

### New from Sprint 011 design work

The QA/data-quality sprint candidate (previously noted in memory). Scope to be decided at Sprint 012 planning — likely not the entirety of Sprint 012 given the engineering carryover above, but a phased entry is possible.

---

## Data state at sprint close

- `output/latest/` has 216 modified files (uncommitted). These need operator decision: commit as-is, review first, or discard.
- `sdlc/sprints/sprint-011/design/qa-data-quality-draft.md` — new file, uncommitted.
- `sdlc/sprints/sprint-011/plan/sprint-011-scope.md` — committed in `f06f9d8`.
- No implementation docs written (no engineering landed).

---

## What went well

- Extension 2 handover landed cleanly at sprint open; pack 9,202 slabs delivered to PM.
- The QA design exploration produced a thorough, actionable document covering detection, avoidance, human QA, agent architecture, tiering, and orchestration — arguably more sprint-planning value than any single engineering item would have provided.
- The tiering decision (T1 = PSBs + major PVBs) was made and documented — previously implicit.
- Azure OpenAI constraint (no third-party marketplace models) was surfaced and incorporated into the multi-agent model selection table.

## What could improve

- The sprint opened with 6 exit criteria and ended with 0 engineering completions. The scope was too broad for the available time, and the mid-sprint addition of items 18–21 without removing original items compounded this.
- Items 18–21 (FCNR) were acute and PM-visible; they should have been scoped as the primary sprint focus the moment they were surfaced (2026-06-15), with the original items explicitly deferred to Sprint 012.
- The uncommitted output data (216 files) should have been committed as a cohort checkpoint during the sprint rather than left to accumulate.

---

## Sprint 012 opening recommendation

**Primary focus:** Close the FCNR gap (items 18, 19, 20, 21) — these are PM-visible and the workaround scripts are fragile. Pair with item 12 (clean-but-significant-drop safe-write) as the structural foundation.

**Secondary:** Phase 1 of the QA design (run log writer + config schema extension + resolved URL tracking) — low-risk, high future-value, fits alongside the FCNR engineering work.

**Defer:** Watchdog (item 2), cloud smoke (item 1), Tier 2/3 items — until FCNR + safe-write land.
