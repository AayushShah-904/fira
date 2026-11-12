# Failure-class taxonomy + run analysis (v2 — two-tier)

**Status:** DRAFT v2 (2026-05-10) — supersedes v1's single-axis 10-enum. Decision pending.
**Sprint:** 002
**Owner:** Samir Joshi
**Implements:** Sprint 002 scope item #2 (`Add failure_class enum + _run_analysis.json index`)
**Depends on:** [ADR-011](../../../decisions/ADR-011-additive-state-semantics.md) (DECIDED 2026-05-10) — adds the per-run markdown report.
**Spawns:** new Sprint 002 item (TBD #) — agent-side phase-handoff change so the agent emits partial configs at phase boundaries. Without that change, the `partial_success` cohort that *should* be "website found, rate page not" stays empty in practice. Tracked separately because it's a prompt + tool-flow change with its own scope.

## Why this exists

The Sprint 001 DCCB run had 17 of 351 banks (5%) produce extracted rates with confidence ≥ medium. The remaining 333 each have a `summary.json` with free-text reasons. v1 of this design proposed a single `failure_class` enum with 10 values that conflated three independent axes — what happened during website discovery, rate-page discovery, and extraction — into one namespace. That collapsed actionable cohorts (e.g., "website was reachable but agent didn't commit a config" — 113 banks!) into the `website_unreachable` bucket where they got triaged as if they had no web presence at all.

v2 fixes this by tracking each phase's outcome independently (Tier 1) and rolling up to a small headline label (Tier 2). The headline label drives the run report; the phase outcomes are how the operator drills in.

## Tier 1 — `phase_outcomes` (three independent enums)

Stored on each per-bank `summary.json` as a single object:

```json
"phase_outcomes": {
  "website":    "found_committed" | "reachable_uncommitted" | "candidates_all_failed" | "no_candidates",
  "rate_page":  "found" | "not_found" | "not_attempted",
  "extraction": "succeeded" | "succeeded_low_confidence" | "failed" | "not_attempted"
}
```

### Phase 1 — `website` (4 values)

| Value | Meaning | Primary signal |
|---|---|---|
| `found_committed` | Agent decided on a bank website and wrote it into the config | `_config.json` exists with non-null `website` field |
| `reachable_uncommitted` | At least one fetch returned successfully, but agent never committed a website to a config | ≥1 `tool_calls[]` entry with `is_error: false` for a fetch tool, AND no config produced (or config has no `website`) |
| `candidates_all_failed` | Agent attempted fetches but every one errored | ≥1 fetch tool call, all with `is_error: true` |
| `no_candidates` | Agent never even fetched a candidate URL | Zero fetch tool calls in the final summary |

### Phase 2 — `rate_page` (3 values)

| Value | Meaning | Primary signal |
|---|---|---|
| `found` | Config has a non-null `rate_page_urls.fd` | `config.rate_page_urls.fd` is a string |
| `not_found` | Config exists but no rate URL captured | Config exists, `rate_page_urls.fd` is null |
| `not_attempted` | No config at all → Phase 2 never ran | `_config.json` does not exist |

### Phase 3 — `extraction` (4 values)

| Value | Meaning | Primary signal |
|---|---|---|
| `succeeded` | Rates extracted with confidence ≥ medium | `rate_slabs.length ≥ 1` AND `extraction_confidence ∈ {high, medium, null}` (null treated as "not flagged low") |
| `succeeded_low_confidence` | Rates extracted but agent flagged uncertainty | `rate_slabs.length ≥ 1` AND `extraction_confidence ∈ {low, none}` |
| `failed` | Rates file written but no slabs (or invalid) | `rate_slabs.length === 0` OR rates file invalid JSON |
| `not_attempted` | No rates file → extraction never ran | `_rates.json` does not exist |

Each axis is independent. There are 4 × 3 × 4 = 48 combinatorially possible triples; in practice most map to predictable Tier-2 values (table below). New phase outcomes can be added to any one axis without restructuring the others.

## Tier 2 — `failure_class` (Option A — 6 values + unclassified fallback)

Derived from the phase_outcomes triple. One per bank, used as the headline label in run reports.

| Value | Meaning | Operator action |
|---|---|---|
| `success` | Full pipeline OK (Phase 3 succeeded with any confidence) | Spot-check low-confidence variants |
| `partial_success` | Pipeline made forward progress but didn't complete (website found / rate page not, or fetched OK / didn't commit) | Inspect `phase_outcomes` to know what to do — find rate URL, refine prompt, etc. |
| `discovery_failed` | Never landed a website (no successful fetches) | Likely no web presence — pre-classify in registry as `no_website_known` |
| `extraction_failed` | Website + rate page found, but extraction broke | Inspect rate page; could be page-shape regression |
| `no_rates_expected` | Manual classification (e.g., payments bank, no FD product) | None — terminal classification |
| `agent_error` | Runtime failure (LLM API error, max-turns, fatal exception) | Infra / retry |
| `unclassified` | Fallback; classifier gap | Fix classifier |

### Mapping (tier-1 triple → tier-2 label)

Deterministic — every observed triple resolves to exactly one tier-2 value.

| website | rate_page | extraction | scraper_type / notes | → failure_class |
|---|---|---|---|---|
| (any) | (any) | (any) | `agentResult.success === false` | `agent_error` |
| (any) | (any) | (any) | `manual` AND notes match `/no FD\|fixed deposit\|payments bank/i` | `no_rates_expected` |
| `found_committed` | `found` | `succeeded` or `succeeded_low_confidence` | — | `success` |
| `found_committed` | `found` | `failed` | — | `extraction_failed` |
| `found_committed` | `not_found` | (any) | — | `partial_success` |
| `reachable_uncommitted` | (any) | (any) | — | `partial_success` |
| `candidates_all_failed` | n/a | n/a | — | `discovery_failed` |
| `no_candidates` | n/a | n/a | — | `discovery_failed` |
| else | — | — | — | `unclassified` |

Note: the "rate_page found + extraction not_attempted" combination is unexpected (config wrote a rate URL but the agent never tried to extract). It falls to `unclassified` — a guard rail.

## Classification logic (where & how)

Implement as `lib/failure-classifier.js` exporting `classifyResult(ctx)` that returns `{ failure_class, phase_outcomes, failure_signals }`. The function reads `_config.json`, `_rates.json`, and the final `summary.json` (with its `tool_calls[]` array — `is_error` flags carry the fetch-success signal directly, no trace.jsonl needed).

Internal flow:
1. `readSignals` collects raw inputs (config existence, rates existence, scraper_type, notes, slab count, confidence, agent success, fetch success/error counts from `tool_calls[]`).
2. `derivePhaseOutcomes(signals)` returns the tier-1 triple via small per-phase decision trees.
3. `deriveFailureClass({ phase_outcomes, signals })` returns the tier-2 label using the mapping table above.

`failure_signals` is a debug payload carrying the raw inputs that drove the classification (slab count, confidence, fetch counts, etc.) — used for exemplar display and for explaining classifier mistakes.

## summary.json schema additions

Three additive fields on each per-bank summary. Existing fields untouched.

```json
{
  "bank_code": "...",
  "bank_name": "...",
  "...": "...",
  "failure_class": "partial_success",
  "phase_outcomes": {
    "website": "reachable_uncommitted",
    "rate_page": "not_attempted",
    "extraction": "not_attempted"
  },
  "failure_signals": {
    "config_exists": false,
    "rates_exists": false,
    "scraper_type": null,
    "notes": "",
    "website_url": null,
    "rate_url_fd": null,
    "slab_count": 0,
    "extraction_confidence": null,
    "agent_success": true,
    "initial_tier": 1,
    "retry_attempted": true,
    "fetch_ok_count": 2,
    "fetch_error_count": 4,
    "domain_was_known": false
  }
}
```

The classifier writes to the **final attempt's** summary file (`<slug>_attempt2.summary.json` if retry happened, else `<slug>.summary.json`). Earlier-attempt summaries stay unchanged as per-attempt history.

**Migration:** existing summaries from before this commit don't have these fields. The aggregator and classifier tolerate their absence (treat missing `phase_outcomes` as no contribution to phase totals; old `failure_class` values from the v1 enum just appear as "unrecognized" in the report).

## Run-end aggregator and report

`buildRunAnalysis` in `lib/run-aggregator.js` produces `_run_analysis.json`:

```json
{
  "run_label": "20260510T1230_dccb",
  "started_at": "...",
  "ended_at": "...",
  "duration_ms": 12318000,
  "category": "DCCB",
  "totals": {
    "dispatched": 350,
    "completed": 350,
    "succeeded": 17,
    "partial_success": 115,
    "no_rates_expected": 3,
    "failed": 215
  },
  "by_failure_class": {
    "success":            { "count": 17,  "exemplars": [...] },
    "partial_success":    { "count": 115, "exemplars": [...] },
    "extraction_failed":  { "count": 1,   "exemplars": [...] },
    "discovery_failed":   { "count": 214, "exemplars": [...] },
    "no_rates_expected":  { "count": 3,   "exemplars": [...] },
    "agent_error":        { "count": 0,   "exemplars": [] },
    "unclassified":       { "count": 0,   "exemplars": [] }
  },
  "by_phase_outcome": {
    "website":    { "found_committed": 23,  "reachable_uncommitted": 113, "candidates_all_failed": 212, "no_candidates": 2 },
    "rate_page":  { "found": 20,            "not_found": 16,              "not_attempted": 314 },
    "extraction": { "succeeded": 17,        "succeeded_low_confidence": 11, "failed": 32,            "not_attempted": 290 }
  },
  "registry_conflicts_surfaced": [...],
  "registry_conflicts_unresolved_total": 0,
  "cost_usd_total": 17.42
}
```

The markdown render at `_run_report.md` shows the tier-2 breakdown table prominently, with a tier-1 phase-outcomes section for drill-down.

## Calibration against the DCCB cloud run (2026-05-08, n=350)

Applied the v2 classifier to the 350 final summaries from the forensic backup at `agent-data-backup/fixed-income-yield-advisor/output/latest/`.

**Tier 2:**

| failure_class | Count | % |
|---|---:|---:|
| `discovery_failed` | 214 | 61.1% |
| `partial_success` | 115 | 32.9% |
| `success` | 17 | 4.9% |
| `no_rates_expected` | 3 | 0.9% |
| `extraction_failed` | 1 | 0.3% |
| `agent_error` | 0 | 0% |
| `unclassified` | 0 | 0% |

**Tier 1:**

- **website:** found_committed=23, reachable_uncommitted=113, candidates_all_failed=212, no_candidates=2
- **rate_page:** found=20, not_found=16, not_attempted=314
- **extraction:** succeeded=17, succeeded_low_confidence=11, failed=32, not_attempted=290

### What the v2 view reveals that v1 hid

1. **`partial_success` is 33% of the run, not the 0% v1 implied.** v1 had no class for "fetched something but didn't commit" — those banks all flowed to v1's `website_unreachable` (which was 89% in v1). The 113 banks in `reachable_uncommitted` are the highest-leverage cohort: they're not "no website" — they're "agent couldn't tell what was the bank's site from what was a portal/aggregator." Prompt refinement directly targets them.

2. **True "no website" is 61%, not 89%.** Most DCCBs really do not have web presence. Pre-classifying these in `bank-domains.json` (Sprint 002 item #5) avoids burning AOAI calls on them.

3. **Extraction is rarely the bottleneck.** Only 32 banks reached Phase 3 with a rate URL and got 0 slabs. Of those, 28 produced *some* extracted rates (succeeded or succeeded_low_confidence). Extraction works when the earlier phases succeed.

4. **The 11 `extraction.succeeded_low_confidence` banks are the slug-ghost cohort.** They produce rates files with slabs but no matching config (Sprint 002 item #6 fix). v2 rolls them up as `partial_success` since `website ≠ found_committed`.

5. **Agent runtime errors are zero.** Cloud infra carried 350 banks to completion. Failures are entirely at the discovery layer.

## Implementation status

| Module | v1 status | v2 status |
|---|---|---|
| `lib/failure-classifier.js` | shipped in `a34615c` | rewritten — phase_outcomes + tier-2 derivation |
| `lib/run-aggregator.js` | shipped | `by_phase_outcome` field added; `totals.partial_success` replaces `totals.succeeded_low_confidence` |
| `lib/run-report-renderer.js` | shipped | new "Phase outcomes" section; updated headline; new `DISPLAY_ORDER` |
| `tests/lib/failure-classifier.test.js` | 15 tests | rewritten — 15 tests for v2 shape |
| `tests/lib/run-aggregator.test.js` | 9 tests | 11 tests (added phase aggregation + legacy tolerance) |
| `tests/lib/run-report-renderer.test.js` | 5 tests | 6 tests (added phase-section rendering + absent-phase-outcome path) |
| `run-discovery.js` wire-in | shipped | summary now stores `phase_outcomes` alongside `failure_class` |
| `run-pipeline.js` wire-in | shipped | unchanged |

Full test suite: 110 tests, 109 pass, 1 pre-existing skip, 0 fail.

## Spawned Sprint 002 item — agent-side phase-handoff (TBD)

The classifier *can* detect `phase_outcomes.website === 'found_committed'` AND `rate_page === 'not_found'` — but **today's agent never produces that state**. The current `discover` prompt is a single sequential task; if the agent identifies a website but can't find a rate page, it gives up without writing a config. So the operator-actionable "website found, rate page not" cohort stays empty until the agent itself changes.

That change is meaningfully different from this taxonomy work and should be its own Sprint 002 item:

- **Scope:** Modify `lib/prompts/discover.md` and `lib/agent.js` so the agent writes a partial config the moment Phase 1 commits (website identified). If Phase 2 fails, the partial config persists with `rate_page_urls.fd: null`, `scraper_type: "manual"`, and a note. Phase 3 then attempts only if Phase 2 produced a URL.
- **Why:** Without this, `partial_success / website found / rate page not_found` stays a theoretical class. After this lands, that cohort populates and operators can act on it (visit website, capture rate URL, update registry, next run goes deterministic).
- **Owner:** TBD; Sprint 002 candidate but lower-priority than items #5 (codify learnings) and #8/#9 (cloud kill-switch + git-publish fix). Could go to Sprint 003.

This taxonomy doc *enables* the future change but doesn't depend on it. The classifier already classifies what data exists today; new states naturally start populating once the agent emits them.

## Open questions

1. **Naming `phase_outcomes` vs alternatives** (`discovery_outcome`, `outcome_by_phase`). I went with `phase_outcomes` since each phase is independent and the field holds three of them. Feedback welcome before this gets baked into the docs and reports.

2. **Slug-ghost interaction.** v2 classifies the slug-ghost cohort as `partial_success` (rates extracted, but website not committed). That's correct — they're a bug surface, not real successes. After Sprint 002 item #6 (slug-ghost fix), they should disappear from `partial_success` and either become `success` (if the bug-affected banks really did extract rates from a real site) or `discovery_failed` (if they were spurious).

3. **Confidence model.** v2 maps both `succeeded` and `succeeded_low_confidence` (Phase 3) to `success` (Tier 2). The low-confidence flag is preserved in `phase_outcomes` so reporters who care can drill in. Alternative: introduce a Tier-2 `success_low_confidence` value. Held off — keeps Option A at 6 + fallback. Revisit if low-confidence successes need a different operator action.

## Decision log

- 2026-05-10 — v1 drafted (single-axis 10 enum) and shipped as `a34615c`.
- 2026-05-10 — Samir flagged that the design conflated discovery and extraction, asked for two-tier shape with partial-success cohorts surfaced. Picked Option A (6-value tier-2). Migration approach: additive (existing summaries lack the new fields; aggregator tolerates).
- 2026-05-10 — v2 drafted, classifier+aggregator+renderer rewritten, 32 tests pass, full suite 109/1-skip/0-fail. Calibrated on DCCB cloud forensic data: 61% discovery_failed, 33% partial_success, 5% success, 1% no_rates_expected, 0.3% extraction_failed, 0% agent_error.
