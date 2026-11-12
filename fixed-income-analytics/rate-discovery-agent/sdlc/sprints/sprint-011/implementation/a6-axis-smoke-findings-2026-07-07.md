# A6 pre-flight: live Axis smoke — findings (2026-07-07)

Run: `node run-discovery.js "Axis Bank Limited" --rates-only --log-level info`
(first live run after the Track A engineering batch dd382b6/c7a6b1e/cada2d8; log at
`output/runs/2026-07-07T0555_axis-bank-limited/`). Cost $0.010, 30s, exit 0.

## What the smoke verified (working)

| Item | Evidence |
|---|---|
| Item 18 RC1 fallback (bank_type from config when `--category` absent) | `[item-18] No --category passed; derived "Private Sector Bank (Indian)" from output/latest/axis-bank-limited_config.json` — all four products (fd, fd_nre, fd_nro, fd_fcnr) attempted |
| Item 18 coverage loop duplicate-guard | `[variant-coverage] … main loop already ran pdf on <url> with 0 slabs — skipping duplicate attempt` (no double extraction, no duplicate commits) |
| Item 19 footnote capture, live | `regulatory_constraints[0]` = the verbatim RBI 2026-06-08→09-30 lock-in paragraph; 15/33 slabs carry `regulatory_flag_keys: ["#"]`; markers stripped from `tenure_text` |
| Item 21 QC + slab filter | dedup dropped 8 (RFC-duplicate rows), payload clean, `extraction_confidence: high` |
| safe-write protection | regular/nre/nro files untouched on 0-slab outcomes (prior 54/72/162 slabs preserved) |

FCNR committed 33 slabs across USD/GBP/EUR/AUD/CAD via OCR from
`fcnr-rfc-deposits-13-june-26.pdf` (still live).

## Findings (blockers fixed before the cohort run)

### F1 — flat FCNR floor destroys JPY (data-loss bug, fleet-wide)
`commit_rates slab_filter … dropped_below_floor=30`. Prior committed artifact had
JPY:5 slabs at 0.00–0.01% (real Axis published rates); the fresh run committed 0 JPY
because `filterInvalidSlabs` applies `VARIANT_RATE_RANGES.fcnr.min = 0.5` to every
currency. This is the "collapsed FCNR currencies" error class from the trust position
paper, now reproduced live. **Fix:** currency-aware floor (`LOW_YIELD_CURRENCIES`:
JPY/CHF min 0) in `scripts/utils/validation-constants.js` + `validate-rates.js`.

### F2 — hinted dated-PDF URLs 404 with no fallback (yield bug, fleet-wide)
Axis rolled its dated PDFs (13-june-26 → 404 for domestic/NRI; FCNR edition still up).
The orchestrator's extraction-hint override has no fallback: hinted URL 404 → product
ends 0 slabs even though `rate_pages.fd` (HTML, undated) is live and links the current
PDF. Banks roll dated URLs constantly → refresh runs silently zero out. **Fix:**
on fetch-class failure (404/410/download error) fall back to the default un-hinted
rate-page flow for that product; 0-slab-but-fetched does NOT trigger fallback.

### F3 — OCR path hardcodes `effective_date: null`
`extract_via_ocr.js` discards the "w.e.f. …" title row Document Intelligence returns,
so every OCR variant ships undated — directly violating the A6 target "0 undated NRI
variants". **Fix:** parse w.e.f./effective-from phrases from title/paragraph text,
normalise via `lib/rates-qc.js#normalizeEffectiveDate`, sanity-band [2020-01-01,
today+7d], never fabricate.

All three fixes were implemented by parallel sub-agents on 2026-07-07 (commits follow
this note in history).

### F4 — fallback exposed the missing clean-but-fewer rule (found on re-smoke)
The verification re-smoke confirmed F1 (JPY:5 restored, 38 FCNR slabs), F2 (all three
404 hints fell back), and F3 (`effective_date: 2026-06-13` captured live). But F2's
domestic fallback landed on the HTML teaser table and its **2 clean-looking slabs
overwrote the prior 54-slab ladder** — the Track B "clean-but-fewer" rule, reproduced
live and promoted to a blocker. **Fix:** safe-write rejection rule 4
(`shrink_overwrite_blocked`): incoming below 50% of an existing ≥8-slab non-stale
ladder routes to `.pending.json` with provenance history, exactly like rules 1–3.
Two pre-existing tests that codified the old warn-don't-block policy were updated
(one of them had anticipated this exact rule as "Sprint 011 work"). The clobbered
Axis artifact was restored from the D4 checkpoint commit.

## Non-blocking observations
- No `[ocr] dropped … rfc_*` log appeared on the live 3-table PDF — either DI's real
  layout carries no RFC heading in the classification band, or the RFC rows were
  instead removed by the dedup filter (dropped_duplicate=8 is consistent with Axis
  RFC == FCNR rates). Worth a debug-level run later; committed slabs are plausible.
- `failure_class: unclassified (extraction=not_attempted)` on a run that committed 33
  slabs — classifier misreads the coverage-loop path; cosmetic, triage later.
- Registry Axis hints remain stale (13-june-26); F2 makes this survivable at runtime.
  A registry URL-refresh pass stays a follow-up (bulk-author/recheck writes them).
