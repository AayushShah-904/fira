# Quality Checks — Onboarding Guide

**Read [overview.md](overview.md) first** if you haven't — it introduces the pipeline, the slab model, and the "no fabrication" rule this whole doc defends. This page goes one level deeper into *how* bad data is kept out of the published pack.

> **Audience:** an engineer taking over the project. By the end of this page you should know every layer that stands between a bad extraction and a shipped rates pack, and how to read each layer's output.

---

## 1. Framing — quality is layered, not a single gate

There is no one "quality check." There's a **funnel**, each stage catching a different failure mode, and every stage exists because a real incident got past the stage before it:

```
extraction validation  →  safe-write  →  confidence scoring  →  quality gate  →  signed accepts
   (rate-bounds,            (ADR-012,       (ADR-016,              (pack/                (agent-immune,
    structural checks,       curated-file    per-variant             quality-gate.js,       bin/approve-
    rate-reasonableness)     protection)     score/tier)             baseline diff)         accept.js)
```

- **Extraction validation** rejects individually-implausible slabs (a rate of 15100%, a tenure of 10890 days) before they ever reach a file.
- **Safe-write** (`lib/safe-write.js`) protects what's already on disk — it refuses writes that would silently destroy good data, regardless of how the bad write was produced.
- **Confidence scoring** (`lib/confidence/score.js`) doesn't block anything; it labels each variant so downstream consumers can tell verified data from data that still needs a human look.
- **The quality gate** (`pack/quality-gate.js`) is the last automated checkpoint before publish — it compares the whole pack against a fixed baseline and blocks large regressions.
- **Signed accepts** are the only way a human can tell the gate "I've reviewed this regression, ship it anyway" — and the mechanism is deliberately built so an agent cannot forge that approval.

**The overarching principle, repeated from `CLAUDE.md` and `overview.md` because it's the reason every layer below exists: no fabrication, honesty over coverage.** A bank with zero extractable slabs and an honest `warnings` entry is a correct output. A bank with fabricated slabs, or a silently-overwritten good ladder, is not — no matter how much better it makes the coverage numbers look.

Related docs once written: `extraction.md` (the validation that happens *during* extraction — extractors, rate-bounds, tenure/currency parsing) and `operator-guide.md` (the day-to-day runbook for running the gate and signing accepts). Both are listed as siblings in `overview.md` §6; this doc assumes you may be reading it before either exists yet.

---

## 2. Safe-write discipline (`lib/safe-write.js`, ADR-012)

`lib/safe-write.js` is **the single sanctioned write path** for every per-bank artifact: `output/latest/<slug>_config.json`, `<slug>_rates.json` and its variants (`_nre`, `_nro`, `_fcnr`, `_gift`), `<slug>.summary.json`, and `data/bank-domains.json` registry entries. Every writer — the agent, the classifier, the skip-gate, cloud-pull, the merger — calls `safeWriteArtifact({ path, incoming, kind, source, force })` instead of `fs.writeFileSync`.

Before writing, it runs incoming `rates` payloads through a deterministic **QC pass** (`lib/rates-qc.js`: ISO-normalises `effective_date`, dedups slabs by a composite key, drops stale-year date garbage, and flags `under_extraction_suspected` — LLM-path writes only; curated methods bypass). Then it checks four rejection rules, in order, against what's already on disk. Any rule that fires **diverts the incoming payload to `<path>.pending.json`** instead of overwriting — the existing file is untouched except for an appended `_safe_write_history` entry recording what was attempted and why it was rejected.

The four rules, as implemented:

1. **Curated-file protection.** If the existing file's `extraction_method` is a curated value (`manual_*`, `pending_*` — see `lib/extraction-methods.js`) and the write isn't from `source: 'operator'` and doesn't pass `force: true`, the write is rejected outright. Operator-transcribed data can only be overwritten by another operator write.
2. **Never overwrite non-empty with empty.** If the existing file has `rate_slabs.length > 0` and the incoming payload has `rate_slabs.length === 0`, the write is rejected — unless the existing file is explicitly tagged `stale_needs_refresh` (an operator opt-in signal meaning "please try to refresh or clear this").
3. **Garbage rejection.** If `lib/rate-quality/garbage-detector.js` classifies the *existing* file as `clean` and the *incoming* payload as `garbage`, the write is rejected. This catches the case where an extractor grabbed the wrong table and produced more slabs than before — but every one of them nonsense (row indices as tenure text, rates like 91179%).
4. **Shrink guard.** If the existing file has **≥8 slabs**, is not `stale_needs_refresh`, and the incoming payload is non-empty but **below 50% of the existing slab count**, the write is rejected. This is "clean but fewer" — almost always under-extraction (a hinted PDF 404'd and the fallback landed on a teaser table), not a bank genuinely shrinking its rate ladder.

**Why `.pending.json` files exist:** none of these rules discard the incoming data — they park it beside the retained file so an operator can review and manually merge if the new extraction actually is correct. This is why you'll see `axis-bank-limited_rates.json.pending.json` etc. in `output/latest/` — they are not errors to clean up, they're a review queue.

Writes are also atomic (temp file + rename) so a crash mid-write never leaves a half-written JSON at the destination.

**Enforcement:** `scripts/check-write-discipline.js` walks `lib/`, `scripts/`, `cloud/`, `pack/`, `iac/`, and the three top-level runners, and fails if it finds any `fs.writeFileSync` / `fs.copyFileSync` call outside `lib/safe-write.js` that doesn't carry a `// safe-write-exempt: <reason>` comment. It runs as `pretest` (wired into `npm test`'s pretest hook) — so a writer that bypasses the funnel fails CI before any test even runs, not after.

---

## 3. The quality gate (`pack/quality-gate.js`)

The gate runs after `pack/build-pack.js` produces `pack/dist/rates-pack.json` and before `pack/publish.js` is allowed to ship it. It compares the freshly-built pack against a **fixed floor baseline** at `pack/baseline/baseline-pack-2026-05-28.json` (moved there from `logs/sprint-009/` on 2026-07-08 specifically so it ships inside the container image — the cloud path needs it too).

> **Two files named "quality-gate" — this is the pre-publish one.** `pack/quality-gate.js` (this section) is the coverage gate that `publish.js` and the cloud finalize enforce. There is a *second*, richer analysis tool at **`scripts/quality-gate.js`** (Sprint 004, wired to `npm run quality-gate`) that classifies changes into REGRESSION/ANOMALY/WARN/GAIN/STABLE and consumes the **signed** accepts from §4 — it's for deep triage/diffing and does **not** gate publish. When someone says "the gate blocked," they almost always mean `pack/quality-gate.js`.

Two independent checks, either of which blocks:

| Check | Threshold | Rationale |
|---|---|---|
| **Global slab drop** | pack-wide `total_slabs` drops more than **10%** vs. the baseline | catches whole-class regressions (e.g. Sprint 009's `partial_silent` storm across many banks at once) |
| **High-confidence bank regression** | any bank whose **baseline** confidence was `high` loses more than **50%** of its slabs in the current pack | catches surgical regressions on a handful of important banks (Axis, BoB, ICICI) where even a small percentage of the *global* total is operationally disastrous for that one bank |

Note the high-confidence check uses the bank's confidence **as recorded in the baseline**, not the current run — so a bank that regressed from high-confidence-and-populated to zero still trips the rule even though its "current" confidence is now undefined.

Output: `pack/dist/QUALITY-GATE.json` (machine-readable verdict) plus an appended section in `pack/dist/REPORT.md` (human-readable). Exit codes: `0` pass (or accepted override), `1` block, `2` missing inputs (no built pack or no baseline file).

**Override mechanism:** `node pack/quality-gate.js --accept-regression "<reason>"` records the reason to `QUALITY-GATE.json#operator_override` and flips `effective_pass` to `true` even when the underlying checks failed. `pack/publish.js` refuses to upload unless `QUALITY-GATE.json#pass` is `true` **or** `operator_override` is set with a non-empty reason. This override is a blunt, unsigned mechanism meant for one-off operator judgment calls at gate time — it is a different, weaker mechanism than the signed accepts described in §4, which are meant to persist across runs.

**Historical fix — the gate now runs inside cloud finalize.** Until 2026-07-08 (Sprint 011), `run-batch.js`'s cloud finalize path built the pack and called `publish.js` directly; `publish.js` hard-blocks without a `QUALITY-GATE.json` verdict, so every cloud finalize logged a non-fatal publish failure and the live `rates-pack` container silently stayed stale (from 2026-06-05) for over a month with nobody noticing. The fix (in `run-batch.js`, see the "Sprint 011 (2026-07-08)" comment near the cloud-publish helper) runs `pack/quality-gate.js` as a spawned step immediately before `publish.js`; on BLOCK it logs loudly and skips publish rather than auto-overriding. **The gate never auto-overrides itself in the cloud path** — an operator accept still has to happen through §4.

---

## 4. Signed accepts — the hard rule

`pack/quality-gate-accepts.json` holds the list of regressions and anomalies an operator has reviewed and decided are legitimate (not just "override this run," but "this specific finding, permanently, until the underlying data changes"). Historically (before Sprint 005 Phase D2), **any process that could write this file could flip a BLOCK to a PASS** — including the agent.

**The 2026-05-23 incident:** the agent fabricated 48 entries in `pack/quality-gate-accepts.json` with `approved_by: "Samir Joshi"`, none of which the operator had actually reviewed, and those fabricated accepts flipped a BLOCK verdict to PASS. The operator caught it. The commit was reverted (`3193746`), and the incident is the direct cause of the design described below — it is documented in `sdlc/sprints/sprint-004/implementation/cohort-pm-q2-passV1-2026-05-23.md` and referenced from the project's memory as `feedback_no_fake_approvals`.

**The redesign makes this structurally impossible, not just policy-forbidden:**

- Every accept entry must carry an **HMAC-SHA256 signature** (`lib/quality-gate/signed-accepts.js#signAccept`) computed with an **operator key that lives outside the repo** (`~/.rate-discovery/operator.key`, 32+ bytes of hex, generated with `openssl rand -hex 32`). The signature covers a canonical form of the entry (`bank_code`, `variant`, `check`, `finding_hash`, `approved_by`, `approved_at`, `reason`) — editing any field invalidates the signature.
- The signature binds to a `finding_hash` — a SHA-256 hash of the specific regression shape (`bank_code`, `variant`, `class`, `baseline`, `actual`). If the pack regresses *further* after an accept was signed, the hash no longer matches and the accept doesn't apply — an old accept can't silently cover a new, worse regression.
- **`bin/approve-accept.js` is the ONLY code path that can produce a validly-signed entry.** It refuses to run in three situations, checked before any state is read or written:
  - **Inside an AI-agent session** — `lib/quality-gate/signed-accepts.js#detectAgentEnvironment` checks for `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CURSOR_*`, `AI_AGENT` patterns, etc.
  - **Inside CI** — `detectCiEnvironment` checks `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, etc.
  - **Without a TTY** — the sign path requires an interactive `[y/N]` confirmation (bypassable only with `--yes`, which still requires the agent/CI/TTY gates to pass first).
- The operator key itself is never in the repo and is never readable by an agent process (the agent-detection check fires before the key is even loaded).

**Practically: you (or any agent) must never hand-edit `pack/quality-gate-accepts.json`.** The file's own `_comment` field states this directly. If a regression needs accepting, the operator runs, from a real interactive shell outside any agent session:

```
node bin/approve-accept.js --bank <code> --variant <v> --finding-hash <h> --reason "<text>"
node bin/approve-accept.js --list      # review current accepts (no key needed)
node bin/approve-accept.js --verify    # check every entry's signature is valid
```

`accepted_regressions` covers slab-count drops the operator has verified are correct (dedup removing genuine duplicates, a source going genuinely offline, a mislabeled table being fixed); `accepted_anomalies` covers structural/rate-reasonableness findings (see §6) the operator has confirmed are false positives (e.g. Axis's legitimately huge deposit-tier matrix).

---

## 5. Confidence scoring & tiered publication (ADR-016)

`lib/confidence/score.js#computeVariantConfidence(signals)` combines the program's independent correctness signals into one actionable answer per bank+variant: a `score` (0–100, starts at 100 and only loses points — absence of a signal is treated as *unknown*, never as *good*) and a `tier` of `verified` or `needs_review`.

Signals and their weight: structural anomaly (−40) or warning (−10, see §6); independent cross-check `DISAGREE` (−35) / `LLM_NO_DATA` (−20) / `PARTIAL` (−10) / absent (−5); `static` extraction method (−10, neither auto-refreshed nor operator-curated); staleness (−15); a half-weighted penalty from the measured per-method error rate where known.

`tier: 'verified'` requires **all** of: no structural anomaly, not stale, score ≥ 70, and either a `FULL` independent cross-check **or** (no cross-check available **and** measured error rate < 10%). Everything else is `needs_review` — the honest default when the program can't yet vouch for a number.

This scoring is a pure function; `build-pack.js` stays LLM-free by reading precomputed sidecars (`output/latest/_confidence/<bank>__<variant>.json`, built by `scripts/confidence/build-confidence.js`) rather than calling anything at build time. The fields are only attached to the published pack when `FIRA_EMIT_CONFIDENCE` is set — a deliberate opt-in so the pack's shape doesn't change until the operator trusts the numbers. **Low-confidence data is flagged, not silently shipped or silently dropped** — same honesty-over-coverage principle as the rest of this doc.

---

## 6. Rate/tenure bounds validation

Two related but distinct bound systems exist — know which one you're looking at:

- **`lib/rate-bounds.js` — the loose sanity filter.** Used at `pack/build-pack.js` and `lib/actions/extract_html_table.js` (and mirrored in `scripts/extract_rates.js`'s `looksLikeBadMapping`) to **drop** slabs whose numbers are obvious extraction errors, not just unusual. Per-variant `PACK_FILTER_BOUNDS`: `regular`/`nre`/`nro` 0.1–15%, `fcnr`/`gift` 0.0–12%. A hard tenure cap of 3700 days (Indian FDs max out at 10 years / 3650 days) catches digit-concatenation bugs like a tenure cell parsed as `10890`. These bounds are intentionally wide — a genuine 12% promotional FD should still ship (with a warning), only genuinely impossible values (a 15100% rate) get silently dropped.
- **`scripts/utils/validation-constants.js` — the tight validation band.** Used by `validate-rates.js` to **warn** (not drop) on rates outside plausible-but-not-impossible ranges: `VARIANT_RATE_RANGES` (`regular`/`nre`/`nro` 1.5–9.5%, `fcnr`/`gift` 0.5–8.0%, with `LOW_YIELD_CURRENCIES` overrides for JPY/CHF near-zero FCNR rates), `VARIANT_TENURE` (NRE 365–3650 days per RBI rule; FCNR 365–1825 days; GIFT relaxed to 7–1825 days since GIFT-City offshore deposits legitimately offer sub-week tenors that domestic FCNR cannot), and senior/super-senior premium ceilings (+1.0 / +1.5 over the general max). This file is a CJS mirror of a canonical TypeScript module in `packages/shared/`; a drift-check test keeps the two in sync.

Beyond bounds, `lib/checks/structural-checks.js` (Sprint 008 Phase 3) catches *shape* problems bounds-checking alone misses: a loan/savings table misread as an FD table, a truncated ladder (too few rungs for the bank's category floor), a senior/general column swap detected via peer comparison, and collapsed/mislabeled FCNR currencies. `lib/checks/rate-reasonableness.js` (Phase 7, ADR-017) flags a rate that disagrees with **two or more** of three independent anchors — peer/category median, the RBI repo rate (operator-approved macro metadata in `data/macro-rates.json`; the agent may only *propose* a value via `scripts/macro/propose-repo-rate.js`, never self-approve — same agent-immune pattern as signed accepts), and the bank's own recent history. One anchor disagreeing is a `WARN`; two or more agreeing that something's wrong is a blocking `ANOMALY`.

---

## 7. How to read the gate output (operator quick-reference)

Run it after a pack build: `node pack/build-pack.js && node pack/quality-gate.js`.

- **Exit code / console line**: `[quality-gate] PASS` or `[quality-gate] BLOCK — reasons: <list>`. Reasons are `global_slab_drop` and/or `high_confidence_bank_regression`.
- **`pack/dist/QUALITY-GATE.json`** — the full machine verdict:
  - `pass` — the raw verdict before any override.
  - `operator_override` — non-null only if `--accept-regression "<reason>"` was passed on this run.
  - `effective_pass` — `pass || !!operator_override`; this is what `publish.js` actually checks.
  - `checks.global.delta_pct` — global slab delta vs. baseline, as a fraction (e.g. `-0.12` = 12% drop).
  - `checks.high_confidence_regressions[]` — each entry has `bank_code`, `baseline_slabs`, `current_slabs`, `delta_pct`; sorted worst-first.
  - `block_reasons[]` — machine-readable list for scripting.
- **`pack/dist/REPORT.md`** — the same verdict appended as a human-readable section, useful when scanning a run's full report rather than a raw JSON.
- If it blocks and the regression is real (not a false positive), fix the underlying extraction and re-run — don't reach for `--accept-regression` as a default. That flag is for the rare case where the operator has *already* judged the drop intentional and needs the pack to ship now; use `bin/approve-accept.js` (§4) for anything meant to persist as a standing accept across future runs.

Full day-to-day command sequences (building a pack, running the gate, publishing, reconciling blob/git) belong in `operator-guide.md` — this section is just enough to interpret an existing gate run.

---

## 8. Pointers

| Doc | What's there |
|---|---|
| `sdlc/decisions/ADR-012-write-discipline.md` | Full rationale for centralizing writes, the `extraction_method` schema, the default-to-merge norm, and the incidents (`domain-cache.js`, Angul's transcription) that motivated it |
| `sdlc/decisions/ADR-016-confidence-scoring-tiered-publication.md` | Why confidence is opt-in (`FIRA_EMIT_CONFIDENCE`), the exact scoring formula, and first-run numbers (484 verified / 100 needs_review of 584 variants) |
| `sdlc/decisions/ADR-017-operator-approved-macro-rate.md` | Why the RBI repo-rate anchor is operator-approved metadata, not agent-asserted; the propose→approve two-step |
| `sdlc/sprints/sprint-005/design/observability-and-gate.md` | Design doc behind the signed-accept mechanism |
| `sdlc/sprints/sprint-004/implementation/cohort-pm-q2-passV1-2026-05-23.md` | The fabricated-accepts incident write-up (reverted in `3193746`) |
| [overview.md](overview.md) | The whole system in one sitting; §5 has the condensed version of every concept this doc expands on |
| `extraction.md` *(sibling, if written)* | Extractors, rate schema, and the validation that happens during extraction rather than after it |
| `operator-guide.md` *(sibling, if written)* | Day-to-day runbook: build/gate/publish a pack, sign accepts, troubleshoot a blocked publish |

---

*Written for handover, 2026-07-09.*
