# Sprint 011 — The Quality Sprint (DRAFT plan)

| | |
|---|---|
| **Status** | DRAFT for operator approval — not committed, not closing anything |
| **Date** | 2026-06-26 |
| **Frames** | `sdlc/sprints/sprint-011/position-paper-trust-and-quality.md` (the why/what), `sdlc/sprints/sprint-011/design/qa-data-quality-draft.md` (the mechanism library) |
| **Relationship to** | `sprint-011/plan/sprint-011-scope.md` — this plan **absorbs** scope.md's Tier-1 items 12/18/20/21/2 into the phases below and re-prioritizes them around the Trust Contract. scope.md is left intact; its Tier-3/4 reliability + housekeeping items stay as-is and are not in this sprint unless noted. |

---

## Decisions locked this session (2026-06-26)

1. **Scope is the consequential set (~235 banks)**, not the full 1,995 roster. The ~1,744 co-op tail (NSUCB+DCCB) is *labeled* unaddressable, not chased.
2. **The 42%-undated problem is fixed by a fresh full run of the consequential set**, not by a capture-vs-pack-drop investigation. Hypothesis: undated = data captured before `effective_date` tracking existed. The run *tests* this — post-run undated should fall to ~0; any residual undated bank is a genuine capture bug we then fix.
3. **Sprint 011 is the Quality Sprint** — reframed around the per-rate Trust Contract.
4. **SLA confirmed:** T1 48h / T2 7d / T3 30d (qa-draft §7.2).
5. **No new PM rate publish until the Trust Contract is fully populated** for the consequential set — the standing `rates-pack-2026-06-11.zip` holds until then. Re-publish is a *gate condition* (contract complete), not a sprint-end default.
6. **Verification runs through a purpose-built HTML tool** (terminal/agent-assisted side-by-side proved poor last time), operated by a delegated verifier — see Workstream V.

---

## Sprint thesis

> **Make the consequential ~235 banks trustworthy end-to-end and stand up the Trust Contract on them: fresh-dated, completeness-verified for Tier-1, provenance-surfaced, and honestly tiered — produced by a run that is safe and doesn't lose data.**

We are *not* trying to cover more banks this sprint. We are making the banks that matter **provably trustworthy** and proving the contract works on them, so the PM can receive a real handoff and we can schedule auto-runs on a foundation we believe.

### The consequential set (the sprint's universe)

From the RBI master list, the addressable set (precise membership finalized in Phase 0):

| Segment | ~Count | Tier |
|---|---:|---|
| Public Sector Banks | 12 | T1 |
| Major Private (HDFC/ICICI/Axis/Kotak/IndusInd/Yes/Bandhan/IDFC-First/Federal/RBL) | ~10 | T1 |
| Remaining Private + all SFB | ~22 | T2 |
| Foreign Banks (retail-INR-publishing subset) | ~13–44 | T2/T3 |
| IBUs (GIFT) | 37 | T2/T3 |
| RRBs | 28 | T3 |
| Scheduled Urban + State Co-ops | ~76 | T3 |

**T1 ≈ 30 banks** is the hard-guarantee core. Tiering lives in `data/bank-domains.json` as a `tier` field (qa-draft §7.6) — single source of truth for gate logic, SLAs, and the QA queue.

---

## Phases

Sequence rationale: **make a run safe + well-dated (P0) → stand up the contract & surface the free fields (P1) → do the fresh reset run (P2) → anchor truth & close the completeness blind spot for T1 (P3) → gate & package for handoff (P4).** P0 must precede P2 so the run is safe, dated, and complete-by-construction.

### Phase 0 — Guardrails & write-time hygiene
*Make the upcoming run safe, well-dated, and complete-at-capture. Mostly absorbs existing scope.md Tier-1.*

| Task | Maps to | Files (confirm at impl) |
|---|---|---|
| **`effective_date` capture + ISO-normalize at write time** (kill non-ISO formats like `1st July 1995`) | new + scope.md item 21 | `lib/safe-write.js`, extractor write path |
| **Fix the broken `stale` badge** to parse all date formats (currently undercounts ~33%) | new | `pack/build-pack.js`, the staleness check |
| **LLM-path QC: dedup + effective-date sanitization** | scope.md item 21 | `lib/safe-write.js` post-LLM QC pass |
| **Extract ALL configured variants — no early-stop after first PDF** (completeness-at-capture) | scope.md item 18 | `run-discovery.js` ~L686 post-LLM coverage loop, `lib/actions/extract_via_ocr.js` |
| **Per-table variant classification + footnote capture** (stop tagging RFC-Term as FCNR) | scope.md item 19 | `lib/actions/extract_via_ocr.js` |
| **"Clean-but-fewer" safe-write rule** (block significant non-empty drops) | scope.md item 12 | `lib/safe-write.js` |
| **Out-of-process cohort watchdog** | scope.md item 2 | new ARM-timer Function |

**Exit:** a single-bank run writes ISO-dated, deduped, all-variant output; safe-write blocks a clean-but-fewer overwrite in test; watchdog kills a paused job in <30 min.

### Phase 1 — Trust Contract schema + surface the "free" fields
*Light up the Trust axis from machinery we already built.*

| Task | Maps to |
|---|---|
| **Define the per-rate trust profile schema** (position paper §6.2) and denormalize it into the pack | new |
| **Surface `source_url` + `source_snapshot` per rate** ("don't trust us, verify") | expose S008 snapshot substrate + qa-draft §8.6 lineage |
| **Surface `confidence_tier` (gold/silver/bronze) + `warnings`** | expose `lib/confidence/score.js` (un-flag it) |
| **Cohort UNION rule + gap audit** (coverage honesty — stop silently dropping banks that publish but didn't extract) | scope.md item 20 |

**Exit:** the pack carries a populated `trust` block per slab (fields allowed to be `unverified`); a rate's source snapshot is reachable; the cohort builder warns on publish-but-no-data banks.

### Phase 2 — The fresh consequential-set run (the freshness reset)
*Re-date everything; establish the new baseline; surface execution failures.*

| Task | Notes |
|---|---|
| **Run the ~235 with P0 guardrails on** | undated → ~0; new baseline; provenance captured |
| **Fix Tier-1 execution failures** | axis, kotak, indusind, csb, tamilnad-mercantile, bombay-mercantile (the 6/44 that failed last batch) |
| **Confirm the undated hypothesis** | post-run undated count; residual undated = capture bugs to fix |

**Exit:** consequential set freshly run; **0% undated** in the shipped pack for that set; T1 banks all complete the run.

### Phase 3 — Ground truth + completeness gate (T1)
*The keystone. Closes the correctness + completeness blind spots for the banks that matter.*

| Task | Maps to |
|---|---|
| **Human-verify the ~30 T1 banks** against their sites **via the HTML Verification Tool (Workstream V)**, run by a delegated verifier → ground-truth fixtures | new (the seed set) |
| **Recalibrate the judge** against ground truth — kill the 7× over-flag; produce a real error bar | fixes S008 judge |
| **Activate the golden regression gate for T1** | un-dormant the S008 Phase 6 gate (T1 fixtures only) |
| **Promote extractor↔QA-judge cross-extraction to a per-bank completeness gate (T1)** | qa-draft §2.4/§8.2 — disagree ⇒ union + flag `unverified` |

**Exit:** T1 completeness field is `verified_complete` or `agreement_complete`; a stated fleet error rate **with a confidence interval**; ICICI ships its full ladder.

### Phase 4 — Quality gate upgrade + PM handoff artifact

| Task | Maps to |
|---|---|
| **Gate enforces T1 presence + freshness (<48h) + completeness** as hard blocks | qa-draft §7.4 |
| **Tiered SLA statement** baked into the pack metadata | qa-draft §7.2 |
| **PM handoff package**: trust-tier rollup + SLA statement + coverage-honesty list ("best among N; here are the M we can't reliably collect") + run/monitor runbook | position paper §6.5 |

**Exit:** quality gate is correctness/completeness/freshness-aware (not just slab-count); PM receives the handoff package.

---

## Workstream V — HTML Verification Tool (parallel; required before Phase 3)

Terminal/agent-assisted side-by-side review proved poor last time. Rate verification is inherently visual — comparing tables, reading a PDF/page — so we build a small **HTML verification tool** instead. This is the instrument that produces the ground truth anchoring the whole correctness + completeness story; treat it as a **first-class deliverable**, not tooling overhead. A delegated verifier (not the operator) runs the 30-bank set through it.

- **Inputs:** per bank+variant — our extracted slabs (from the P2 run) + the captured source **snapshot** and `source_url` (from P1) + the current trust profile.
- **The screen:** our extracted slab table on one side; the source on the other (rendered snapshot HTML, embedded PDF/image, + a live link). The verifier marks a per-variant verdict (`correct / wrong / incomplete / stale`) and can **edit / add / delete slabs to capture the true ladder**.
- **Outputs:** (a) structured findings JSONL (qa-draft §3.3 schema); (b) corrected **ground-truth rate files** → become the golden fixtures + judge-calibration set; (c) stamps the trust profile (`correctness`, `ladder_completeness`, `verified_at`, `confidence_tier: gold`) for verified banks.
- **Tech:** local, lightweight, reads the output/snapshot files directly; **no Azure dependency**. It consumes the *same* snapshot substrate that powers user-facing provenance — build once, use for both internal verification and the public "verify" affordance.
- **Scope this sprint:** the 30 T1 banks. Generalizes later to the risk-scored QA queue (qa-draft Axis 3), replacing the planned CLI `scripts/qa/*` tooling.
- **Timing:** can start immediately against the *current* pack for layout, then point at the fresh P2 output. Must be usable before Phase 3 verification begins.

---

## Sprint exit criteria

1. Consequential set freshly run; **0% undated** in its shipped pack; stale badge correct across all date formats.
2. Every rate in the consequential set carries a populated **trust profile** (7 fields, `unverified` allowed where honest).
3. **Provenance live**: every rate links to a source snapshot.
4. **T1 (~30): seed-verified, completeness-gated, present & <48h** — enforced as a hard gate.
5. A **measured fleet error rate with a confidence interval** (seed set + spot-check), replacing the ~0.7%/5.3% guess.
6. The run was **safe**: clean-but-fewer rule + watchdog landed; no data lost mid-run.
7. PM handoff package produced (rate re-publish **gated on full contract population**, per decision 5 — not auto-shipped at sprint end).
8. Sprint retro written as a **draft** (operator closes).

---

## Explicitly NOT in this sprint (deferred)

- Coverage expansion into the co-op tail (T4) — labeled, not chased.
- Fleet-wide completeness gate beyond T1 (T2/T3 get agreement-gate in a follow-on).
- Full agent-network decomposition (qa-draft §8–§10) — adopt incrementally; this sprint only needs the QA-judge for T1 completeness.
- Auto-scheduling go-live — this sprint *earns the right* to schedule; turning on the cron is the next step once SLAs hold.
- The MPC-calendar / RBI-DBIE / peer-z-score statistical detectors (qa-draft §4–§5) — valuable, but the contract doesn't depend on them.

---

## Open items

**Resolved this session (2026-06-26):**
- *Verification* → build the **HTML tool (Workstream V)**; a delegated verifier runs the 30-bank set. (Terminal side-by-side proved poor.)
- *SLA* → confirmed (T1 48h / T2 7d / T3 30d).
- *PM re-publish* → **hold** the 2026-06-11 zip until the Trust Contract is fully populated (gate condition).
- *FB/IBU membership* → resolve in **Phase 0** by deriving exclusions from existing registry flags (`status: wholesale_only` ~20, `no_retail_deposits` ~4, `foreign_currency_not_inr`, gap `wholesale_no_retail` ~23), then a quick manual eyeball of the residual foreign/IBU entries. Mostly data-driven.

**Still genuinely open:**
- Final consequential-set count lands after the Phase 0 membership pass (expect ~205–235 after wholesale/non-retail exclusions).

---

## Risks

- **Scope is ambitious for one sprint.** If it slips, the natural cut line is after Phase 2 (fresh, dated, provenance-surfaced consequential set) — that alone is a materially more trustworthy product. Phases 3–4 (ground truth + gate) can spill to a Sprint 012 tail without losing coherence.
- **The fresh run will surface new execution failures** beyond the known 6; Phase 2 must budget triage time.
- **Azure-OpenAI-only** constraint holds for the judge/QA-judge (qa-draft §8.4) — no Claude.
- **The undated hypothesis may be partly wrong** — some undated banks may be genuine capture failures, not legacy data. Phase 2's confirm-step catches this; budget a hygiene tail.
