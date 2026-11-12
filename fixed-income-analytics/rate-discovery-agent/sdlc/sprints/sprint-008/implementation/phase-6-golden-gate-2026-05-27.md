# Implementation — Phase 6: activate the dormant golden regression gate (2026-05-27)

Design: `../design/cross-check.md` (Phase 6 section in plan). Status: **complete — gate is live and green.**

## What shipped

- **`scripts/snapshot/backfill-golden-from-snapshots.js`** (new) — for each `tests/golden-html/<bank>.expected.json` with a registry template AND an HTML snapshot, runs the **current production extractor** (resolved via `template.extract.extractor` + the registry `extract` column_map) over the snapshot HTML and compares to the committed `expected.json` (±2 slabs, ±5bps). Writes the `<bank>.html` companion ONLY when it matches (clean activation) and only when absent (never clobbers a curated fixture). `--rebaseline` (operator-gated) refreshes a clean-but-drifted bank's `expected.json` + html as a matched pair; structurally-flagged banks (Phase-3 ANOMALY) are never auto-rebaselined.
- **`tests/extractors/golden.test.js`** — the live assertion now resolves the real extractor module + column_map from `data/bank-domains.json` (was hardcoded `templateId: null`), so it runs the PRODUCTION extraction against the captured HTML — a true regression gate. Falls back to generic inference when no registry template.
- **`package.json`** — `test:golden` convenience script; the golden suite is already part of `npm test` (node --test discovery), so the gate is enforced on every test run.
- **`.gitignore`** — local golden pin state + audit logs.

## Result

`backfill-golden --write`: of 50 fixtures → **7 activated** (5 newly written: hsbc, idbi-bank-ibu, punjab-sind-bank, rajapur-urban-cooperative, uco-bank; 2 pre-existing curated companions BoB + HDFC now run via registry-driven resolution), **23 drift** (current snapshot/extraction differs from the Sprint-005 baseline — many are `post_hoc` backfill snapshots or banks under review like city-union; left **skipped**, not force-rebaselined), **7 PDF** (arm not wired), **9 no-template**, **4 no-snapshot**.

`npm test` (with pretest write-discipline): **1173 pass / 1 known-fail / 44 skip** — down from 49 skipped (the 5 newly-activated goldens). The 1 fail is the pre-existing Playwright `challenge on default` test. `node --test tests/extractors/golden.test.js` → 12 pass / 0 fail / 43 skip.

## Honest scoping

- **No fixture clobber.** A first `--write` accidentally overwrote the committed BoB + HDFC `.html`; restored via `git checkout` and the script now only writes *missing* companions. (`feedback_preserve_scraped_artifacts`.)
- **No blind rebaseline.** Drifted banks are NOT auto-frozen — rebaselining is operator-gated and skips structurally-flagged banks, so the gate never enshrines a suspected bug. The 23 drifted are a follow-up: verify (Phase 2/4) then `--rebaseline` the clean ones.
- **PDF arm deferred.** 7 PDF-sourced goldens (citibank, mizuho, coastal-LAB, BBK, banswara …) need a `.pdf` arm through `extract_rates_pdf.mjs` — a follow-on.

## Follow-on

- PDF golden arm.
- After the Phase-2 audit + Phase-4 cross-check clear the drifted banks, `--rebaseline` the verified-clean subset to widen the gate beyond 7.
