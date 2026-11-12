# Phase 3 — Cloud-block detection + registry (DESIGN, PENDING OPERATOR APPROVAL)

**Sprint:** 009
**Phase:** 3 (after Phase 2.5; before Phase 4 split-execution)
**Status:** Design — awaiting operator decisions on Q1–Q4 below before implementation.

## Goal

Phase 4 (split-execution) needs to know, before a run starts, which banks
are likely to fail when fetched from the cloud egress so it can route
them to local before burning AOAI tokens on doomed cloud attempts.
Phase 3 builds the signal that feeds that decision:

1. A canonical **block fingerprint** — what counts as a cloud-side block.
2. A **persistent registry entry** per bank that records the most recent
   observation and aging counters.
3. An **auto-populating writer** that consumes Phase 1's structured
   per-bank events and updates the registry without manual editing.

## What already exists

| Layer | What | Where | State |
|---|---|---|---|
| WAF/challenge detector | Pure function classifying a response body + status + headers into `{ challenged, vendor, signal }`. Vendors: cloudflare / akamai / cloudfront / imperva / unknown_waf, plus signals for thin-body, 403, 429, vendor-leaking server header on 4xx | `lib/fetch/challenge_detect.js` | Production. One known regression test failing (Cloudflare body pattern drift since the sprint-007 tightening for cdnjs false-positives — see `tests/lib/fetch/fetch_html.test.js:76`). |
| Fetch escalation harness | Consumes `detectChallenge`. On `challenged: true` jumps default → stealth → firefox → llm-fallback | `lib/fetch/fetch_html.js` | Production. |
| Structured per-bank events | ATTEMPT / EXTRACTED / BLOB_WRITE / SKIPPED / FAILED (Phase 1.3). FAILED includes `kind` discriminator: `exit_nonzero`, `timeout`, `rate_limited`, `zero_slab_extraction` (Phase 2.5), and now `receipt_upload_failed` (Phase 2.5 item 3). | `lib/events.js` (events emitter); KQL surfaces via Log Analytics | Production. |
| Single-query KQL reconciliation | One query gives per-bank ATTEMPT/EXTRACTED/BLOB_WRITE/SKIPPED/FAILED outcome across a cohort run | Phase 1.4 (`bd9b975`) | Production. |
| Per-bank registry | ~1018 entries keyed by bank_code with arbitrary metadata (domain, scraper_type, template, extraction hints, discovery_status, confidence, etc.) | `data/bank-domains.json` | Production. ADR-012-protected via `safeWriteArtifact({kind: 'registry-entry'})`. |
| Per-bank "manifest" module | `buildManifest` / `writeManifest` that emits `<bank>_manifest.json` to a caller-supplied outputDir. Carries fetch / extract / baseline / drift / warnings / errors. | `lib/manifest/per-bank-manifest.js` | **Built but not wired into production.** Sprint 006 Step 2 deliverable; Step 4 (integration) didn't ship. Tests pass. |

## Open questions for operator decision

### Q1. Where does `cloud_block_status` live?

Sprint-open decision #2 said:

> Registry storage: extend `data/per-bank-manifest/<bank>.json` with
> `cloud_block_status` block — don't create a new file.

But `data/per-bank-manifest/` doesn't exist today and the only existing
"per-bank manifest" infrastructure (`lib/manifest/per-bank-manifest.js`)
writes per-run `<bank>_manifest.json` files to `output/latest/` (an
ephemeral location, overwritten each run). Three possible readings:

**Option A — Extend `data/bank-domains.json` entries.** (Recommended.)
- Add `cloud_block_status` field to each per-bank entry already keyed by bank_code.
- "Don't create a new file" honored literally — same registry, new field.
- ADR-012 already protects this file with `kind: 'registry-entry'` writes via `safeWriteArtifact`. Free for us.
- Phase 4 cohort splitter reads from the file that's already the durable per-bank source of truth.
- Cost: schema sprawl on bank-domains.json. It's already at 22 distinct fields with sparse coverage; one more nested object is minor.

**Option B — New file: `data/cloud-blocks.json`.**
- Smaller scope per-file; easier to delete/reset.
- Violates "don't create a new file."
- Phase 4 needs a second I/O for the same bank lookup.

**Option C — Wire `lib/manifest/per-bank-manifest.js` into production at a durable location.**
- Per-bank `<bank>_manifest.json` lives in a new `data/per-bank-manifest/` dir as the operator decision literally said.
- But the existing manifest schema is per-run and per-fetch (snapshot of *this* run); making it persistent changes its semantics. Sprint 006's drift block compares the current run vs the *prior manifest* — only works if the manifest is durable. So this isn't an unnatural move.
- Larger scope: integration work to wire the manifest writer into `run-discovery.js` is required regardless. Phase 3 could land that wiring as a side-benefit, or defer it.

**Recommendation: A.** It's the closest literal reading of "don't create a new file", uses safeWriteArtifact's existing protections, and avoids the Sprint-006 manifest-wiring sidequest. Option C is tempting but it's hidden scope creep — wiring the per-run manifest is its own project (it touches the orchestrator, the agent path, and the fetch result threading).

### Q2. What schema does `cloud_block_status` carry?

Per the scope doc (sprint-009-scope.md line 49):

> `cloud_block_status` block in per-bank manifest with `last_observed`,
> `evidence_url`, `http_status`, `reason`, `confidence`; auto-populate
> from Phase 1 events.

Proposed shape (extending the scope doc minimally):

```json
{
  "cloud_block_status": {
    "blocked": true,
    "last_observed": "2026-06-03T14:23:11Z",
    "first_observed": "2026-06-03T14:23:11Z",
    "evidence_url": "https://hdfc.bank.in/fixed-deposit/fd-interest-rate",
    "http_status": 403,
    "reason": "challenge_cloudflare",
    "vendor": "cloudflare",
    "signal": "body-match: Just a moment...",
    "confidence": "high",
    "observation_count": 1,
    "last_run_id": "private-sector-bank-indian-2026-06-03T14:20:00Z",
    "last_execution_name": "caj-bofia-rate-discovery-prod-abc123"
  }
}
```

Field rationale:
- `blocked` — explicit boolean, cheaper than checking `last_observed`-vs-now logic in every consumer.
- `last_observed` / `first_observed` — bracket the observation window. Enables "blocked for ≥ N days" decay logic in Q3.
- `evidence_url` — the URL the cloud agent was fetching when it detected the block. Operator can verify by hand.
- `http_status` — from the response.
- `reason` — small enum: `challenge_cloudflare` / `challenge_akamai` / `challenge_cloudfront` / `challenge_imperva` / `challenge_unknown_waf` / `http_403` / `http_429_rate_limit` / `sustained_not_found_after_retry`. Maps from the `vendor` + `signal` fields in `detectChallenge`'s output.
- `vendor` / `signal` — raw output from `detectChallenge` for forensic audit.
- `confidence` — `low` / `medium` / `high` derived from `observation_count` + signal-specificity (see Q3).
- `observation_count` — monotonic counter; reset only by explicit operator un-block.
- `last_run_id` / `last_execution_name` — provenance pointers into the run / execution that wrote this entry. Enables KQL-side reproduction of the evidence.

### Q3. Confidence + decay model

The scope doc requires `confidence` but doesn't specify the rule.
Three knobs:

**Promotion** — how many cloud-side block observations before `blocked: true` and `confidence: high`?
- Vendor-specific body match (Cloudflare/Akamai/CloudFront/Imperva) — *very* low false-positive rate (sprint-007 already tightened patterns). Recommend: 1 observation = high confidence.
- Generic `unknown_waf` (status 403 / 429 / thin-body / vendor header on 4xx) — softer signal. Recommend: 2 consecutive observations = high confidence; 1 = medium.

**Decay** — block entries aren't permanent (WAF rules change, IP reputation drifts). When do we trust again?
- Option α: never expire; require operator to explicitly un-block via `data/bank-domains.json` edit.
- Option β: expire after N days since `last_observed` (proposal: 30 days). Phase 4 cohort splitter checks freshness; expired entries fall through to "probe cloud" path.
- Option γ: re-probe periodically — cloud always attempts the bank once per N days even when blocked, updating `last_observed` if the block persists.

**Recommendation: β with N=30.** Avoids permanent blacklisting; operator un-block stays available via direct edit. γ wastes cloud spend on a per-bank-per-period basis, which is exactly what the registry was supposed to prevent.

### Q4. Auto-population trigger

The scope says "auto-populate from Phase 1 events." Two implementation
shapes:

**Option I — In-flight write inside the fetch layer.**
- `lib/fetch/fetch_html.js` already calls `detectChallenge`. After the escalation cascade exhausts (`status: 'failed'` with `challenge_detected !== null`), write to `bank-domains.json` immediately.
- Pros: immediate observability; no end-of-run batch step.
- Cons: in-flight blocking write to `bank-domains.json` during a parallel cohort run = lock contention (proper-lockfile mitigates but adds dependency). Also adds I/O latency to a fast path.

**Option II — Post-run batch from KQL.**
- After each cloud run, a separate script reads the FAILED events with `kind: 'challenged'` from KQL, aggregates per bank, writes to `bank-domains.json` once.
- Pros: zero in-flight I/O. One serialized writer. KQL query is already the source of truth (Phase 1.4).
- Cons: needs to be invoked (run-batch.js can call it from `finalize()`; cloud-only). Latency: registry updates lag the run by ~minutes.

**Option III — Hybrid: in-flight observation captured into the run-end batch.**
- The agent's existing FAILED event already carries `kind` + `vendor` + `evidence`. The end-of-run batch reads the local event log (already on disk in `output/runs/<label>/`) — no KQL trip needed.
- Writer is invoked from `run-batch.js#finalize()` for cloud runs; reads structured events directly; writes once per bank.
- Pros: no KQL roundtrip; no lock contention; deterministic; testable in local mode against a synthetic event stream.
- Cons: requires the event log to be on disk in a known shape. Phase 1.3's structured events ARE on disk in `output/runs/<label>/_events.jsonl` (or wherever they land); this assumes that.

**Recommendation: III.** It's the simplest correct path. Phase 1.3's event log is already a structured artifact; we just consume it from one more reader.

## Proposed file plan (assuming A + III + Q3 recommendations)

### New module

`lib/cloud-block/registry-updater.js` — pure function shape:

```js
function deriveCloudBlockStatus(eventLog, { bankCode, runId, executionName }) → cloud_block_status | null
function updateRegistry(domains, perBankBlockStatus) → updatedDomains
```

`deriveCloudBlockStatus` scans an event log for FAILED events with
challenge/timeout/sustained-404 signals for one bank, applies the
confidence rules from Q3, returns the block_status object or null
("no evidence of block").

`updateRegistry` merges per-bank block statuses into a copy of
`bank-domains.json`. Uses default-to-merge semantics (Part C of
ADR-012). Existing block_status is preserved + counters incremented;
new entries created if absent.

### New caller wire-up

`run-batch.js#finalize()` calls a new helper:

```js
function updateCloudBlockRegistry() {
  if (process.env.BIRD_STORAGE !== "azure") return;  // cloud-only by definition
  const eventLog = readEventLog(batchRunDir);
  const perBank = aggregateBlockStatusesByBank(eventLog, { runId: batchLabel, executionName });
  if (perBank.size === 0) return;
  const domains = loadDomains();
  const updated = updateRegistry(domains, perBank);
  // safeWriteArtifact handles per-entry overwrite-protection
  for (const [bankCode, status] of perBank) {
    safeWriteArtifact({
      kind: 'registry-entry',
      source: 'classifier',  // or a new 'cloud-block-detector' value
      bankCode,
      incoming: { cloud_block_status: status },
    });
  }
}
```

### New tests

- `tests/lib/cloud-block/registry-updater.test.js` —
  - deriveCloudBlockStatus from synthetic event logs:
    - vendor-specific match × 1 → high-confidence cloudflare entry
    - unknown_waf × 1 → medium-confidence entry
    - unknown_waf × 2 (separate runs) → high-confidence entry (counter advances)
    - mixed events (some success some block) → not blocked (success trumps a single block)
    - no failed events → null (no entry written)
  - updateRegistry merge semantics:
    - First-observation creates the field
    - Repeated observation updates `last_observed`, increments counter, preserves `first_observed`
    - Decay (30-day-old entry) is preserved by the writer; freshness check is done by Phase 4 readers
    - Default-to-merge: other fields in the entry are untouched
- Integration test: spawn run-batch.js with a synthetic event log, assert bank-domains.json carries the expected `cloud_block_status` block after finalize.

### Schema additions to ADR-012's allowed `extraction_method`?

Not needed. `cloud_block_status` is registry metadata, not an extraction
method. It sits alongside `extraction_method`, `scraper_type`, etc. in
the per-bank entry.

## Non-goals

- **Phase 4 cohort splitter consumes this — not built here.** Splitter design is its own doc.
- **Fixing the pre-existing `tests/lib/fetch/fetch_html.test.js:76` Cloudflare-pattern regression.** Same fetch layer, but it's a sprint-006/sprint-007 bug, not Phase 3 scope. Flagged for whoever owns the fetch layer.
- **Wiring `lib/manifest/per-bank-manifest.js` into production.** Sprint 006 leftover; orthogonal to Phase 3 if we choose Option A above.
- **Local-side block detection.** The scope is CLOUD-only blocks (Phase 4 routes cloud-blocked banks to local; if local is also blocked the bank is just broken). Local fetches don't update `cloud_block_status`.

## Risks

- **Distinguishing cloud-only from local-also blocks.** This design writes block_status purely from cloud-side runs. A bank that's blocked on BOTH sides will be flagged as cloud-blocked here, then Phase 4 routes it local, where the same block hits. That's fine for now — local will fail with its own diagnostic and the operator handles it. If it becomes painful, Phase 4 can add a "tried local, also blocked" un-set.
- **Sprint-007's tightened Cloudflare regex misses real cf challenges.** The failing fetch_html.test.js shows the patterns are too narrow. If we ship Phase 3 with the current detector, real Cloudflare blocks will be classified as `unknown_waf`. Not a correctness bug (the bank still gets blocked) but loses the vendor signal. Recommend fixing alongside as a Phase 3 housekeeping item — the fix is one-line.
- **`safeWriteArtifact` lock contention on `bank-domains.json`.** If multiple concurrent cohort runs both finalize at once, the registry writes serialize through safe-write. Acceptable in practice; documented in ADR-012 open question #2.

## Sequence the operator decides on

1. **Q1 location** — A (extend bank-domains.json), B (new file), or C (wire the manifest module)?
2. **Q2 schema** — fields above OK, or add/remove anything?
3. **Q3 confidence + decay** — promote rule + 30-day expiry OK?
4. **Q4 trigger** — III (read event log in finalize) OK?
5. **Fix the sprint-007 Cloudflare regex regression as a Phase 3 housekeeping item?** (one-line; would close the open test failure.)
6. **Use a new `source: 'cloud-block-detector'` value in safeWriteArtifact, or re-use 'classifier'?**

After approval I'll implement in this order: new module + unit tests → run-batch.js wire-up → integration test → sprint-009-status memory update.
