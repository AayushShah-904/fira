# Step 1 (d/e/f) — Authoring CLI + golden HTML harvester + Phase A.4 re-attempt

**Date:** 2026-05-24
**Design:** `../design/author-template-cli.md`, `../design/fetch-layer-hardening.md` (Phase A.4 section)
**Plan:** `../plan/sprint-006-scope.md`

## What landed

Three additive deliverables that complete Step 1 of Sprint 6:

| File | Purpose | Tests |
|---|---|---:|
| `scripts/author-template.js` (Step 1d) | Operator CLI: fingerprint a bank, suggest reuse, replay extractor, `--write` to persist template block | smoke (`--help`, agent refusal) |
| `lib/prompts/author-template.md` (Step 1d) | LLM-propose prompt (loadable, not yet wired into the CLI) | n/a |
| `scripts/analysis/harvest-golden-html.js` (Step 1e) | Backfills 50 `.html` companions in `tests/golden-html/` using new `fetch_html.js` | smoke (`--help`, agent refusal) |
| `lib/orchestrator/reattempt.js` (Step 1f) | Phase A.4 deep fix: env-gated re-attempt path for the ~31 NSUCB/DCCB `scraper_type:null` failure cluster | 15 unit tests |

Full suite: **993 pass / 0 fail / 51 skip** (vs sprint-006 step-1a/b/c close at 978).

## Step 1d — `scripts/author-template.js`

The CLI works in this commit; the LLM-propose path is stubbed (prints an actionable message for the operator). What's in:

- Resolution from `data/bank-domains.json` with `--from-url` / `--from-file` overrides
- Fetch via the new `lib/fetch/fetch_html.js` (or `--from-file` for offline authoring)
- HTML snapshot to `tmp/author/<bank>/<variant>.html` (safe-write-exempt; diagnostic only)
- Fingerprint via `lib/templating/fingerprint.js`
- Cluster-match scan across all existing `template` blocks; suggests reuse with `[y/N]` in interactive mode
- Replay through chosen extractor; prints slabs + delta vs `tmp/baseline-pre-reset/<bank>_rates.json`
- `--write` persists via `lib/safe-write.js` with `kind: 'registry-file', source: 'operator'`

Refusal logic (intentional split from `bin/approve-accept.js`):
- LLM-propose flow runs fine under agents — the agent CAN propose; operator review is the trust boundary, not the proposal
- `--write` requires TTY + non-agent + non-CI (exits 11/12/10 with distinct messages)

**Smoke verified:** `--help` exits 0; `--write` under `CLAUDECODE=1` exits 11 with the expected refusal message.

**Deferred (Sprint 7 follow-up):** the LLM-propose flow itself. The prompt template is in `lib/prompts/author-template.md` ready to wire; the AOAI integration test setup requires real-AOAI keys in CI which Sprint 6 scope doesn't include. The CLI currently exits 4 with an actionable operator message when the LLM-propose path would have fired. For Sprint 6 Step 4 migration, the operator uses `--reuse-template <id>` to pick an existing template_id, which works fully.

## Step 1e — `scripts/analysis/harvest-golden-html.js`

CLI script. Walks `tests/golden-html/*.expected.meta.json`, reads `rate_page_url`, fetches live via `fetch_html.js`, writes `<bank>.html` alongside.

- Skips banks where `<bank>.html` already exists (override with `--force`)
- Filters with `--banks bank1,bank2` or `--limit N`
- Summary written to `tmp/analysis/harvest-golden-html-summary.json` per run
- Refuses to run under agents unless `RDA_AGENT_HARVEST_OK=1` (operator override for supervised batch runs)

**Smoke verified:** `--help` exits 0; agent-mode invocation exits 11 with expected refusal.

This is the script that **flips the 50 golden test skips into real assertions**. When the operator runs it post-Step-3 (so the extractors exist), the golden tests in `tests/extractors/golden.test.js` start biting automatically.

## Step 1f — `lib/orchestrator/reattempt.js`

Sprint 5's Phase A.4 documented that `lib/actions/classify_rate_page.js:61-63` already handles unknown `cached_kind` resiliently — but the orchestrator was never RE-INVOKED for the ~31 NSUCB/DCCB banks whose LLM-agent path wrote stub configs with no rates. Step 1f provides the env-gated re-attempt path.

Module exports:
- `FLAG_NAME` — `'RDA_REATTEMPT_UNKNOWN'`
- `shouldReattempt({config, rates, env})` — pure function returning `{eligible, reason, signals}`
- `listReattemptCandidates({outputDir})` — walks `output/latest/` and decides per-bank
- `reattemptOne({bank_code, config, log, _fetchHtml?, _pickExtractor?})` — runs the new fetch + dispatcher path for one bank

**Eligibility rules** (intentionally narrow to avoid auto-overwriting operator-curated data):
- ✅ flag on + has config + `scraper_type` ∈ {null, unknown} + has rate_pages + 0 slabs
- ❌ flag off
- ❌ no config (never attempted — needs full discovery, not re-attempt)
- ❌ rates already extracted (don't re-overwrite)
- ❌ `scraper_type: manual` (operator-curated)
- ❌ `scraper_type: html_js` (use `author-template.js` manually — operator should fingerprint)

The flag is **OFF by default**. Step 4 pilot migration will turn it on for supervised batches and inspect the manifest's `reattempt_status` field afterward. Until then, existing runs are unaffected.

15 unit tests cover every eligibility branch + the four `reattemptOne` outcomes (recovered / no_slabs / fetch_failed / no_extractor / no_rate_page).

## Verification

```
$ node --test tests/lib/orchestrator/reattempt.test.js   → 15 pass
$ npm test                                                → 993 pass / 0 fail / 51 skip
$ node scripts/check-write-discipline.js                  → clean (128 files scanned)
$ node scripts/author-template.js --help                  → exit 0
$ node scripts/author-template.js x --write               → exit 11 (CLAUDECODE refused)
$ node scripts/analysis/harvest-golden-html.js --help     → exit 0
$ node scripts/analysis/harvest-golden-html.js --banks x  → exit 11 (CLAUDECODE refused)
```

## Step 1 closes here

| Sub-step | Deliverable | Status |
|---|---|---|
| 1a | `lib/fetch/fetch_html.js` + `_playwright_session.js` (14 tests) | ✅ committed |
| 1b | `lib/fetch/challenge_detect.js` (19 tests) | ✅ committed |
| 1c | `lib/fetch/fetch_pdf.js` + `lib/azure/doc_intelligence.js` (20 tests) | ✅ committed |
| 1d | `scripts/author-template.js` + `lib/prompts/author-template.md` | ✅ this commit (LLM-propose deferred to Sprint 7) |
| 1e | `scripts/analysis/harvest-golden-html.js` | ✅ this commit |
| 1f | `lib/orchestrator/reattempt.js` (15 tests) | ✅ this commit |

Sprint 6 next: **Step 2 — Phase D1 per-bank manifest.**

## Open follow-ups

- Wire LLM-propose flow into `scripts/author-template.js` (currently a stub print). Requires AOAI integration test setup. Sprint 7.
- Operator runs `scripts/analysis/harvest-golden-html.js` post-Step-3 to backfill the 50 fixtures. Operator action, post-merge.
- Step 4 migration turns on `RDA_REATTEMPT_UNKNOWN=1` for the 31-bank cluster (or a subset of it) and inspects the resulting manifest entries.
- Sprint 7 cleanup: refactor `lib/actions/extract_via_ocr.js` + `lib/actions/extract_via_vision.js` onto the new `lib/azure/doc_intelligence.js` (deferred from Step 1c).
