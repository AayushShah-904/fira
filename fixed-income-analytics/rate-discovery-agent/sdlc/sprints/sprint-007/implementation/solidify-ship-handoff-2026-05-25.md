# Solidify-and-Ship Handoff — 500+ cohort for the PM (next session)

**Goal (operator):** solidify what we have for the 500+ cohort — verify it's **right** (rates landed correctly), **tight** (no dupes/stale/garbage), and **ship it for the PM**. The operator is confident Tier-2 is a strong mechanism; the focus now is *verification + delivery*, not more discovery.

**State at handoff (2026-05-25, last commit `13c5144`, branch `azure-openai-agent`):**
- Coverage: **441/513 (86%) rate-data, 262/513 (51%) auto-refresh, 72 gap — all 72 classified** with `discovery_status` + website metadata (no unexplained gaps).
- The delivered pack `pack/dist/rates-pack.json` is **stale** — built 2026-05-23 (516 banks) BEFORE this session's ~52 new banks (19 breadth + 28 gap-sweep + 2 OCR + co-op-sweep templates). **First job tomorrow: rebuild + gate.**
- Re-measure anytime: `node scripts/analysis/coverage-map.js`.

---

## The ship pipeline (real commands)
```
npm run build-pack        # pack/build-pack.js: output/latest/ -> pack/dist/rates-pack.json (+schema, README)
npm run quality-gate      # scripts/quality-gate.js <new> <baseline> : classify vs delivered baseline, BLOCK on unaccepted regressions/anomalies
node pack/compare-pack.js # diff new vs baseline pack
python scripts/validate_output.py   # schema/sanity validation of output/latest
npm run publish-pack      # pack/publish.js: final delivery artifact
```
Quality-gate exit codes: 0 PASS, 1 BLOCK (unaccepted REGRESSION/ANOMALY), 2 ERROR. Accepts are **signed, operator-only** via `bin/approve-accept.js` + `~/.rate-discovery/operator.key` — the agent CANNOT add a valid accept ([[reference_signed_accept_cli]], [[feedback_no_fake_approvals]]; the 2026-05-23 fabricated-accepts incident). Never hand-edit `pack/quality-gate-accepts.json`.

---

## Recommended next-session order

### A. Rebuild + gate (do first — see the real delta)
1. `npm run build-pack` → new `pack/dist/rates-pack.json`. Note the bank/slab counts vs the 2026-05-23 baseline (`pack/history/`).
2. `npm run quality-gate` → read `pack/dist/quality-report.md`. Expect a large **GAIN** block (the ~150 new templates + ~47 new data banks). Triage any **REGRESSION/ANOMALY** — those are the real signal.
3. `node pack/compare-pack.js` for a bank-level diff.

### B. Verify Tier-2 slabs landed correctly (the operator's explicit concern)
The pack-builder already drops out-of-band slabs via `lib/rate-bounds.js` (`isSlabRateInBounds`/`isSlabTenureSane`) and logs per-bank `filterDropCounts` — **check that log**: any Tier-2 bank losing slabs to the filter is a transcription error to fix.
- Cross-check the **52 new banks** (list: this session's recoveries — see §11.2 + §12.2 of `tier1-tier2-progress-2026-05-25.md`, or `git show 13c5144 --stat`). Spot-verify ~8–10 against their `source_url`, weighting the **vision-OCR** ones (angul, karimnagar-dccb, yavatmal, kanyaka, patan, janata-satara, sagar-dccb, shri-mahalaxmi, bharath, grain-merchants, jsk-jabalpur, thane-dccb) — image transcription is the highest-risk path.
- `python scripts/validate_output.py` for schema/sanity across `output/latest/`.
- Sanity heuristics already encoded in `scripts/analysis/coverage-map.js`-style checks: rates 1–12%, monotonic-ish tenure, senior ≥ general. A quick reusable `output/latest` rate-sanity audit script under `scripts/analysis/` would be worth writing (flag senior<general, rate spikes, duplicate tenure rows, effective_date older than ~2 years).

### C. Tighten
- **Duplicate/identity check:** several banks share platforms (pbcoopbank.in: hoshiarpur/patiala/nawanshahr) or had name-collision risk (Nellore Urban vs DCCB, Salem Urban vs DCCB, J&K State Co-op vs J&K Bank — all flagged in tier2 warnings). Verify no two slugs point at the same source_url with different data.
- **Stale effective_date:** flag banks with `effective_date` older than ~18–24 months (e.g. bharath 2023-04, jabalpur-mahila 2017, some co-ops 2021–2023) — keep but mark `stale` in the pack so the PM can show a freshness badge.
- **`extraction_method` consistency:** the 28+19 Tier-2 banks carry CURATED methods (clobber-protected). Confirm the pack surfaces provenance (template vs tier-2 vs manual) so the PM can badge "auto-refreshed" vs "transcribed".

### D. Ship
- Once gate is PASS (with operator-signed accepts for legitimate GAINs/changes), `npm run publish-pack`.
- Update `pack/dist/REPORT.md` / `SUMMARY.md` with the new coverage story (86% rate-data, 51% auto, gap fully classified) for the PM.

---

## Gotchas carried forward
- **ONE registry-writing process at a time** (bulk-author --write / folds). Read-only pack/gate/validate steps are safe to parallelize.
- **No fabrication / no fake accepts** — [[feedback_no_fake_approvals]]. Quality-gate BLOCK must be resolved by fixing data or an operator-signed accept, never by editing the accepts file.
- **Tests:** `node --test --test-force-exit` baseline = 1117 pass / 1 known fail (`fetch_html` stealth). Use `node --test` directly (the `npm test` pretest write-discipline hook trips on untracked tmp files).
- LF→CRLF git warnings are benign (Windows).
- `tmp/` is gitignored: the fold scripts (`fold-tier2-2026-05-25.js`, `fold-gap-sweep-2026-05-25.js`, `patch-missing-3.js`, `ocr-followup.js`, `ocr/render.js`) and `tmp/cohorts/*` won't survive a clean — rebuild gap cohort with `node scripts/analysis/build-gap-cohort.js`.

## The 72 classified gaps (for the PM narrative — these are "explained", not failures)
- 23 **wholesale_no_retail** (foreign banks + GIFT IBUs — no retail FD product exists)
- 17 **no_rate_page** (site exists, publishes no FD rate page)
- 16 **no_website** (no own web presence; mostly HDFC/ICICI sub-member co-ops)
- 11 **unreachable** (own site down/DNS/cert from our network — RETRYABLE elsewhere)
- 3 **no_fd_product** (Payments Banks, NABARD)
- 2 **bot_blocked** (WAF wall — retryable with a bypass)
Only the 13 unreachable+bot_blocked are potentially recoverable later; the other 59 are structural.
