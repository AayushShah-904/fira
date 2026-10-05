# Scripts — the operational toolbox

`scripts/` is everything around the core pipeline (`run-discovery.js` / `run-batch.js` /
`lib/`) that an operator or a one-off analysis needs: cloud/blob operations, pack
building, shared parsing helpers, registry maintenance, and a long tail of dated
one-shot recovery scripts from past incidents. This doc is a **catalog** — what exists
and what it's for. For the actual command sequences you'd run day-to-day, see
**[operator-guide.md](operator-guide.md)** (the runbook). For the system context these
scripts operate on, see **[overview.md](overview.md)**, **[deployment.md](deployment.md)**,
and **[quality-checks.md](quality-checks.md)**.

Scripts are grouped below by subfolder. Within each table, script paths link to nothing
(this doc is prose, not code) — descriptions come from each file's own header comment,
read directly; where a header wasn't available, the description is marked cautious.

---

## npm-wired scripts — the blessed entry points

These are the commands `package.json` exposes via `npm run <name>`. If you only remember
one table, remember this one.

| npm command | Runs | Purpose |
|---|---|---|
| `npm test` | `node --test --test-force-exit` | Full test suite |
| `npm run check:writes` (also runs as `pretest`) | `scripts/check-write-discipline.js` | CI/pre-commit gate: refuses raw `fs.writeFileSync`/`copyFileSync` outside `lib/safe-write.js` unless explicitly exempted (ADR-012) |
| `npm run build-pack` | `pack/build-pack.js` | Merge all per-bank `output/latest/*` files into `pack/dist/rates-pack.json` |
| `npm run quality-gate` | `scripts/quality-gate.js` | Compare the freshly built pack against a baseline; blocks publish on unaccepted regressions |
| `npm run publish-pack` | `pack/publish.js` | Ship the pack (gated — refuses if the quality gate hasn't passed) |
| `npm run cloud:status` | `scripts/azops/cloud-status.js` | Summarize the last N Container Apps Job executions with real business outcomes (not just ARM status) |
| `npm run cloud:drift` | `scripts/azops/drift-check.js` | Diff the live Container Apps Job spec (image tag, env vars, timeout) against expected values |
| `npm run cloud:reconcile` | `scripts/azops/reconcile.js` | Query Log Analytics for a per-run-label verdict table |
| `npm run cloud:deploy-smoke` | `scripts/azops/deploy-smoke.js` | One-command deploy + smoke-test cycle with a pass/fail business verdict |

Everything else in `scripts/` is invoked directly with `node scripts/...` — there's no
npm wrapper, so check each script's own `Usage:` header for flags.

---

## `scripts/azops/` — cloud & blob operations

The most important family for a new operator: everything that talks to the Container
Apps Job, blob storage, or the live registry blob. Read **[deployment.md](deployment.md)**
first for the Azure topology these scripts assume.

| Script | Purpose |
|---|---|
| `cloud-status.js` | Lists recent Job executions joined against each run's execution-receipt blob — the truthful outcome, since ARM "Succeeded" alone doesn't mean anything actually ran |
| `drift-check.js` | Read-only audit: live Job spec vs expected image tag / kill-switch / replica timeout; non-zero exit on drift |
| `reconcile.js` | Runs a KQL query against Log Analytics for per-run-label verdicts (structured `[EVENT]` lines emitted by `lib/events.js`) |
| `status.js` | Re-attach to a running/completed Job execution (same polling UX as `start-cohort.js`); `--once` for a snapshot |
| `start-cohort.js` | Operator-initiated cloud cohort trigger from a dev machine, with live per-bank progress streamed by default; `--detach` to fire-and-forget |
| `start-cohort-run.js` | Starts a cohort run via ARM POST passing `--cohort=<name>` straight through to the image (use when the cohort JSON is already committed and the image is current) |
| `start-slugs-once.js` | Expands a **local** cohort file into positional slug args for images that predate a new cohort JSON (avoids rebuilding the image just to ship one run) |
| `pull-latest-from-blob.js` | Bulk-downloads `output:latest:*` blobs into a local staging dir (translating `:`-separated blob keys back to filenames) to assemble a pack from cloud state; writes RAW, no safe-write, and refuses to target `output/latest` itself |
| `seed-latest-from-local.js` | One-way, `scraped_at`-guarded reconcile of local NRI-variant artifacts into blob, mirroring `lib/safe-write.js` verdicts, so locally-collected data (that never reached blob) isn't lost from a blob-built pack |
| `restore-banks-to-blob.js` | Targeted restore: uploads a named, explicit list of banks' local `output/latest` files over blob unconditionally (for when blob holds a clobbered/thin version and local is trusted) — refuses to run without `--banks`; dry-run by default, `--apply` to execute |
| `push-bank-domains-merge.js` | One-shot merge of local → cloud `bank-domains.json`, preferring local except for run-authored fields (`cloud_block_status`, `cloud_capability`) which keep cloud's copy when newer; this is the fix for the "cloud pull overwrites the registry" gotcha (see overview.md §4) |
| `bootstrap-curated-rate-files.js` | Uploads operator-curated per-bank rate files (that exist locally/in git but never reached blob) so cohort runs stop perpetuating the gap; idempotent (`--overwrite false`) |
| `deploy-smoke.js` | Full deploy-image + trigger + poll + verdict cycle in one command; exits 0 only on a real `business_outcome=success` |

**Gotcha to internalize:** `cloud/sync.js pull` downloads `bank-domains.json` from blob
and overwrites the image's git copy on every run. A registry fix baked into the image
does *not* take effect until it's also pushed to blob — that's what
`push-bank-domains-merge.js` is for.

---

## `scripts/pack/` — pack build & PM deliverables

| Script | Purpose |
|---|---|
| `build-pm-deliverable.js` | Builds the PM-facing deliverable set per NRI variant (nre/nro/fcnr/gift): one CSV + one JSON subset per variant, plus a stdout stats block for the PM brief |
| `build-fcnr-only-pack-2026-06-15.js` | Dated one-shot: FCNR-only pack + CSV + coverage summary from `output/latest/*_fcnr_rates.json` scraped on a specific day, with an explicit exclusion list of banks kept on their previous snapshot |

The main pack build itself is `pack/build-pack.js` at the repo root (not under
`scripts/`) — see [architecture.md](architecture.md) and [quality-checks.md](quality-checks.md).

---

## `scripts/utils/` — shared helpers

Common code required by many scripts above. **`slugify.js` is the canonical slug
source** — every script and the agent itself must derive `bank_code` through it, never
by hand-composing a slug from a bank name. Hand-composed slugs are the historical root
cause of bank-count drift between the registry, `output/latest/`, and the pack (see
`project_slug_consistency` in project memory). `scripts/reconcile-runs.js` exists
specifically to repair drift after the fact — prefer not needing it.

| Script | Purpose |
|---|---|
| `slugify.js` | **Canonical** slug generator (CJS port of the TS `helpers.ts` original). CLI mode: `node scripts/utils/slugify.js "Bank Name"` |
| `load-cohort.js` | Loads a named cohort from `data/cohorts/<name>.json`; validates shape (`bank_code` required) |
| `parse-tenure.js` | Parses tenure text ("7 days to 14 days", "above 5 years", etc.) into `{minDays, maxDays}`; CJS port of `tenure-maps.ts` |
| `normalize-rates.js` | Renames agent-guessed field aliases (e.g. `slabs` → `rate_slabs`) to the canonical rate-file schema |
| `validate-rates.js` | Validates extracted rates against bounds; consumes constants from `validation-constants.js` |
| `validation-constants.js` | CJS twin of `packages/shared/src/validation/` (ADR-014) — numeric bounds must stay in sync; a drift-check test asserts it |
| `normalise-currency.js` | Normalizes currency spellings/suffixes ("EURO", "USD (Above 5L)") to canonical 3-letter ISO codes for FCNR/GIFT dedup |
| `config-defaults.js` | Default field values for bank discovery configs; fills gaps / strips defaults for compact storage |
| `classify-verdict.js` | Shared failure-bucket classifier used by both `bulk-triage.js` and `bulk-author.js` so the two tools never disagree on a bucket's meaning |
| `extract-bank-fragment.js` | Extracts one bank's registry entry + provenance metadata, for per-bank blob upload of a registry fragment |
| `parse-csv.js` | RBI master bank-list CSV parsing (quoted-field + shifted-column handling) |
| `parse-pdf-rate-lines.js` | PDF rate-line parsers (legacy 3-column regex + column-aware hint-driven parser) used by the PDF extractor |
| `trace-parser.js` | Streaming parser for `claude -p --output-format stream-json` transcripts — builds a structured summary (tool calls, tokens, cost) |
| `logger.js` | Structured 5-level logger (error/warn/info/debug/trace) with console + file streaming |
| `index.js` | Barrel export of `slugify`, `parseTenure`, `validateRate`/`validateSlabs`, `CONFIG_DEFAULTS` |

---

## `scripts/analysis/` — ad hoc & recurring analysis

Largely one-off, often dated (`*-2026-06-10.js` etc.) investigation scripts written for
a specific sprint question (30+ files). Two are recent, general-purpose additions worth
knowing; the rest are historical record, not a stable API — read a file's own header
before reusing it in a new context.

| Script | Purpose |
|---|---|
| `url-health-probe.js` | Read-only: for a cohort, fetches every stored NRI rate-page URL and classifies `LIVE-OK` / `LIVE-SUSPECT` / `DEAD` — answers "is `--rates-only` safe, or does this bank need re-discovery?" |
| `designate-nri-quality.js` | Classifies each bank×variant by where it breaks (fetch vs parse), combining a live URL probe with fresh extractor slab counts from run logs; writes a durable `nri_quality_status` into `bank-domains.json` (behind `--apply`) so future runs skip known-broken auto-attempts |
| `coverage-map.js`, `failure-inventory.js`, `rate-sanity-audit.js`, `nri-target-list.js`, `triage-cohort-run.js`, `compare-cohort-runs.js`, … | Assorted coverage/failure/triage reports over a run or cohort |
| `harvest-goldens.js`, `harvest-golden-html.js` | Harvest golden HTML/expected-JSON fixtures for the extractor golden-test suite |
| remaining dated files (`*-fcnr-*`, `*-2026-06-*`, etc.) | Sprint-specific investigations: FCNR misses, currency normalization, sub-threshold recovery audits, cloud-incapable candidate scoring |

---

## `scripts/registry/` — `bank-domains.json` maintenance

| Script | Purpose |
|---|---|
| `mark-capability.js` | Operator CLI for manual `cloud_capability` overrides: `node scripts/registry/mark-capability.js <bank-code> <capable\|incapable> "<reason>"`. Writes via `safeWriteArtifact` with `source='operator'`, so it dominates prior auto-detected verdicts |
| `seed-cloud-capability.js` | One-shot migration seeding `cloud_capability` from a multi-signal candidate list (`batch_failure`, `partial_silent_fingerprint`, `regressed_to_zero_slabs`); only touches banks with ≥2 signals — single-signal banks need a probe first |

---

## `scripts/recovery/` and `scripts/restore/` — repairing clobbered data

Two related but distinct families, both born from real data-loss incidents. Every file
here is dated and scoped to a specific regression — read the header before assuming a
script is safe to re-run against current state. None of these is directly reusable for
a *newly*-clobbered bank today; they're a reference for *how* past recoveries were done
(git-HEAD diff, pack-snapshot reconstruction, explicit bucket lists). For a live
restore-to-blob need, use `scripts/azops/restore-banks-to-blob.js` instead.

- **`scripts/recovery/*-fcnr-direct-2026-06-15.js`** (one file per bank, ~30 files) —
  per-bank direct-fetch recovery scripts from the 2026-06-15 FCNR recovery push, for
  banks whose registered extractor/template wasn't working. Also
  `best-per-variant-2026-06-11.js` (cross-bank "pick the best available version per
  variant" chooser).
- **`scripts/restore/*`** — larger, multi-bank restore operations:
  - `restore-regressed-rate-files.js` — `git checkout HEAD --` for any rate file whose
    working-tree slab count regressed below git-HEAD (Sprint 010 Phase 0, a 232-file /
    -24% regression)
  - `restore-overwritten-rates-2026-06-09.js` — restores specific buckets (R1/R2/R6)
    where a cohort run overwrote non-empty rate files with `rate_slabs: []`
  - `restore-r3-head-wins-2026-06-09.js` — restores 48 (bank, variant) pairs where HEAD
    strictly beats the current extraction (root cause: extractors declared in the
    registry but not registered in `lib/extractors/dispatch.js#REGISTRY`, silently
    falling back to a USD-only LLM path)
  - `restore-subthreshold-2026-06-10.js` — two-step recovery (git-checkout for
    partially-recoverable banks, pack-snapshot reconstruction for the rest), writes
    tagged `_reconstructed_from_pack` via `safeWriteArtifact`

---

## `scripts/refresh/` — the periodic re-check pipeline

A staged pipeline (phases 1-4) for cheaply re-checking whether already-discovered
banks' rates have changed, without paying full re-discovery cost:

| Script | Phase | Purpose |
|---|---|---|
| `build-cohort.js` | 1 | Walks `output/latest/`, emits a manifest of every (bank, variant) pair with prior `effective_date`/`source_url`/`scraper_type` |
| `detect-changes.js` | 2 | One HTTP GET per URL; cheap-signal change classification (Last-Modified, ETag, hash, PDF byte hash); caches bodies only for pairs Phase 3 needs |
| `extract-and-diff.js` | 3 | Extracts candidate rates from cached bodies (routes to HTML/PDF/Playwright as needed) and diffs against current `output/latest` |
| `sanity-gate.js` | 3a | Flags implausible candidate diffs (>75bps single-slab move, general/senior-rate collapse, etc.) for LLM verification instead of auto-promoting |
| `verify-with-llm.js` | 3a′ | Re-runs extraction via LLM on sanity-gate-flagged candidates against the same cached body; outcome is `LLM_REPLACED` / `LLM_CONFIRMS` / `LLM_REJECTED` |
| `promote.js` | 3b | Writes extracted sidecars into `output/latest/` through `lib/safe-write.js` (curated files divert to `.pending.json`); skips zero-slab / no-change candidates unless explicitly included |
| `report.js` | 4 | Writes `report.md` (operator/PM) + `report.json` (machine-readable) summarizing the refresh run |

---

## `scripts/monitoring/`

Empty at the time of writing — no files under this path in the current checkout.
Monitoring/observability concerns today are covered by `scripts/azops/cloud-status.js`,
`reconcile.js`, and the Log Analytics setup in [deployment.md](deployment.md). If you
find content here, this folder is presumably a landing spot for future
observability tooling — verify before relying on this note.

---

## `scripts/snapshot/` — source-of-truth HTML/PDF snapshots

| Script | Purpose |
|---|---|
| `backfill-snapshots.js` | Re-fetches each rate file's `source_url` and stores a content-addressed snapshot keyed to `scraped_at`; backfilled captures are tagged `post_hoc:true` since the bytes may have drifted since the original scrape |
| `backfill-golden-from-snapshots.js` | Activates the golden-test gate: writes a `<bank>.html` companion fixture only when the CURRENT template still reproduces the committed `expected.json` against that snapshot (i.e., the bank hasn't drifted); drifted banks are reported, not silently rebaselined, unless `--rebaseline` |

---

## `scripts/audit/` — independent correctness measurement

| Script | Purpose |
|---|---|
| `sample-correctness-audit.js` | Stratified-sample correctness audit: an LLM judges sampled slabs against Phase-1 snapshots, producing a per-(bank_type × extraction_method) error rate with a confidence interval; CONTRADICT cases go to a human-adjudication worklist |
| `cross-check-all.js` | For every variant with a snapshot, re-extracts via an independent LLM read and diffs against shipped slabs (`FULL`/`PARTIAL`/`DISAGREE`/`LLM_NO_DATA`); **measures only**, never auto-replaces (that's `refresh/verify-with-llm.js`'s job) |

See [quality-checks.md](quality-checks.md) for how these signals feed confidence
scoring.

---

## `scripts/cohort/` — cohort assembly variants

| Script | Purpose |
|---|---|
| `build-fcnr-2026-06-11.js` | Dated one-shot: FCNR-refresh cohort = every bank currently publishing FCNR in the pack |
| `build-variant-cohort.js` | General variant-cohort builder using a UNION rule: pack-has-data OR registry-declares-a-source-for-the-variant (fixes the gap where a declared-but-never-extracted variant was silently dropped) |
| `split.js` | Splits a cohort into `-cloud.json` / `-local.json` sub-cohorts + a peer-run "beacon" file, for split-execution runs against WAF-blocked banks |
| `run-local-only.js` | Runs the local half of a split cohort (wraps `run-batch.js`), then patches the beacon with `local_run_label` so the merge phase can find it |

The general-purpose cohort builder most people reach for is `scripts/build-cohort.js`
(repo-root-relative, not under `cohort/`) — see the table below.

---

## `scripts/merge/` — split-run reconciliation

| Script | Purpose |
|---|---|
| `merge-runs.js` | Reads a peer-run beacon (`data/peer-runs/<cohort>.json`), merges the cloud-run and local-run halves of a split cohort via `lib/merge/run-merger.js`, prints a decision summary. Companion to `scripts/cohort/split.js` |

---

## `scripts/confidence/` — confidence sidecars

| Script | Purpose |
|---|---|
| `build-confidence.js` | Computes per-variant confidence signals (structural checks, freshness, extraction method, cross-check agreement, sampling-audit error rate where available) and writes `output/latest/_confidence/<bank>__<variant>.json`; `pack/build-pack.js` reads these behind `FIRA_EMIT_CONFIDENCE` so the pack build itself stays LLM-free |

---

## `scripts/e2e/` — synthetic end-to-end harness

| Script | Purpose |
|---|---|
| `synth-validate.js` | Exercises the full split (Phase 4) + merge (Phase 5) chain against fixture data in a tmp root, with no cloud/AOAI calls — proves the plumbing on every commit without the cost of a real large cohort |

---

## `scripts/macro/` — macro-rate proposals (ADR-017)

| Script | Purpose |
|---|---|
| `propose-repo-rate.js` | Records a *researched* RBI repo-rate value into `data/macro-rates.proposed.json` for operator review. Never writes the approved `data/macro-rates.json` and never sets `approved_by` — activation is strictly the operator's call via `bin/approve-macro-rate.js`, per the no-fake-approvals rule |

---

## Top-level `scripts/*.js` — core one-off and pipeline-adjacent scripts

| Script | Purpose |
|---|---|
| `quality-gate.js` | Same engine as `npm run quality-gate`; classifies pack changes into REGRESSION/ANOMALY/WARN/GAIN/STABLE against a baseline, exits non-zero on unaccepted block-class findings |
| `compare-pack.js` | Diffs two `rates-pack.json` files: net bank delta, per-variant slab gains/losses, top movers. Exports `totalsByBank` (used by `quality-gate.js`) |
| `reconcile-runs.js` | Scans `output/latest/` for slug/name mismatches, renames to canonical slugs (via `slugify`), merges duplicates, adds `discovery_completeness`/`data_freshness` fields |
| `check-write-discipline.js` | The `pretest`/`check:writes` gate described above (ADR-012 enforcement) |
| `build-cohort.js` | Merges multiple cohort JSON files into one, dedup by `bank_code` (first occurrence wins) |
| `build-cohort-from-csv.js` | Generates a cohort JSON straight from the RBI master CSV, filtered by category list |
| `bulk-author.js` | Bulk template authoring with quality gates: fetch → fingerprint → cluster-reuse (one LLM call per template cluster) → propose → extract → gate to PASS/REVIEW/FAIL; `--write` persists PASS entries to `bank-domains.json`, audit-tagged `persisted_by: "bulk-author"` |
| `bulk-triage.js` | Companion to `bulk-author.js`: buckets REVIEW/FAIL results by failure pattern (WAF, under-extraction, propose-failed, out-of-range, etc.) using the shared `classify-verdict.js` |
| `bulk-revert.js` | Companion to `bulk-author.js`: deletes registry entries tagged `persisted_by: "bulk-author"` (by `--all`, `--since`, `--banks`, or `--from-report`); dry-run by default, `--execute` to actually delete |
| `author-template.js` | The **only** path that writes `template` blocks into `bank-domains.json` for a single bank (the agent itself never auto-writes) |
| `extract_rates.js` | Deterministic (no-LLM) rate extraction router: reads a bank's `_config.json`, dispatches to the right extractor, writes `_rates.json` |
| `fetch_rates_playwright.js` | Playwright fetch CLI with anti-bot/interaction flags (`--scroll`, `--tabs`, `--accordions`, `--selects`, `--intercept`, `--wait-for-selector`) |
| `run-extract-only.js` | Batch `extract_rates.js` over all banks with existing configs — the "recurring scraper," zero LLM cost |
| `run-domain-discovery.js` | Discovers bank domains in bulk via the Azure OpenAI Responses API's built-in web-search tool; merges results into `bank-domains.json` |
| `guess-bank-in.js` | Zero-cost domain-guessing: generates candidate `.bank.in` domains from naming patterns and HEAD-probes them, instead of a paid web search |
| `seed-domains.js` / `sync-domains.js` | Backfill/merge `bank-domains.json` from existing `_config.json` outputs; `sync-domains.js` never overwrites non-null existing fields |
| `heal_rates_schema.js` | One-off migration normalizing legacy/alias field names in existing rate files to the canonical schema (safe to re-run) |
| `cleanup-output-latest.js` | Pre-cohort cleanup of `output/latest/`, optionally snapshotting to `output/runs/<label>/` first |
| `list-augment-targets.js` | After a cloud cohort run, emits the slug list of banks needing a local-augment pass (partial-silent marker, missing config, etc.) |
| `migrate-hints-to-column-maps.js` | One-shot migration: `extraction.hints` → `template.extract.column_map` in the registry |
| `migrate-pilot-wave.js` | Wave-level orchestration around `author-template.js --write`, with wave composition hard-coded from a sprint plan doc (prevents CLI typos from swapping in the wrong bank) |
| `run-dccb-diagnostic.js` / `run-phaseB-rerun.js` | Dated diagnostic re-runs over a stratified DCCB sample / a 12-bank triaged set, to measure before/after lift from a fix |
| `run-dual-gate.js` | Runs the quality gate against two baselines side by side (pre-flight for a specific pack re-run) |
| `engine-probe.js` | Runs a cohort under multiple engine (tier) configs and tallies slab count / cost / duration — answers "does forcing Tier 2 recover more slabs, and at what cost?" |
| `analyze-gaps.js` | Coverage dashboard (default) or gap-list generator (`--list <type>` → slug file for `run-batch.js --banks`) |

---

## Which script do I reach for?

| I want to… | Reach for |
|---|---|
| See what's actually deployed vs expected in the cloud | `scripts/azops/drift-check.js` (`npm run cloud:drift`) |
| Check the last few cloud runs and whether they truly succeeded | `scripts/azops/cloud-status.js` (`npm run cloud:status`) |
| See what's in blob vs local for a bank | `scripts/azops/pull-latest-from-blob.js` + diff, or `scripts/analysis/url-health-probe.js` for URL liveness specifically |
| Kick off a cloud cohort run | `scripts/azops/start-cohort.js` (image has the cohort) or `start-cohort-run.js` / `start-slugs-once.js` (image predates it) |
| Restore a clobbered/thin bank in blob from trusted local data | `scripts/azops/restore-banks-to-blob.js --banks <slugs> --apply` |
| Fix the registry blob after a local registry improvement | `scripts/azops/push-bank-domains-merge.js` |
| Build a cohort from scratch (category filter) | `scripts/build-cohort-from-csv.js` |
| Merge/dedupe multiple existing cohort files | `scripts/build-cohort.js` |
| Build a variant-specific cohort (e.g. FCNR) correctly (not just "pack has data") | `scripts/cohort/build-variant-cohort.js` |
| Build the pack and check it's safe to ship | `npm run build-pack` then `npm run quality-gate` |
| Build the PM-facing CSV/JSON deliverable | `scripts/pack/build-pm-deliverable.js` |
| Diff two packs / see top movers | `scripts/compare-pack.js` |
| Get a canonical slug for a bank name | `scripts/utils/slugify.js` (never hand-compose) |
| Re-check known banks cheaply for rate changes | `scripts/refresh/*` phase pipeline (`build-cohort.js` → `detect-changes.js` → `extract-and-diff.js` → `promote.js` → `report.js`) |
| Bulk-author new bank templates with LLM proposals | `scripts/bulk-author.js`, then `scripts/bulk-triage.js` to bucket failures |
| Undo a bad bulk-author write | `scripts/bulk-revert.js` |
| Manually override a bank's cloud-capability flag | `scripts/registry/mark-capability.js` |
| Measure real extraction correctness (not just structural checks) | `scripts/audit/sample-correctness-audit.js` / `scripts/audit/cross-check-all.js` |
| Check for unauthorized raw file writes before committing | `npm run check:writes` |

---

*Cross-references: [overview.md](overview.md) (system map), [architecture.md](architecture.md)
(runtime/control-flow), [deployment.md](deployment.md) (Azure topology these azops scripts
target), [quality-checks.md](quality-checks.md) (safe-write, quality gate, confidence
scoring — the policies several scripts above enforce or feed), [operator-guide.md](operator-guide.md)
(day-to-day command sequences, if present in your checkout — it is the runbook this
catalog complements).*
