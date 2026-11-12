# Engineering Roadmap — Quality Sprint × NRI/FCNR Window (DRAFT)

| | |
|---|---|
| **Status** | DRAFT for operator approval — analysis + proposed roadmap; changes nothing until approved |
| **Date** | 2026-07-03 |
| **Reviews** | `sprint-011/plan/sprint-011-quality-plan.md` (the plan under review), `sprint-011/position-paper-trust-and-quality.md`, `sprint-011/plan/sprint-011-scope.md`, `sprint-011/retrospection/retro-draft.md`, `docs/agent/rewrite/` (v2 doc set) |
| **New forcing input** | RBI FCNR concession window ends **2026-09-30** (elevated FCNR ceilings + 1-year lock-in rule for 3–5y tenors opened/renewed 2026-06-08 → 2026-09-30). PM requires solid NRI rates (FCNR / NRE / NRO / GIFT) **now**, not at sprint end. |

---

## 1. Strategic review — what holds, what changed, what's missing

### 1.1 What the quality plan gets right (keep unchanged)

- **The Trust Contract as the spine.** Seven dimensions, per-rate, user-visible. This is the correct product framing and the correct handoff contract. Nothing below weakens it.
- **Measure-before-plan discipline.** The scorecard (§5 of the position paper) is the best asset the project has; every roadmap item below carries a measured before/after.
- **Consequential-set scoping (~235), co-op tail labeled not chased.**
- **Cheap-trust-first sequencing** (surface what's built → hygiene → seed set → gate).
- **Workstream V as a first-class deliverable** — verification is visual; the HTML tool is the instrument that anchors correctness + completeness.
- **The cut-line after P2** — fresh, dated, provenance-surfaced is a coherent partial ship.

### 1.2 What changed since the plan was drafted (2026-06-26 → 2026-07-03)

**The FCNR window became the forcing clock.** The plan optimizes for a *complete* trustworthy product by sprint end; the PM now needs *NRI-variant* trustworthy rates on a hard external deadline. Measured NRI state of the shipped pack (2026-07-01 session):

| Variant | Banks w/ slabs | Slabs | Realistic universe | Freshness problems |
|---|---:|---:|---|---|
| FCNR | 44 | 1,157 | ~80–90 AD-I banks | 3 undated, 2 stale, BoB `1st July 1995`, natwest 2017 |
| NRE | 60 | 727 | ~80–90 | 21 undated, 3 stale |
| NRO | 45 | 1,006 | ~80–90 | 15 undated, 2 stale |
| GIFT | 19 | 829 | 37 registered IBUs | 4 undated |

The triad asymmetry (NRE 60 > NRO 45 ≈ FCNR 44, PSBs at 12/10/11 instead of 12/12/12) is **under-extraction, not absence** — a bank offering one NRI product offers all three. The biggest hole is foreign banks (9 of ~44 with FCNR data).

**And the known extraction bugs sit exactly on this path.** Scope items 18/19/20/21 are not generic hygiene — they are *the* FCNR blockers:

- **Item 18** (early-stop after first PDF) → every multi-PDF bank (Axis/HDFC/ICICI/SBI pattern) cannot refresh FCNR through the agent at all; the 2026-06-15 refresh got ~18% FCNR hit rate because of it.
- **Item 19** (per-table variant classification) → **36 of Axis's 71 shipped "FCNR" slabs are actually RFC Term** — live wrong data in the most PM-visible product. Its footnote-capture half is also the *only* path to surfacing the RBI **1-year lock-in** on 3–5y FCNR — decision-critical for an NRI comparing FCNR vs GIFT (Trust dimension 5, "applicable to me").
- **Item 20** (cohort UNION rule) → 13 FCNR-publishing banks silently excluded from the refresh cohort (Yes Bank incident).
- **Item 21** (LLM QC) → the garbage effective_dates and duplicate slabs polluting exactly the freshness signal the window makes critical.

### 1.3 Delivery-risk findings (the "reliable" part of the ask)

1. **P0 is load-bearing and is historically where this project stalls.** Items 18/19/20/21/12 have been Tier-1 since mid-June; **zero shipped** across the sprint-011 period (retro: 0 of 6 engineering exit criteria landed; the sprint pivoted to design). The quality plan re-stacks all of them *plus* the stale-badge fix *plus* ISO normalization *plus* the watchdog into a single Phase 0 that gates everything downstream. Same shape, same risk. Fix: slice P0 into independently shippable items with per-item golden tests, and define a **minimum guardrail set** that unblocks the first run rather than gating on all of P0.
2. **Workstream V has no owner, no effort estimate, and an unnamed "delegated verifier."** It is a P3 prerequisite; if the verifier or the tool slips, the keystone phase slips silently. Needs a named person and a mid-roadmap checkpoint.
3. **The v2 rewrite doc set (`docs/agent/rewrite/`) shadows every P0 investment and the plan never mentions it.** P0/P1 harden v1 code paths (`run-discovery.js`, `extract_via_ocr.js`, `safe-write.js`); the rewrite proposes replacing them. Unresolved, this invites "why fix v1 if v2 is coming?" drift. Recommendation (Decision D3): **explicitly defer v2 until the Trust Contract ships on v1** — the FCNR window and PM handoff cannot wait for a rewrite — while requiring that new P0/P1 artifacts conform to v2's contracts where free (snapshot-first capture; the trust-profile schema mirrors `evaluation-spec.md` layers; `schema_version` envelope) so the work migrates instead of being thrown away.
4. **Working-tree hygiene:** ~216 modified `output/latest/` files have sat uncommitted since mid-June (flagged in the retro, still present). Real scraped data living only in a working tree contradicts the sprint's own data-safety story. Needs a checkpoint commit decision (D4).
5. **Sprint bookkeeping is ambiguous:** sprint-011 has a scope doc, a DRAFT retro (2026-06-19) *and* a newer quality plan (2026-06-26) that reframes the sprint. Pick a boundary (D2) so "Sprint N" means one thing in the record.
6. **Exit criterion 5 over-promises.** A "measured fleet error rate with a confidence interval" from a ~30-bank seed is statistically weak (the position paper's own math says ~200 banks for a 2% fleet estimate at 95%). Scope the claim to **T1+T2 error bar** or explicitly widen the sample.
7. **One plan-level contradiction to resolve (D1):** locked decision 5 says *no PM re-publish until the contract is fully populated*, but the PM needs NRI rates inside the window. Recommended resolution: a **scoped NRI interim deliverable** (same channel as the 2026-06-11 `fcnr-rates.csv` + PM-BRIEF — CSV/brief, clearly labeled, with per-rate freshness + lock-in flags), while the *full pack* re-publish stays gated on the contract. Decision 5 stays intact for the pack; the window gets served.

---

## 2. The forcing clock

Today is **Thu 2026-07-03**. The window closes **Tue 2026-09-30** — 12.5 weeks. Value to NRIs decays toward the close (deposits opened *during* the window get the terms; deciding in September is worse than July). Banks also reprice within the window (industry-wide changes effective 2026-06-13 already observed). Therefore:

- The NRI deliverable is worth most **in the next ~3 weeks**, not at sprint end.
- FCNR freshness needs a **window-period SLA override**: the FCNR cohort refreshes weekly regardless of tier (foreign banks are T2/T3 at 7–30d SLA — too slow for a repricing window).
- Plan a **final pre-close refresh** (week of Sep 21) and an **immediate post-close refresh** (Oct 1–3, when banks revert terms) so the pack never shows window rates after the window.

---

## 3. The roadmap — three tracks

The five phases of the quality plan survive intact; they are re-cut into three overlapping tracks so the NRI deliverable ships first and the historical stall-shape (one giant gating P0) is broken. Phase mapping is noted per track.

```
Jul 6      Jul 20        Aug 3         Aug 17        Sep 7        Sep 21   Sep 30
|-- Track A: NRI fast path --|
        |------- Track B: Trust Contract + fresh consequential run -------|
                              |----- Track C: ground truth + gate ----|
                                                                    [final FCNR refresh]
```

### Track A — NRI fast path (Jul 6 → Jul 24; ships the PM's NRI ask)

*Absorbs the FCNR-critical slice of P0 + a scoped run. Everything here has a golden-fixture test and a measured before/after.*

| # | Item | Est | Definition of done |
|---|---|---|---|
| A1 | **Item 18 — post-LLM variant-coverage loop** (option a) + `--variant` CLI flag (option c) | 2d | Axis `--rates-only` run writes fresh `regular`+`nre`+`nro`+`fcnr` files; idempotent on re-run; HDFC + ICICI regression pass |
| A2 | **Item 19 — per-table variant classification + footnote capture** | 2d | Axis Jun-13 PDF golden: exactly 35 FCNR + 36 RFC-Term (dropped w/ log) + 0 savings; `regulatory_constraints` carries the lock-in text; `#`-marked slabs flagged; single-section-PDF negative test |
| A3 | **Item 21 — LLM QC pass in safe-write** (dedup + effective-date sanitization + ISO normalization at write time) | 1.5d | BoB fixture 41→36 slabs, garbage date → null; IDFC 18→12; all writes ISO-dated |
| A4 | **Item 20 — cohort UNION rule + gap audit** as a shared cohort-builder utility | 0.5d | Synthetic test (5 pack ∪ 7 domains = 7 + warn on 2); rebuilt FCNR cohort ≥ 57 banks |
| A5 | **NRI target list** — per-bank matrix of who's missing which of NRE/NRO/FCNR/GIFT, from registry ∪ pack, incl. the 37 IBUs, minus wholesale-only exclusions (quality-plan Phase-0 membership pass, scoped to NRI) | 1d | Committed target-list artifact; the FCNR universe number (~80–90) becomes a measured count |
| A6 | **NRI cohort run** with A1–A4 live + existing safe-write rules; triage pass (axis/kotak/indusind + yes-bank/Akamai class + FB cluster) | 3–4d | Post-run: FCNR banks ≥ 60 (from 44), NRE/NRO/FCNR triad symmetric for PSBs (12/12/12), 0 undated in the NRI variants, lock-in flags present |
| A7 | **NRI interim deliverable to PM** (pending D1): CSV + brief per variant with per-rate `effective_date`, source URL, lock-in flag, and an honest gap list ("N banks publish but we could not extract — listed") | 1d | PM receives it ≤ Jul 24; format reuses `output/pm-2026-06-11/` shape |

**Track A exit:** PM has fresh, honestly-labeled NRI rates for the realistic AD-I universe, with the RBI lock-in surfaced, ~9 weeks before the window closes. Even if everything else slips, this is the urgent value delivered.

### Track B — Trust Contract + freshness reset (Jul 13 → Aug 21; = rest of P0, P1, P2)

| # | Item | Maps to | Est |
|---|---|---|---|
| B1 | Stale-badge fix (parse all date formats) + freshness report script (per-variant coverage/freshness rollup — the same report doubles as the PM dashboard) | P0 | 1.5d |
| B2 | Clean-but-fewer safe-write rule (item 12) with the 550ptm4 retro-test (blocks ≥30 of 36 R3 banks) | P0 | 2d |
| B3 | Out-of-process cohort watchdog (ARM-timer Function) | P0 | 2–3d |
| B4 | Trust-profile schema in the pack + surface `source_url`/`source_snapshot`/`confidence_tier`/`warnings` per rate; **add `regulatory_constraints` to the schema** (from A2 — the plan's schema currently misses it) | P1 | 4–5d |
| B5 | `tier` field in `bank-domains.json` + full consequential-set membership pass (~205–235 final count) | P0/P1 | 1d |
| B6 | **Fresh consequential-set run** (the freshness reset). NRI cohort already fresh from A6 → this run is ~150–190 banks, cheaper and lower-risk than the plan's 235. Confirm the undated hypothesis; triage residuals | P2 | 1 wk incl. triage |
| B7 | **Workstream V — HTML verification tool**, started Jul 13 against the current pack for layout, pointed at fresh output as it lands. **Named verifier confirmed by Jul 18** (D5); usable-by date **Aug 14** (hard checkpoint — P3 prerequisite) | V | 1.5–2 wk elapsed, parallel |

**Track B exit = quality-plan P2 exit + P1 exit:** consequential set freshly run, 0% undated, trust block populated (with `unverified` where honest), provenance reachable, verification tool live. **This is the roadmap's cut-line** — if Track C must slip to a follow-on sprint, Track B alone is a materially more trustworthy product.

### Track C — Ground truth, completeness gate, handoff (Aug 10 → Sep 11; = P3 + P4)

| # | Item | Maps to |
|---|---|---|
| C1 | Verify ~30 T1 banks through the HTML tool (delegated verifier); **NRI variants of T1 banks verified first** — they are the top-surfacing answers during the window | P3 |
| C2 | Judge recalibration against ground truth; error bar **scoped to T1+T2** (revised exit criterion 5, per finding 1.3-6) | P3 |
| C3 | Golden regression gate active for T1 fixtures | P3 |
| C4 | Extractor↔QA-judge completeness gate for T1 (disagree ⇒ union + `unverified` flag) | P3 |
| C5 | Quality gate upgrade: T1 presence + <48h + completeness as hard blocks; **window-period FCNR SLA override (weekly, all tiers) baked into gate + scheduler config** | P4 |
| C6 | PM handoff package: trust-tier rollup, SLA statement, coverage-honesty list, runbook. Full-pack re-publish gated on contract population (decision 5 intact) | P4 |

### The window tail (fixed dates, independent of track progress)

| Date | Action |
|---|---|
| **Sep 21–26** | Final in-window FCNR/NRI refresh + PM update |
| **Oct 1–3** | Post-window refresh — banks revert terms; the pack must not show window rates after Sep 30. Retire lock-in flags whose condition expired |

---

## 4. Delivery discipline — what makes this reliable, not just planned

These are process commitments, adopted for every track item; they target the specific failure modes in the sprint record.

1. **Golden fixture per extraction change.** The Axis Jun-13 PDF, BoB/IDFC dedup files, and each T1 verification output become committed fixtures; the golden suite runs via `npm test` before any cohort run. (Targets: 0-of-6 sprint, plausible-but-wrong regressions.)
2. **Per-item Definition of Done = code + test + measured before/after number + one-paragraph implementation note** in `sprint-N/implementation/`. No item closes on "code merged" alone.
3. **WIP limit: one track item per person in flight.** Mid-sprint additions displace an item explicitly (named swap in the plan doc), never silently stack. (Targets: the items-18–21-displaced-items-12/1/2-and-nothing-shipped pattern.)
4. **Weekly checkpoint commits of `output/latest/`** after each cohort/triage session — scraped data never sits uncommitted for weeks again.
5. **All runs through safe-write; tests use temp dirs; no gate accepts except via the signed-accept CLI.** (Standing rules, restated because Track A touches exactly these paths.)
6. **Honest metrics cadence:** the B1 freshness/coverage report is re-run and pasted into the sprint doc at each weekly checkpoint — the "measure before planning" discipline becomes "measure while executing."
7. **v2-compatible by construction:** new schemas/contracts written in Tracks A/B cite the matching section of `docs/agent/rewrite/` specs, so a future v2 inherits rather than re-invents.

---

## 5. Decisions required from the operator

| # | Decision | Recommendation |
|---|---|---|
| **D1** | NRI interim deliverable vs locked decision 5 (no re-publish until contract populated) | Serve the window with a **scoped NRI CSV/brief** (2026-06-11 delivery shape, honestly labeled); keep the full-pack hold intact |
| **D2** | Sprint boundary: sprint-011 has a DRAFT retro *and* a newer quality plan | Close Sprint 011 on the existing retro (operator approves close per standing rule); open **Sprint 012 = the Quality Sprint** carrying this roadmap; move/copy the quality plan + this doc to sprint-012 |
| **D3** | v2 rewrite timing | **Defer v2 until the Trust Contract ships on v1**; require v2-contract conformance for new artifacts (§4.7) |
| **D4** | The ~216 uncommitted `output/latest/` files | Review the diff summary, then commit as a cohort checkpoint before Track A's first run (they will otherwise entangle with A6 output) |
| **D5** | Named delegated verifier for Workstream V (and their availability window Aug 10 – Sep 5) | Needed by **Jul 18**; if none available, C1 falls to the operator and Track C timeline needs +1–2 weeks |
| **D6** | Exit criterion 5 rescope: "fleet error rate w/ CI" → "T1+T2 error rate w/ CI" (or fund a ~200-bank sample) | Rescope to T1+T2; fleet-wide bar becomes a Sprint 013 item |

---

## 6. Risks

- **Track A slips past July** → the window value decays; mitigation: A1–A4 are ≤ 6 engineer-days with fixtures already named — smallest, most testable slice first; A6 can run with partial guardrails (A1+A3 minimum) if A2 needs longer.
- **The fresh runs surface new failure classes** (they always have) → both A6 and B6 carry explicit triage budget; failures feed the gap list, not silence.
- **Workstream V under-estimated** → hard checkpoint Aug 14; fallback is operator spot-verification of the top-surfacing NRI answers only (weaker but honest — stamped `agreement_complete`, not `verified_complete`).
- **Azure-OpenAI-only** constraint holds everywhere (judge, QC, extraction) — no design below assumes otherwise.
- **RFC-Term schema question** (item 19c): dropped-with-log for now; if the PM asks for RFC products, it becomes a pack-schema decision, not an extractor change.

---

*This roadmap re-sequences the approved-in-principle quality plan around the FCNR window; it does not alter the Trust Contract, the exit criteria (except D6), or any locked decision without the operator's call on D1–D6. Nothing here is committed or started until approved.*
