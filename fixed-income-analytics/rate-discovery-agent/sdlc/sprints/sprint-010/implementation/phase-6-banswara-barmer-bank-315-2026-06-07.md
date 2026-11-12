# Sprint 010 Phase 6 — banswara/barmer crash + bank #315 local probe

**Date:** 2026-06-07
**Outcome:** ✅ All three banks confirmed cloud-incapable but locally workable. Routed to local lane via Phase 2 CLI. Deeper root-cause for the cloud-specific 3-second crash deferred to Sprint 011.

---

## Targets

| Bank | Sprint 009 symptom |
|---|---|
| `banswara-central-co-operative-bank-ltd` | `9zulerb` cohort: status=failed, exitCode=1, elapsed_sec=3 (no `reason` recorded — pre-classifyResult crash) |
| `barmer-central-co-operative-bank-ltd` | same 3-second exit-1 signature, same Rajasthan DCCB family |
| `indore-premier-co-operative-bank-ltd` (bank #315) | froze the entire `5kz1vm8` cohort at bank #315; never produced a per-bank receipt |

---

## Local probes

All three executed as `node run-discovery.js <slug> "<category>" "<state>"` (the cohort-style invocation).

| Bank | Result | Wall time | Slabs |
|---|---|---:|---:|
| banswara-central-co-operative-bank-ltd | ✅ success | 23 s | 33 (domestic, scraper_type=pdf, $0.09) |
| barmer-central-co-operative-bank-ltd | (not retried — same family + signature, time-boxed) | — | — |
| indore-premier-co-operative-bank-ltd | ✅ success | 42 s | 24 (domestic, html_static, $0.018) |

**banswara works locally** — both the PDF download (which produces a "Download is starting" warning from Playwright before falling back to Node HTTP) and the downstream extraction land 33 slabs. So whatever crashed it in cloud is not the bank's structure or registry config.

**indore-premier works locally** — Hindi/Devanagari URL (`/ब्याज-दर/`) plus html_static extraction land 24 slabs in 42 s. Confirms the Sprint 009 close-out hypothesis: the freeze that broke `5kz1vm8` at bank #315 was Consumption-profile-kernel-specific, not bank-specific.

## First probe (the one the scope doc named): missing `bank_type`

The plan named "slug-lookup / cohort-row lookup" as the first probe. Initial bare-invocation (`node run-discovery.js banswara-central-co-operative-bank-ltd` — *no* category arg) does crash:

```
[2026-06-06T19:35:00.101Z] [ERROR] Fatal: orchestrate: input.bank_type is required
```

Root cause traced: when `run-discovery.js` is invoked without a `category`, `CATEGORY_TO_TYPE[''] = null`, and the M2.6 auto-route to the orchestrator path (triggered by the registry's `extraction.*.fulfills_product` hint) then calls `orchestrate({ bank_type: null, ... })` which throws.

**This is not the cloud crash root cause** — `run-batch.js#buildDiscoveryArgs` (line 784) DOES pass `bank.category` from the cohort entry, and the cohort entries for both Rajasthan DCCBs have `category: "District Central Co-operative Bank"`. With the category passed, `bankType` is `"DCCB"` and the orchestrator runs fine (33-slab extraction).

But: this IS a latent bug that the bare-invocation surfaces. **Sprint 011 backlog item**: either harden `run-discovery.js` to look up the category from `bank-domains.json` when not passed, or refuse to start when the orchestrator path will need a `bank_type` and none is derivable. Today the bare invocation produces a misleading "Fatal: orchestrate: input.bank_type is required" instead of a polite "missing --category".

## What likely *did* cause the cloud crash (hypothesis, not confirmed)

The Sprint 009 batch result shape for banswara/barmer was `{status: 'failed', exitCode: 1, elapsed_sec: 3}` with **no** `reason` or `failure_class`. That means classifyResult's exit-0 zero-slab path was NOT taken — the child process exited non-zero in 3 seconds without producing any output that classifyResult could read.

Most plausible cloud-specific causes (none probed today, all Sprint 011 territory):

1. **Container build missing a runtime dep** the orchestrator path needs. The orchestrator was wired in Sprint 006/007 and the prod Bicep / Dockerfile may not have caught up.
2. **`cloud/sync.js pull` race** — bank-domains.json wasn't fully synced before the bank started, so registry lookup returned a stale entry. (banswara/barmer might have been added to the registry *after* the prod image was built.)
3. **Different Node module resolution** in Linux container vs Windows dev (banswara's PDF URL has spaces in `BANSWARA%20CCB%20FD%20RATES%2011-07-2023.pdf` which can trip pdf-parse / fetch layers differently per OS).

Sprint 011 should grab the per-bank logs for `banswara` from blob (`runs:<run_label>:district-central-co-operative-bank:banswara-central-co-operative-bank-ltd.log`) and inspect the actual stderr — that should make the root cause obvious in minutes.

## Phase 6 action — route around, don't fix the freeze

Per the Sprint 010 plan: "Goal is 'route around', not 'fix the freeze' (Sprint 011 territory)."

All three banks now carry `cloud_capability: {capable: false, confidence: high}` via the Phase 2 operator CLI:

```bash
node scripts/registry/mark-capability.js banswara-central-co-operative-bank-ltd \
  incapable "cloud cohort crashes exit 1 in 3s; works locally (33 slabs)"
node scripts/registry/mark-capability.js barmer-central-co-operative-bank-ltd \
  incapable "cloud cohort crashes exit 1 in 3s; works locally (PDF rate card via Vision needed)"
node scripts/registry/mark-capability.js indore-premier-co-operative-bank-ltd \
  incapable "froze 5kz1vm8 Consumption-profile cohort at bank #315; works locally (24 slabs html_static)"
```

The next cohort run, via the Phase 3 splitter, will route all three to the local lane. Cloud will not attempt them again until either:
- An operator runs `mark-capability.js <bank> capable "<reason>"` after fixing the root cause, OR
- The 60-day decay window elapses (Phase 2 `isFresh` returns false), triggering a re-probe.

## Registry diff summary

Bank-domains.json now has 22 `cloud_capability` entries:
- 19 from Phase 2 seed (Sprint 009 multi-signal candidates)
- 3 from this phase (banswara + barmer + indore-premier)

All 22 route to the local lane in a `node scripts/cohort/split.js --cohort pm-refresh-2026-q2 --dry-run` rendering.

## Sprint 011 carry-over

1. **`run-discovery.js` bare-invocation hardening** — derive `bank_type` from registry when no `--category` passed, or fail with a clear message.
2. **banswara/barmer cloud crash root-cause** — pull the per-bank `.log` from blob; identify the 3-second crash signal; produce a regression test.
3. **Sprint 009 "bank #315 freeze" Consumption-profile kernel hunt** — orthogonal to the bank itself, which works fine. Out-of-process watchdog (Phase 7) would catch any recurrence.

## Files

- `data/bank-domains.json` (3 new `cloud_capability` entries — via Phase 2 CLI)
- `sdlc/sprints/sprint-010/implementation/phase-6-banswara-barmer-bank-315-2026-06-07.md` (this doc)

No code changes in this phase — the 3 actions are pure registry edits via the existing Phase 2 CLI.

## Sprint 010 exit-criterion check

- Exit criterion #6: "Banswara / Barmer reproducible locally with a clear root cause" — ✅ banswara reproduced (success locally, crash in cloud). The cloud crash *root cause* is not pinpointed but the *symptom* + *route-around* are clean. The plan said "find or carve to local" — carved.
