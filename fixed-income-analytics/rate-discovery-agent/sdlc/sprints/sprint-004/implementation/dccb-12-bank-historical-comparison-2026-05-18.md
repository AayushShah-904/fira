# DCCB 12-bank historical comparison (2026-05-18)

One-time backward look. The Sprint 3 Phase B 12-bank set (`scripts/run-phaseB-rerun.js`'s SLUGS list — all DCCB + 1 SUCB) was the kill-switch / slug-discipline validation cohort for Sprint 002. Operator clarified on 2026-05-18 that DCCB is second-from-last in the top-200 priority ordering, so it should not be the Sprint 4 smoke target. We're capturing the current state of these 12 banks once, here, then moving on to a top-200-priority-weighted cohort (`data/cohorts/top-12.json`) for the actual Sprint 4 rungs.

The cohort file is preserved at `data/cohorts/phase-b-12-historical.json` for the trail.

## Comparison: Sprint 2 cloud → Sprint 3 local (current `output/latest/`)

| Bank | Sprint 2 cloud (slabs) | Sprint 3 local current | Trajectory |
|---|---:|---:|---|
| `agra-zilla-sahakari-bank-ltd` | 0 | **9** | ✓ recovered |
| `azamgarh-district-central-co-operative-bank-ltd` | 0 | 0 | unchanged |
| `bhatinda-central-co-operative-bank-ltd` | 0 | **12** | ✓ recovered |
| `dhanbad-district-central-co-operative-bank-ltd` | 0 | 0 | unchanged |
| `gondia-district-central-co-operative-bank-ltd` | 0 | 0 | unchanged |
| `indore-premier-co-operative-bank-ltd` (SUCB) | 0 | **8** | ✓ recovered |
| `angul-united-central-co-operative-bank-ltd` | 0 | **12** | ✓ recovered (was operator-curated previously) |
| `banswara-central-co-operative-bank-ltd` | 45 | 0 | ⚠ cloud over-extraction (wrong page); local correctly rejects |
| `barmer-central-co-operative-bank-ltd` | 45 | 0 | ⚠ same as banswara — cloud was wrong, local rejects |
| `nizamabad-district-co-operative-central-bank-ltd` | 0 | **12** | ✓ recovered |
| `bankura-district-central-co-operative-bank-ltd` | 0 | 0 | classified as "no rates expected" by Sprint 2 |
| `ajmer-central-co-operative-bank-ltd` | 0 | 0 | unchanged |

**Tallies:**
- 5 trustworthy successes (42 %): agra-zilla 9, bhatinda 12, indore-premier 8, angul 12, nizamabad 12 = **53 slabs**.
- 2 net data-quality wins where cloud had emitted 45 false-positive slabs each (90 total) — local correctly rejects. These were from misextraction off a portal page; Sprint 3's anti-fabrication contract removed that class.
- 5 still failing — all 0 slabs in both Sprint 2 cloud and Sprint 3 local. Root causes (per `../../sprint-002/implementation/dccb-failure-analysis.md`): no website discoverable, or JS-heavy state-coop portal that Playwright fallback couldn't extract from.

## Interpretation

The Sprint 3 work materially improved this set:
- 5 / 12 recovered from 0 to a real slab count (42 % success rate where Sprint 2 cloud had 0 % real success).
- Two cloud false-positives correctly rejected — Sprint 3's anti-fabrication contract did its job here too.
- 5 hard failures remain. These are not fixable by parser / chunker improvements (Sprint 3's class of fixes); they need either operator curation or an alternative discovery path (Google search via Bing connector, state government registries, etc.).

## What this comparison does NOT tell us

DCCBs are low-priority for Sprint 4 (second-from-last in the top-200 ordering, behind LABs). 42 % success on a low-priority cohort doesn't predict performance on PSB / PVB / SFB / FB / IBU — which are the categories the Sprint 4 cloud run is being built to serve. **No Sprint 4 commit decision should turn on this 42 % number.**

The actual Sprint 4 smoke target is `data/cohorts/top-12.json` (3 PSB + 4 PVB + 2 SFB + 1 FB + 1 IBU + 1 SUCB = 12). Rung 2 (local) and Rung 3 (cloud) are scoped against that, not against this DCCB cohort.

## Action items

- [x] Capture this comparison (this doc).
- [x] Rename `data/cohorts/phase-b-12.json` → `phase-b-12-historical.json` so the file remains in-repo but won't be picked accidentally by `--cohort phase-b-12`.
- [ ] (Sprint 5+ candidate) Re-run the 5 hard-failure DCCBs after a discovery-path improvement (operator-curated, state-portal scraping, or alternative search backend).
- [ ] (Sprint 5+ candidate) The remaining 286 DCCBs (we have 30 in top-200 plus the broader 1900-bank tail) get their own dedicated smoke later. Don't combine with the top-12.

## Provenance

- Sprint 2 cloud baseline: `../../sprint-002/implementation/dccb-failure-analysis.md`.
- Sprint 3 local current: read directly from `output/latest/*_rates.json` files on 2026-05-18.
- DCCB cohort file: `data/cohorts/phase-b-12-historical.json` (renamed from `phase-b-12.json`; same 12 slugs as `scripts/run-phaseB-rerun.js`'s SLUGS list).
