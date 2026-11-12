# A6: FCNR cohort refresh run — triage (2026-07-07)

Run: `node run-batch.js --cohort fcnr-cohort-2026-07-07 --rates-only --concurrency 3`
→ `output/runs/2026-07-07T0626_all-rates-only` — 57 banks, 46 succeeded / 11 failed,
~30 min wall, ~$1.2 LLM cost. Artifact checkpoint committed as 7580c2d.
Triage tool: `scripts/analysis/triage-cohort-run.js` (artifact-level complement to
`nri-target-list.js`, which measures the *pack* and only moves after a pack rebuild).

## Targets vs. measured (artifact level, output/latest)

| A6 target | Measured after run | Verdict |
|---|---|---|
| FCNR banks ≥ 60 | 45 with slabs (was 41); cohort attempted 57 | **Miss** — fresh-FCNR yield is the binding constraint, see below |
| 0 undated NRI variants | FCNR files dated 38/45 (84%); fresh-today FCNR dated 8/9 | **Partial** — F3 works on fresh writes; backlog stays undated until re-scraped |
| Lock-in flags present | 1 bank (Axis, via OCR path) | **Miss for HTML path** — footnote capture exists only in extract_via_ocr; the 8 HTML-extracted FCNR banks today have none |
| PSB triad 12/12/12 | not yet re-measured at pack level (needs pack rebuild) | Deferred to A7 |
| 0 destructive overwrites | **17 blocked writes routed to .pending.json, 0 clobbers** | **Met** — rule 4 (F4) blocked 8 shrinks incl. the Axis 54→2 teaser on its first fleet run |

Freshness (scraped_at = 2026-07-07): regular 36, nre 25, nro 25, fcnr 9 committed
(+3 more extracted but blocked pending review: icici 5, bank-of-maharashtra 21,
indian-bank 30), gift 0. JPY now present at 22 banks (F1).

## Why FCNR fresh-yield stopped at ~12/57 (next lever, ranked)

1. **11 hard failures**: bombay-mercantile, canara, rabobank, csb, esaf, keb-hana,
   nonghyup, shinhan, tamilnad-mercantile (318s timeout-ish), uob, yes-bank. Mix of
   html_js/WAF (canara, csb, keb-hana, nonghyup) and site issues.
2. **Succeeded-but-domestic-only banks** (~30): the bank ran green but no fcnr commit —
   fcnr URL present in registry but the page yielded nothing, or FCNR lives on a
   combined NRI page the extractor classified as nre/nro only. Needs per-bank
   root-causing with the run logs (`output/runs/2026-07-07T0626_all-rates-only/<bank>.log`).
3. **Curated blocks on fresh FCNR** (bom 21-vs-25, indian-bank 30-vs-40, kotak 34-vs-30):
   operator review of the sidecars can promote fresh data where it is genuinely better.

## Blocked-writes review queue (today's sidecars only)

`shrink_overwrite_blocked` (8) — default assumption is correct block (partial/teaser
extraction), but each deserves a look because a prior artifact inflated by dup rows
would also trip it:
axis regular 54→2 (known teaser, correct), indusind regular 63→24,
au-sfb regular 39→12 / nre 29→8 / nro 39→12, uco nre 16→7,
karnataka-bank nro 25→10, bank-of-ceylon nre 11→5, icici fcnr 13→5.

`curated:*` with **fresh count ≥ curated count** — candidates for promotion:
kotak fcnr 34 attempted vs 30 curated, kotak regular 37 vs 18, kotak nre 14 vs 7,
pt-maybank regular 24 vs 12. (Promotion path = operator review + manual apply;
agents cannot approve.)

`garbage_overwrite_blocked`: cosmos regular (16 attempted vs 21 retained).

~100 additional June-era sidecars predate this run (operator backlog, unchanged).

## Non-blocking observations
- run-batch's exit code 1 reflects the failed tail — expected, not a crash.
- A handful of pending sidecars show `reason=?` (retained file lacks
  `_safe_write_history`) — written by a pre-history mechanism; cosmetic in triage.
- Registry hint-refresh (dead dated URLs) remains open; every refresh pays one 404 +
  fallback until hints are re-resolved.

## Follow-ups carried
1. FCNR-yield root-cause pass over the ~30 domestic-only green banks (run logs exist).
2. Footnote/lock-in capture for the HTML extraction path (parity with OCR).
3. Operator review of today's 12 shrink/curated sidecars (esp. kotak promotions).
4. Pack rebuild + `nri-target-list.js` re-measure → feeds A7/D1.
5. WAF/js failures: canara, csb, keb-hana, nonghyup (+ AU FCNR Cloudflare carryover).
