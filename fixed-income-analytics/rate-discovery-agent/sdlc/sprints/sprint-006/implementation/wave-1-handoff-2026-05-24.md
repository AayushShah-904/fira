# Wave 1 pilot handoff — 2026-05-24

**Purpose:** session memory will be cleared after this. This document is the resume-cold context for the next session continuing Wave 1 triage.

## Current state — one sentence

Sprint 6 engineering closed (13 commits, 1083 tests pass / 0 fail / 51 skip). Operator ran Wave 1 of the 50-bank pilot from a clean shell; **ALL 10 banks declined** — 1 harvest failure (apna-sahakari-bank-ltd, fetch_failed) + 9 operator-declined-persist because every template×bank pairing reduced slab count vs baseline. **Scenario E confirmed (see decision tree below) — systemic regression, not isolated.** No `template` blocks were written; Wave 2 is blocked until extractor coverage is fixed.

## Wave 1 actual outcome (resolved 2026-05-24)

| Bank | Harvest | Author-template `--write` |
|---|---|---|
| cuddapah-district-co-operative-central-bank-ltd | captured (94KB, 1 table, 11 FD slabs visible) | declined — 0 slabs extracted vs 9 baseline |
| apna-sahakari-bank-ltd | **failed** (fetch_failed 66s + llm-fallback failed) | n/a — no golden HTML |
| ahmednagar-shahar-sahakari-bank-ltd-ahmednagar | captured (44KB) | declined — slab reduction vs baseline |
| bagalkot-central-co-operative-bank-ltd | captured (44KB) | declined — slab reduction vs baseline |
| ajara-urban-co-operative-bank-ltd | captured (45KB) | declined — slab reduction vs baseline |
| state-bank-of-india | captured (498KB) | declined — slab reduction vs baseline |
| bank-of-baroda | captured (487KB) | declined — slab reduction vs baseline |
| hdfc-bank-limited | captured (1.2MB) | declined — slab reduction vs baseline |
| icici-bank-limited | captured (1.7MB) | declined — slab reduction vs baseline |
| the-andhra-pradesh-state-co-operative-bank-ltd | captured (227KB) | declined — slab reduction vs baseline |

**Verified diagnostic 2026-05-24:** all 10 entries in `data/bank-domains.json` show `template=no`. `tmp/analysis/harvest-golden-html-summary.json` confirms `captured: 9, failed: 1`.

**Root cause (cuddapah, illustrative):** the table is 4-col `[S.No, Particulars, Existing, REvised Roi %]` with 11 FD slabs + 1 savings row, no senior-citizen column. The assigned template `coop-bankin-3col-tenure-general-senior` expects `[tenure, general, senior]` in cols [0,1,2], so col 0 ("a", "b", "1", "2"…) won't parse as tenure → 0 slabs. The other 8 captured banks each lost slabs for analogous template/structure mismatches — Sprint 6's pre-pinned template assignments in `scripts/migrate-pilot-wave.js` lines 38-52 don't actually match the per-bank HTML structures.

## Forward path (decision pending operator)

This is Scenario E. Options, in order of risk:
1. **Sprint 6.5** — pause pilot. Replay each declined bank with `author-template.js --from-file <html>` (no `--write`) to surface the exact slab-count delta per bank, group by failure mode, ship targeted extractor/template additions (likely needs at least: 4-col `coop-tenure-existing-revised`, plus whatever PSB/PVB tables actually look like vs `psb-pdf-rate-card-3col` / `pvb-multi-variant`). Re-author Wave 1 before Wave 2.
2. **Re-pin templates in `migrate-pilot-wave.js`** without adding extractors — only viable if there's an existing template that matches each bank's actual structure, which Wave 1's full-decline outcome suggests is unlikely.
3. **Skip + record** — leave Wave 1 with zero templates persisted, treat as a real signal that the 50-bank pilot cohort selection mis-estimated extractor coverage, and re-scope Sprint 7 around extractor breadth instead of cohort expansion.

The agent cannot run any of these to completion — `author-template.js --write` and `migrate-pilot-wave.js --execute` are operator-gated. The agent CAN run the no-`--write` replay (read-only) across all 9 captured banks to produce the failure-mode grouping that informs option 1 vs 3.

## Resume here

The next session must start by asking the operator to paste the output of the 4-step diagnostic block in PowerShell. The exact script is in this conversation's most recent assistant message before this handoff, but reproduced here for completeness:

```powershell
Write-Host "=== HARVEST SUMMARY ==="
type tmp\analysis\harvest-golden-html-summary.json

Write-Host "`n=== CAPTURED HTML FILES ==="
Get-ChildItem tests\golden-html\*.html | Where-Object { $_.LastWriteTime -gt (Get-Date).AddHours(-1) } | Select Name, Length

Write-Host "`n=== TEMPLATE BLOCKS WRITTEN ==="
$wave1 = @(
  'cuddapah-district-co-operative-central-bank-ltd',
  'apna-sahakari-bank-ltd',
  'ahmednagar-shahar-sahakari-bank-ltd-ahmednagar',
  'bagalkot-central-co-operative-bank-ltd',
  'ajara-urban-co-operative-bank-ltd',
  'state-bank-of-india',
  'bank-of-baroda',
  'hdfc-bank-limited',
  'icici-bank-limited',
  'the-andhra-pradesh-state-co-operative-bank-ltd'
)
$reg = Get-Content data\bank-domains.json -Raw | ConvertFrom-Json
foreach ($b in $wave1) {
  $hasTemplate = if ($reg.$b.template) { "YES (id=$($reg.$b.template.template_id))" } else { "no" }
  $htmlExists = Test-Path "tests\golden-html\$b.html"
  $htmlSize = if ($htmlExists) { (Get-Item "tests\golden-html\$b.html").Length } else { "-" }
  Write-Host ("{0,-60} html={1,-10} template={2}" -f $b, $htmlSize, $hasTemplate)
}

Write-Host "`n=== CUDDAPAH HTML DIAGNOSTIC ==="
if (Test-Path tests\golden-html\cuddapah-district-co-operative-central-bank-ltd.html) {
  $h = Get-Content tests\golden-html\cuddapah-district-co-operative-central-bank-ltd.html -Raw
  Write-Host "size: $($h.Length) bytes"
  Write-Host "<table> count: $((Select-String -InputObject $h -Pattern '<table' -AllMatches).Matches.Count)"
  Write-Host "<tr> count: $((Select-String -InputObject $h -Pattern '<tr' -AllMatches).Matches.Count)"
  Write-Host "% (percent sign) count: $((Select-String -InputObject $h -Pattern '%' -AllMatches).Matches.Count)"
}
```

## Known facts at handoff time

| Item | Value |
|---|---|
| Wave 1 banks captured by harvest | 9 of 10 (1 failed — bank unknown, see `tmp\analysis\harvest-golden-html-summary.json`) |
| First bank attempted | cuddapah-district-co-operative-central-bank-ltd |
| First bank extraction result | 0 slabs (baseline: 9 slabs) — `rows_seen=0` means the cheerio table-picker returned no positively-scored table |
| Operator action on first bank | typed N (correctly declined persist) |
| Fingerprint of cuddapah HTML | `sha1:452d3745470b9eec18bdd62a7b36623d6944bbc6`, framework=jquery+wordpress, slab_bucket=9-15, candidate_tables=1 |
| Outcome of banks 2-10 | UNKNOWN at handoff — operator has not pasted output |
| Tasks #15-34 in todo list | Sprint 6 sub-steps; #26 (Step 4 pilot migration) is the only `in_progress`; #29 (Step 3c retirement) blocked on Step 4; rest completed |

## Triage decision tree (post-paste)

Once operator pastes the diagnostic, three likely scenarios:

### Scenario A: cuddapah HTML has tables but extractor missed them

- Diagnostic shows `<table> count` ≥ 1 AND `%` count > 5
- Root cause: `_generic-html-3col` table-picker scored every table ≤ 0 (likely due to `NOISE_PATTERNS` in `lib/templating/_helpers/score-table.js` matching `w.e.f.` / `card rate` / etc. in EVERY table — or the wp-content theme uses a class structure the cheerio query missed)
- Fix path: read 200 lines of `tests/golden-html/cuddapah-district-co-operative-central-bank-ltd.html` to identify what's special; either lift the picker noise penalty for known-rate-page contexts OR add an explicit `template.extract.table_selector` to cuddapah's authoring
- Decision: re-run author-template.js with an explicit `--column-map` override (would need to add that flag), or skip cuddapah for Wave 1 and capture as a Sprint 7 fix

### Scenario B: cuddapah HTML has zero tables (page was JS-rendered, fetch caught the shell)

- Diagnostic shows `<table> count` == 0 AND size < 50KB
- Root cause: the bank's rate page is a SPA; default `waitForFunction` (`tables-with-%`) timed out, so we captured the empty shell
- Fix path: re-harvest with a per-bank `template.fetch.wait_for_function` override OR `--no-default-wait` flag; possibly needs `--click-to-reveal` for an accordion
- Decision: this is a Phase B fetch-tuning issue, not an extractor issue

### Scenario C: cuddapah page was a 404 / wrong URL

- Diagnostic shows file size very small (< 5KB) OR file doesn't exist
- Root cause: `data/bank-domains.json[cuddapah-...].rate_pages.fd` is stale (404)
- Fix path: operator updates the URL in `data/bank-domains.json`, re-harvest, retry

### Scenario D: other Wave 1 banks succeeded — cuddapah is an isolated edge case

- Diagnostic shows ≥ 8 of 10 banks got `template=YES` in registry
- Decision: keep Wave 1's committed banks (run pack quality-gate to confirm no regressions), skip cuddapah, move to Wave 2 next session

### Scenario E: most banks failed (similar 0-slab pattern)

- Diagnostic shows ≤ 3 of 10 with `template=YES`
- Decision: do NOT proceed to Wave 2. Root cause is systemic — likely `_generic-html-3col` doesn't handle the actual co-op page structure. Sprint 6.5 to fix the extractor + re-author Wave 1 before any further commits.

## What MUST happen before any commit during triage

Per Sprint 5 Phase D2 trust boundary — operator at TTY, non-agent shell, for any of:
- Re-authoring a bank (`scripts/author-template.js --write`)
- Signing a pre-emptive accept (`bin/approve-accept.js`)
- Modifying `data/bank-domains.json` directly (use `safe-write.js` via the CLIs)

The agent can:
- Read captured HTML to diagnose
- Patch extractor code (`lib/extractors/_generic-html-3col.js`, etc.)
- Run unit tests
- Commit code changes
- Run `node scripts/migrate-pilot-wave.js 1 --dry-run` (read-only)
- Run `node scripts/author-template.js <bank> --from-file <html>` WITHOUT `--write` (read-only preview)

## Sprint 6 architecture refresher (for the next session, cold)

Foundation layers built and tested (1083 tests passing):

```
lib/fetch/
  fetch_html.js     — Playwright with retry escalation (default → stealth → firefox → llm-fallback)
                       Default waitForFunction: tables-with-% + ≥3 tr
                       Per-bank template.fetch overrides; HAR capture on failure
  fetch_pdf.js      — pdfjs first; DocIntel fallback when <3 slabs OR multi-column hint
  challenge_detect.js — pure WAF detector (cloudflare/akamai/cloudfront/imperva)
  _playwright_session.js — per-rung browser launcher

lib/azure/
  doc_intelligence.js — shared DocIntel client (buildClient, analyzeUrl, analyzeBuffer)
                         extract_via_ocr.js now delegates here (Step 1g)

lib/extractors/
  dispatch.js                              — registry + fallback chain
  coop-bankin-3col-tenure-general-senior.js — Sprint 5 (.bank.in co-op family)
  psb-pdf-rate-card-3col.js                — PSB PDF rate cards (text + DocIntel)
  pvb-multi-variant.js                     — PVB regular/nre/nro + FCNR currency-matrix
  fb-multi-variant.js                      — FB non-WAF + FCNR currency-matrix
  ibu-static-pdf-quarterly.js              — IBU GIFT City PDFs (text + DocIntel)
  _generic-html-3col.js                    — Sprint 6 fallback (THIS is what failed on cuddapah)
  _llm-fallback.js                         — real AOAI extraction (Step 3d)
  _helpers/
    _assert_traceability.js                — anti-fabrication contract enforcement
    docintel-grid.js                       — cellsToGrid + classifyColumns
    currency-matrix.js                     — Pattern A/B FCNR extractors

lib/templating/
  fingerprint.js   — structural signature (tag-tree + headers + framework + tld)
  llm_propose.js   — LLM-propose flow for author-template.js
  synonyms.js      — header-token canonicalization
  _helpers/score-table.js — shared scorer

lib/manifest/
  per-bank-manifest.js — Phase D1 manifest builder + summary roll-up

lib/orchestrator/
  reattempt.js     — Phase A.4 re-attempt for scraper_type:null banks (env-gated)

scripts/
  author-template.js              — operator CLI; refuses --write under agents
  migrate-pilot-wave.js           — wave executor; --harvest-first chains harvest
  analysis/harvest-golden-html.js — captures HTML; falls back to bank-domains.json for URL
  migrate-hints-to-column-maps.js — Step 5 one-shot migration (dry-run + --write)

bin/
  approve-accept.js — HMAC-signed quality-gate accepts (Sprint 5 Phase D2)
```

## What's NOT done (operator-blocked or Sprint 7)

- **Wave 1 triage completion** — operator output paste pending
- **Wave 2 + Wave 3** — sequenced after Wave 1 clean
- **`extract_html_table.js` (1,870 LOC) retirement** — operationally blocked on Step 4 pilot completion
- **`lib/agent.js` / `lib/extraction-hint.js` / `prompts/discover.md` / `scripts/fetch_rates_playwright.js` deletion** — deprecation in place; deletion after Step 4
- **Cloud orchestration re-wiring** — Sprint 7
- **Long-tail banks 51–~300** — Sprint 7
- **WAF-blocked FB cluster (Amex/Barclays/Nova Scotia)** → manual via bin/approve-accept (Sprint 7)
- **BoI-IBU / IndusInd-IBU recovery** — vendor PDF research needed (Sprint 7)

## Durable artifacts (read these first if resuming cold)

| File | What it tells you |
|---|---|
| `sdlc/sprints/sprint-006/retrospection/retro.md` | Sprint 6 complete picture; what worked, what was deferred, what's pending operator |
| `sdlc/sprints/sprint-006/design/migration-runbook.md` | Per-wave + per-bank flow; parity protocol; pre-emptive accepts list |
| `sdlc/sprints/sprint-006/plan/pilot-50-cohort-selection.md` | All 50 pilot banks + alternates + composition rationale |
| `sdlc/sprints/sprint-006/plan/sprint-006-scope.md` | Exit criteria + scope decisions (5 phases + 50-bank pilot + local-first) |
| `~/.claude/projects/C--sw-BharatOmni-UFA-BIRD/memory/project_sprint006_status.md` | Sprint-level memory; agent-immune trust boundary explanation |
| `~/.claude/projects/C--sw-BharatOmni-UFA-BIRD/memory/reference_signed_accept_cli.md` | bin/approve-accept usage |
| `~/.claude/plans/last-several-sessions-have-curious-twilight.md` | The whole architectural-reset plan (Sprint 5 + 6 combined) |

## Last 5 commits (for git log context)

```
6f17d3c sprint-006(fix): harvest fallback to data/bank-domains.json + wave UX flags
db47f1d sdlc(sprint-006): retro — close out Sprint 6 architectural reset wiring
a34c801 sprint-006(step-5): Phase F begin retiring legacy paths
[...]   sprint-006(step-3e+3f): real DocIntel + currency-matrix paths
[...]   sprint-006(step-3d): wire real AOAI in _llm-fallback.js
```

## Pasteable first message for the next session

> Continuing from Wave 1 outcome (resolved 2026-05-24). All 10 banks declined — see "Wave 1 actual outcome" section in `sdlc/sprints/sprint-006/implementation/wave-1-handoff-2026-05-24.md`. Pick one of the three forward-path options in that doc, or run the no-`--write` replay across the 9 captured banks first to surface failure-mode grouping.

That single message + the handoff file is enough for the next session to resume cold.
