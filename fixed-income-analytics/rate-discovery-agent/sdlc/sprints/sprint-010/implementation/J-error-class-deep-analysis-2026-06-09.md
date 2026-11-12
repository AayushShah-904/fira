# Sprint 010 Phase J — Error-class deep analysis (post-cohort)

**Date:** 2026-06-09
**Cohort source:** `n55y5dr` 513-cohort (Phase G)
**Baseline:** `logs/sprint-009/baseline-pack-2026-05-28.json` (8,369 slabs / 517 banks)
**Pre-fix pack:** 6,965 slabs / 578 banks (−16.8 %, both gates BLOCK)
**Post-Phase-J pack:** **8,299 slabs** / 578 banks (−0.84 % global; per-bank gate still blocks on 13 banks)

## What Phase J shipped already (committed)

### Structural fix — `lib/safe-write.js` empty-overwrite block

Every per-bank rate file now passes through one universal rule:
> If incoming `rate_slabs` is empty AND existing `rate_slabs.length > 0` AND existing's `extraction_method !== 'stale_needs_refresh'` → route incoming to `<file>.pending.json`, leave existing alone, return `reason: 'empty_overwrite_blocked'`.

Bypassed by `source: 'operator'` or `force: true` (operator authority preserved).

This single rule covers four distinct destructive-overwrite classes the n55y5dr cohort produced:

| Class | Banks | Slabs | Recurrence after fix |
|---|---:|---:|---|
| **R1** registry_skip overwrites a bank with non-curated method but historically-transcribed slabs (curated-content, non-curated-tag) | 65 | 911 | Blocked |
| **R2** Cohort-failure path emits `llm_inline_extraction` with `rate_slabs:[]` over a previously-extracted file | 36 | 499 | Blocked |
| **R4** Genuine LLM/PDF re-extraction returns 0 rows while baseline had >0 | 3 | 61 | Blocked |
| **R6** registry_skip with `discovery_status=recovered` / `single_headline_rate` | 8 | 56 | Blocked |
| **Total** | **112** | **1,527** | **All future occurrences blocked** |

### Recovery — `scripts/restore/restore-overwritten-rates-2026-06-09.js`

Conservative mode (default) restored 102 files / 1,373 slabs for buckets above whose current state is empty. Re-runnable; idempotent. Aggressive mode (`--aggressive`) covers R3 partial-degradation but requires operator authorization for each invocation (auto-mode classifier rightly blocks the broad form).

### Tests

- `tests/lib/safe-write.test.js`: +8 cases (29/29 pass) covering the R1, R2, refresh-bypass, operator-bypass, force-bypass, empty-to-empty no-op, and partial-degradation passthrough behaviors.
- Full suite: **1,475 / 0 fail / 44 skipped** (no regressions).

---

## What deeper analysis surfaced (new structural classes)

Of the remaining ~468 slab gap (8,299 actual vs 8,369 baseline = −70 net; the regression rows still total ~468 in R3 partial-degradation), the analysis decomposes into **5 distinct, structurally fixable defect classes** plus 9 quality-anomaly classes.

### E1 — IBU GIFT multi-currency truncation

**Banks (6):** hdfc-bank-ibu, kotak-mahindra-bank-ibu, idfc-first-bank-ibu, indian-bank-ibu, punjab-national-bank-ibu, indusind-bank-ibu (partial)
**Slabs lost:** 208

Pattern: GIFT rate pages list 3-6 currencies (USD / EUR / GBP / CAD / AUD / JPY / SGD). The orchestrator extracts only the first one or two.

| Bank | Current | HEAD | Currencies current | Currencies HEAD |
|---|---:|---:|---|---|
| hdfc-bank-ibu | 3 | 34 | (missing currency field) | full set |
| kotak-mahindra-bank-ibu | 7 | 55 | USD only | USD/EUR/GBP (25+15+15) |
| idfc-first-bank-ibu | 6 | 22 | (missing currency field) | USD+others |
| indian-bank-ibu | 7 | 18 | USD only | USD+more |
| punjab-national-bank-ibu | 2 | 10 | USD+EUR | USD+EUR+others |

**Root cause hypothesis:** the GIFT extractor (template `_currency-fan-out`-class or LLM prompt) iterates over currency tables but stops after the first. Likely an off-by-one in the loop or a missing "extract for all currencies" instruction.

**Fix scope:** ~0.5–1 day. Modify the GIFT extractor / LLM prompt to enumerate every currency table on the page; add a test fixture from one of the affected pages.

### E2 — FCNR currency-set or per-currency slab truncation

**Banks (5):** barclays-bank-plc, hong-kong-and-shanghai-banking-corporation-limited-hsbc, idfc-first-bank-limited, indian-bank, union-bank-of-india
**Slabs lost:** 96

Two sub-patterns:
- **Currency-set truncation** (HSBC, Barclays, Indian Bank): only some currencies extracted. E.g. HSBC HEAD has USD/GBP/EUR/JPY/AUD/CAD/CHF/DKK/SEK; current has only USD+GBP.
- **Per-currency slab truncation** (Union Bank, IDFC First): all currencies extracted but each has fewer tenure rows. E.g. Union Bank HEAD: USD:19, GBP:10, JPY:10, EUR:10, CAD:10, AUD:10. Current: USD:10, GBP:5, JPY:5, EUR:5, CAD:5, AUD:5 — roughly half.

**Root cause hypothesis:** same family as E1 — multi-currency fan-out logic incomplete. The per-currency slab truncation suggests the extractor reads one section (e.g. "amount tier 1") but misses the next (e.g. "amount tier 2+").

**Fix scope:** ~0.5 day (folded into E1 fix).

### E3 — Tenure-zero corruption

**Banks (4–5):** cosmos-co-operative-bank-ltd, mahamantralaya-allied-offices-coop-bank-ltd, dbs-bank-india-limited, barclays-bank-plc (regular)
**Slabs lost:** ~50–80

Pattern: current slabs have `tenure_min_days: 0` and `tenure_max_days: 0` while HEAD has proper values (e.g. 7–3650d). The tenure parser is failing for some pages and silently emitting zeros.

| Bank | Current tenure range | HEAD tenure range |
|---|---|---|
| cosmos-co-operative-bank-ltd | 0–0 (16 slabs) | 0–3650 (20 slabs) |
| mahamantralaya-allied-offices-coop-bank-ltd | 0–0 (7 slabs) | 30–3650 (20 slabs) |
| dbs-bank-india-limited | 0–0 (2 slabs) | 7–3650 (24 slabs) |
| barclays-bank-plc/regular | 0–360 (5 slabs) | 7–2555 (26 slabs) |

**Root cause hypothesis:** the tenure-text patterns on these specific pages don't match the parser's regex set. Sprint 010 Phase C added one clamp for "Up to N" / "<= N" patterns; this is a different pattern class.

**Fix scope:** ~0.5 day — add new tenure-text patterns to `scripts/utils/normalize-rates.js`, add fixture tests.

### E4 — General partial table extraction

**Banks (~10):** bandhan-bank-limited (regular/nre/nro), slice-small-finance-bank-limited, the-bihar-state-co-operative-bank-ltd, bank-of-india, citibank-na, plus other R3 cases.
**Slabs lost:** ~200

Pattern: extractor returns some slabs but misses rows or columns. e.g. bandhan-bank-limited/regular HEAD has 66 slabs, current has 24 — same tenure range, fewer rows; suggests senior/super-senior columns missed.

**Root cause:** per-bank — could be template `column_map` stale (page added a column), table-index drift (table_index in template no longer matches page DOM), or LLM fallback returning incomplete extraction.

**Fix scope:** ~2–3 days, per-bank inspection. Not a single structural fix.

### E5 — `cloud/sync.js#pull` bypasses `safe-write`

**Severity:** invisible erosion, cumulative
**Location:** `cloud/sync.js` lines 192–195, 197–199 (annotated `safe-write-exempt: TODO migrate per ADR-012`)

Pattern: when a cloud run starts, `sync.js#pull` downloads each blob `output/latest/<bank>_*_rates.json` and writes it directly via `fs.writeFileSync` (no safe-write). If a prior cloud run wrote a worse version to blob, the pull silently overwrites the local good version — completely bypassing the curated check AND the new empty-overwrite block.

This is the "back door" by which the n55y5dr cohort destroyed slabs even where local HEAD had richer data. The cohort's process was:
1. Run start: `sync.pull` writes blob versions to local fs (raw, no safe-write).
2. Bank extracts: writes go through safe-write (protected).
3. Run end: `sync.push` uploads local fs to blob.

So even though step 2 was protected for the *current* run, step 1 could have already eroded the local state from prior runs' blob writes.

**Fix scope:** ~0.5 day. Route `sync.js#pull` writes through `safeWriteArtifact({source: 'cloud-pull', kind: 'rates'/'config'})`. Adds source `'cloud-pull'` to `VALID_SOURCES`. May need a `force: false` semantics consideration since pull *should* be authoritative-from-blob for fresh registry pulls — likely needs a flag like `pullMode: 'authoritative' | 'merge'`.

### E6 — Cohort-failure cluster (49 + 56 + 30 banks, varied causes)

Already documented in `I-post-cohort-analysis-2026-06-09.md`. Sub-classes:
- **E6a** kind=html_js extraction_failed (au-sfb, haryana-gramin, etc.) — Playwright-rendered pages where html_js extractor returns 0 slabs. Could be selectors stale or JS-wait too short.
- **E6b** kind=pdf extraction_failed (axis-bank-ibu, yes-bank-limited fcnr) — PDFs with invalid structure or "pages_data present but no page produced slabs". Need DocIntel fallback (already wired in Phase B).
- **E6c** net::ERR_HTTP2_PROTOCOL_ERROR (yes-bank-limited) — Akamai/anti-bot reset. Registry already marks these for manual data entry; should not be in cloud cohort.
- **E6d** rate_page_not_found / no_link_found (qatar-national-bank-qpsc) — orchestrator couldn't find rate page URL even though registry has entry. Discovery regression.

**Fix scope:** Sprint 011, per sub-class. The empty-overwrite block already protects against these *destroying* prior good data going forward; the question is purely about *recovering* slabs for these specific banks.

---

## Quality anomalies (rates present but quality concerns)

Not regressions — but signal places to harden in Sprint 011.

| # | Anomaly class | Count | Sample | Risk |
|---|---|---:|---|---|
| **E7** | stale_effective_date (>6mo) | 95 | agra-zilla-sahakari 2023-02-20 | Banks with rates that haven't refreshed in months; not necessarily wrong but flag for re-extraction |
| **E8** | senior_below_general (rate invariant violation) | 53 + 77 minor | ajara-urban-co-op 50bps below | Column-mapping risk — extractor may have swapped general/senior columns |
| **E9** | fcnr_currency_anomaly | 60 | city-union-bank "YEN" not normalized to JPY | Currency normalizer needs new patterns |
| **E10** | super_senior_below_senior | 16 + 5 minor | nadia-DCCB 50bps below | Rate invariant violation; suggest column mapping or extraction error |
| **E11** | rate_deviation_peer (outlier vs peer median) | 28 | bandhan-bank-limited 4.4 % vs PVB median 6.5 % | May be real outlier or extraction error |
| **E12** | rate_deviation_historical | 5 | janakalyan-sahakari +175bps from last | Likely extraction error |
| **E13** | missing_currency (GIFT) | 9 | hdfc-bank-ibu/gift slabs | Already covered by E1 |
| **E14** | truncated_ladder | 1 | citibank-na/nro 1 slab | Already partial-recovered |
| **E15** | rate_reasonableness_outlier | 1 | saraswat-coop 12.25 % 5y | Likely extraction error |

---

## Synthesis — recommended publish path

### Now publishable? Not yet.

The pack is at 8,299 slabs (−0.84 % global, within tolerance) but `pack/quality-gate.js` still blocks on 13 HIGH-confidence per-bank regressions, all in R3 (partial degradation, current has some slabs but fewer than baseline). 10 of those 13 are E1 (IBU GIFT) or E2 (FCNR currency truncation) banks.

### Recommended next phase — Phase K, ~1 day

| Step | Effort | Recovery |
|---|---:|---:|
| **1. E1 fix:** orchestrator GIFT extractor / LLM prompt enumerates every currency table | ~0.5 day | ~200 slabs once re-run |
| **2. E2 fix:** FCNR fan-out (same code path as E1; one fix covers both) | folded | ~100 slabs |
| **3. Re-run cohort subset:** ~15 banks (all R3 banks) on D4 — small targeted run, not full 513 | ~1 hour | – |
| **4. E5 fix:** route `cloud/sync.js#pull` through safe-write so future blob-side erosion can't recur | ~0.5 day | prevents future loss |
| **5. Re-build pack + re-run gates** | ~10 min | – |
| **6. If gates pass:** publish | – | – |
| **6b. If gates still block on small residual:** `--accept-regression` with explicit per-bank notes from this doc | ~10 min | – |

### Sprint 011 backlog (no longer publish-blocking)

| # | Item | Effort |
|---|---|---:|
| 1 | E3 tenure-zero pattern set | 0.5 day |
| 2 | E4 per-bank partial-extraction inspection | 2–3 days |
| 3 | E6a–E6d cohort-failure sub-classes | 2–3 days |
| 4 | E7 stale-effective-date refresh cohort (95 banks) | 0.5–1 day |
| 5 | E8/E10 column-mapping audit | 1 day |
| 6 | E9 currency normalizer hardening | 0.5 day |
| 7 | E11/E12/E15 rate-deviation investigations | 1 day |
| 8 | Sprint-010-original Phase 7 watchdog (carried) | 2 days |

### Why this ordering

Operator stated: *"runs are costly and time consuming"* — implies don't fire another full 513-cohort to test fixes. Instead:
- Phase K fixes E1+E2 structurally + tests on a 15-bank targeted cohort.
- Phase K fixes E5 (sync bypass) which is invisible-but-cumulative.
- Both are <1-day work each, parallelizable, then a single small re-run + publish.
- Everything else lives in Sprint 011 — operator can sequence by impact.

---

## Files this phase produced

- `lib/safe-write.js` — empty-overwrite block (committed below)
- `tests/lib/safe-write.test.js` — +8 cases (committed below)
- `scripts/restore/restore-overwritten-rates-2026-06-09.js` — recovery (committed below)
- `logs/sprint-010/phase-j-recovery-detail.json` — per-file recovery log
- `sdlc/sprints/sprint-010/implementation/J-error-class-deep-analysis-2026-06-09.md` — this doc

## Files modified by recovery (not yet committed)

102 `output/latest/<bank>_*_rates.json` files reset to HEAD content. Diffable via `git status`.
