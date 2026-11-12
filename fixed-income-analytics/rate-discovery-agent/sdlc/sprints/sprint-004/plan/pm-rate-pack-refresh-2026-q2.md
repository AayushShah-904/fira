# Plan — PM rate-pack refresh (2026-Q2)

> Originated 2026-05-20 mid-Sprint-4 after the 12-bank cloud smoke. Goal
> is to ship a refreshed, broader rates pack to PM. Companion design
> docs go in `sdlc/sprints/sprint-004/design/`; implementation reports
> in `sdlc/sprints/sprint-004/implementation/`.

## Context

Last pack delivered to PM was `pack/dist/rates-pack.json` v1.0.0 dated
**2026-05-14**: 292 banks, 4,806 slabs, but only **146 freshly verified**
in the most-recent refresh — the rest are 30-365 days stale. PM has been
asking for refreshed rates + broader coverage; we've been focused on
refactoring (Sprint 4 Track A: drift detection, partial_silent class,
floor-based retries) and haven't shipped him fresh data.

Goal: deliver a refreshed pack with broader coverage soon — quality
prioritised. Use the new partial_silent safeguards (commits `f8a5953`,
`cd9fa75`) so the pack PM gets cannot contain silent half-data.

**Operator decisions (locked):**
- **Co-op scope**: cover all 32 SUCB + top 100 DCCB + top 100 NSUCB by
  **financial heft (AUM)** — *not* web presence. Plus all banks in the
  ≤42-master categories (FB / FI / HFC / RRB / NSSCB / SSCB / PB / PSB
  / PVB / SFB / LAB / IBU). Cohort ≈ **340-360 banks**.
- **Augmentation**: cloud first; local re-run for any bank flagged
  `discovery_failed`, `extraction_failed`, or `partial_silent`. Also
  compare each bank's new data against its slab counts in the previous
  pack and augment any bank with >20% drop.
- **Quality bar**: every bank in the pack must pass the drift check OR
  be deliberately excluded via marker. No silent half-data.

**Hard precondition**: the in-flight 12-bank smoke (`kgcj6on`, started
2026-05-20 10:10 UTC) must terminate and confirm the new code paths
(floors + partial_silent + pack exclusion) work end-to-end before
running the full pack refresh. If the smoke surfaces a new issue, fix
it first.

## Stages

### Stage 0 — Cohort assembly (operator effort, ≤1 day)

Three sub-files merged into one master cohort:

| File | Content | Source |
|---|---|---|
| `data/cohorts/_small-categories.json` | All banks in master list for PSB / PVB / SFB / PB / FB / RRB / SUCB / NSSCB / SSCB / LAB / FI / IBU / HFC (categories ≤42 banks each, ≈230 total) | Generated programmatically from `data/Indian_Banks_Comprehensive_List_RBI.csv` |
| `data/cohorts/_top-100-dccb-by-aum.json` | 100 largest DCCBs by AUM | **Operator-curated.** Sources: NABARD's annual report on co-operative banking; RBI "Statistical Tables Relating to Banks in India" §IV; RBI "Trend and Progress of Banking in India" annex |
| `data/cohorts/_top-100-nsucb-by-aum.json` | 100 largest NSUCBs by AUM | **Operator-curated.** Sources: NAFCUB annual returns; RBI Statistical Tables §IV |

Cohort file shape (per `scripts/utils/load-cohort.js`):
```json
[
  { "bank_code": "<canonical-slug>", "category": "<...>", "state": "<...>" },
  ...
]
```

Slugs MUST pass through `scripts/utils/slugify.js` — do not hand-compose.

Merge step (small new helper `scripts/build-cohort.js`, ~30 LOC):
```bash
node scripts/build-cohort.js \
  data/cohorts/_small-categories.json \
  data/cohorts/_top-100-dccb-by-aum.json \
  data/cohorts/_top-100-nsucb-by-aum.json \
  > data/cohorts/pm-refresh-2026-q2.json
```

Commit all four files together.

### Stage 1 — Cloud cohort run

```bash
git rev-parse --short=7 HEAD              # current HEAD or descendant
az acr build --registry crbofiarateagentprod \
  --image rate-discovery-agent:<sha> --image rate-discovery-agent:latest \
  --file Dockerfile .
az containerapp job update \
  --name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia \
  --container-name rate-discovery \
  --image crbofiarateagentprod.azurecr.io/rate-discovery-agent:<sha> \
  --args=--cohort=pm-refresh-2026-q2
az containerapp job start \
  --name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia
```

Expected: ~2.5-3 h wall, ~$18-22 AOAI for ~350 banks at the 351-DCCB
runbook's measured ~36 s/bank, ~$0.05/bank. partial_silent markers and
drift retries fire automatically.

### Stage 2 — Identify augmentation list

After cloud terminates, new script `scripts/list-augment-targets.js`
(~80 LOC) scans the cohort and emits a slug-per-line file.

A bank goes into `augment-list.txt` if any of:
1. `output/latest/<slug>.partial_silent.json` exists (drift after retries)
2. `output/latest/<slug>_config.json` missing (cloud discovery failed)
3. `output/latest/<slug>_rates.json` has 0 slabs (extraction failed)
4. **Pack-comparison drift**: new total slab count for the bank (sum of
   variants) is **<80% of the previous pack's count for that bank**.
   Previous pack from `pack/dist/rates-pack.json` (last git-committed
   copy).

Same script also emits a summary report
`sdlc/sprints/sprint-004/implementation/pm-refresh-2026-q2-cloud-tally.md` with:
- Headline pass/fail/partial counts
- Cost + wall time (from per-bank summaries)
- Top 10 banks by slab gain vs previous pack
- Top 10 banks by slab loss vs previous pack
- Augment list size

### Stage 3 — Local augment

```bash
node run-batch.js --banks output/runs/pm-refresh-2026-q2/augment-list.txt
```

Local has no Azure-egress WAF issue, so WAF-blocked banks (ICICI, Axis,
Kotak, BOI-IBU class) should succeed locally. Both pipelines write to
`output/latest/`; local results overwrite cloud's poor data;
partial_silent markers self-clear on next successful run with drift
passing.

Re-run `scripts/list-augment-targets.js`. If `augment-list.txt` shrinks
significantly but still has entries, those are banks where local also
struggled — operator review.

### Stage 4 — Quality gate

Operator review of remaining augment list. Decide per bank:
- **Accept lower count** — `rm output/latest/<slug>.partial_silent.json`;
  pack rebuild includes it.
- **Accept exclusion** — leave the marker; pack excludes the bank.
- **Investigate** — open trace.jsonl, identify a fix, re-run once more.

### Stage 5 — Pack build + delivery

```bash
node pack/build-pack.js
node scripts/compare-pack.js \
  pack/dist/rates-pack.json \
  <(git show HEAD:pack/dist/rates-pack.json)
git add pack/dist/rates-pack.json data/bank-domains.json
git commit -m "pack: refresh 2026-Q2 — <N> banks, <M> slabs"
```

PM-facing deliverable: rates-pack.json + a one-page memo
(`sdlc/sprints/sprint-004/implementation/pm-refresh-2026-q2-memo.md`)
following the template at
`sdlc/sprints/sprint-003/probe/pack-confidence-memo-for-pm.md`, updated
for this refresh.

## Files to create

| Path | Action |
|---|---|
| `data/cohorts/_small-categories.json` | new — generated from RBI CSV (~230 banks) |
| `data/cohorts/_top-100-dccb-by-aum.json` | new — operator-curated |
| `data/cohorts/_top-100-nsucb-by-aum.json` | new — operator-curated |
| `data/cohorts/pm-refresh-2026-q2.json` | new — merged master cohort |
| `scripts/build-cohort.js` | new — ~30 LOC, dedup merger |
| `scripts/list-augment-targets.js` | new — ~80 LOC, scans output/latest + diffs vs prior pack |
| `scripts/compare-pack.js` | new — ~60 LOC, diffs two rates-pack.json files |
| `sdlc/sprints/sprint-004/implementation/pm-refresh-2026-q2-cloud-tally.md` | implementation report — generated by list-augment-targets |
| `sdlc/sprints/sprint-004/implementation/pm-refresh-2026-q2-memo.md` | PM-facing memo |
| `sdlc/sprints/sprint-004/design/pm-refresh-augment-flow.md` | optional design doc explaining cloud→augment→merge mechanics |

No code changes to the agent runtime itself — the new code shipped in
`f8a5953` (partial_silent) and `cd9fa75` (image-baked floors) is what
makes this refresh trustworthy.

## Reuse / existing utilities

- `pack/build-pack.js#loadPartialSilentSlugs` — partial_silent
  exclusion already in place; no change needed.
- `pack/build-pack.js#loadExcludes` reads `_pack_excludes.json` for
  manual triage exclusions; useful in Stage 4.
- `scripts/utils/slugify.js` — canonical slug for every bank_code.
- `scripts/utils/load-cohort.js` — cohort loader the runtime uses.
- `data/Indian_Banks_Comprehensive_List_RBI.csv` — source of truth for
  category counts.
- `scripts/analyze-gaps.js` — gap finder; useful for sanity checking
  the merged cohort against the master list.
- `run-batch.js --banks <file>` — works in CSV mode; for augment we
  pass the bundled CSV + the augment-list.txt filter.
- `data/expected-slab-floors.json` — drives the partial_silent gate.
  Seeded only for 11 banks today. **As cohort grows, operator seeds
  floor entries for major banks** so drift gate fires for them too.
  New banks without floors fall through silently (first-run caveat,
  documented).

## Out of scope (deferred)

- **WAF mitigation for Azure egress** (NAT Gateway / residential
  proxy). Local-augment is the workaround for this delivery. Long-term
  fix is a separate sprint.
- **Per-bank AUM lookup pipeline** — Stage 0 top-100 lists are
  operator-curated. Programmatic AUM lookup is its own initiative.
- **Pack v2 schema change** — last pack v1.0.0; schema bump deferred.

## Verification

1. **Cohort sanity** —
   ```bash
   node run-batch.js --cohort pm-refresh-2026-q2 --dry-run
   ```
   Resolves ~340-360 banks; mode=cohort; no parse errors.

2. **Pre-flight quality** — after Stage 1:
   ```bash
   node scripts/analysis/tally-smoke.js output/latest/
   node scripts/list-augment-targets.js \
     --cohort pm-refresh-2026-q2 \
     --previous-pack pack/dist/rates-pack.json \
     --output output/runs/pm-refresh-2026-q2/augment-list.txt
   ```

3. **Post-augment quality** — same after Stage 3. augment-list shrinks
   substantially.

4. **Pack diff** — Stage 5's `compare-pack.js` shows net bank delta,
   per-bank slab gains > losses on average, no bank both
   partial_silent AND in pack.

5. **PM-facing**:
   - rates-pack.json valid JSON
   - Spot-check 3 banks against official rate pages (operator pulls
     each URL in browser)
   - Memo template filled

## Pass criteria for delivery

- Every cohort bank is either (a) in the pack with passing drift, or
  (b) explicitly excluded with documented reason; count of excluded
  banks < 10% of cohort.
- Pack contains at least the same banks as last delivery, modulo
  documented exclusions.
- Per-bank slab counts ≥ 80% of last pack's count for ≥ 90% of shared
  banks.
- One-page memo for PM ready, signed off by operator.

## Open items requiring operator input

1. **AUM-ranked DCCB / NSUCB lists** — Stage 0 blocker. Estimated 2-4 h
   operator time. Sources cited above.
2. **HFC inclusion / count** — quick scan of RBI CSV then decide.
3. **Floor seeding for new top-100 banks** — drift gate is only as
   strong as `data/expected-slab-floors.json`. For first-time runs,
   floors absent → partial_silent silent. Operator plans a follow-up
   to seed floors after this delivery using its measured slab counts
   as baseline. Not a blocker for v2 pack.

## Related work

- Sprint 4 Track A code work (drift detection, partial_silent class)
  — commits `f8a5953`, `cd9fa75`; tests in
  `tests/lib/tier-router-drift.test.js`,
  `tests/lib/failure-classifier.test.js`.
- 12-bank smoke (`m6nrj6o`, partial; `kgcj6on`, in-flight at time of
  plan) — validates the new code before this refresh kicks off. See
  `sdlc/sprints/sprint-004/implementation/cohort-smoke-12-cloud-*.md`
  for tally reports.
- Last delivery memo template:
  `sdlc/sprints/sprint-003/probe/pack-confidence-memo-for-pm.md`.
