# FCNR fresh-yield root cause — 2026-07-07 cohort run

Question: why did only 12/57 cohort banks produce fresh FCNR (9 committed + 3 blocked)?
Method: per-variant tool-call traces from `<bank>.summary.json` (the warn-level batch
logs don't carry error detail), three targeted `--variant fcnr --log-level debug`
reproductions (PNB, UCO, Federal, BoI), and an HTTP probe of all 27 failing FCNR URLs.

## Outcome buckets (48 non-fresh banks)

| Bucket | n | Meaning |
|---|---|---|
| `extract_html_table:fd_fcnr` errored | **27** | The dominant class — decomposed below |
| Fresh FCNR extracted but safe-write blocked | 5 | bom, indian-bank, kotak, icici (sidecars await operator review); hsbc (validation critical) |
| Whole run failed (`agent_error`) | 11 | canara, csb, keb-hana, nonghyup, shinhan, yes, uob, tamilnad, esaf, rabobank, bombay-mercantile — WAF/js/site class, all variants dead, not FCNR-specific |
| FCNR page never found | 3 | barclays, natwest, saraswat — reverse-gap members; need `--expand-nri` discovery, `--rates-only` can never fix them |
| FCNR product never attempted | 1 | cosmos (SUCB; in cohort via pack slabs only, no registry FCNR source) |
| OCR yielded 0 | 1 | bank-of-bahrain-and-kuwait (incl. coverage-loop retry) |

## The 27-bank extract-error class, decomposed by URL probe

### A. FCNR matrix IS on the page; extractor picks the wrong table (~13 banks) ← highest leverage
Debug signature (PNB, UCO confirmed live): LLM returns the INR FD table
(23 and 7 slabs, no currency markers) and the `missing_currency_multi` guard
**correctly refuses** to default-fill USD. The guard is doing its job; the
chunk/table selection is the bug.

Banks (static HTML, `<table>` markup + currency tokens present via plain HTTP):
bandhan, bank-of-ceylon, city-union, dhanlaxmi, doha, emirates-nbd, idbi,
karnataka, karur-vysya, punjab-national, punjab-sind, rbl, uco.

These are consolidated multi-product pages (PNB's is 439 KB with 24 tables; every
variant registered to the same URL). `extractViaLlmFromHtml` feeds generic
"rate-bearing" chunks; nothing steers chunk choice toward the currency-keyed matrix
for variant=fcnr, so the model latches onto the dominant INR table.

**Fix:** currency-aware chunk selection for fcnr/gift in
`lib/actions/extract_html_table.js` — rank/filter chunks by currency-token count
(≥2 distinct of USD/GBP/EUR/JPY/CAD/AUD/CHF/SGD/HKD) before the LLM call; if no
currency-bearing chunk exists, fail fast with `no_currency_chunk` instead of
burning an LLM call on the INR table. One fix ≈ 13 banks, mostly T1/T2 PSBs+PVBs.
Bonus: PNB's page carries FCNR **w.e.f. 01.07.2026** — fresh July rates are already
published and waiting; this fix converts directly into fresh dated slabs.

### B. Currency content present but no `<table>` markup (~3 banks)
dcb, indusind (811 KB!), jammu-kashmir. The grids are div-rendered; the chunker
finds "no rate-bearing table chunks". Needs div-grid support or rendered-DOM table
serialization in the html_js path.

### C. FCNR URL dead, JS-shell, or blocked (~11 banks)
- HTTP 500: federal (`/fcnr-b-deposits` — Playwright also gets an error shell)
- Empty/TLS-refused to plain HTTP: bank-of-india, dbs, ujjivan (curl exit 35)
- JS shells < 20 KB with no FCNR content: equitas, indian-overseas (338 B!),
  kookmin, nainital, south-indian, au-sfb (known Cloudflare-403 carryover)
- pt-maybank: `scraper_type=pdf`; the HTML page carries no table — FCNR PDF link
  needs to be resolved and hinted (`extraction.fd_pdf_fcnr` + fulfills_product).

**Fix:** per-bank registry work — URL re-discovery (`--expand-nri`), WAF/js
handling, or PDF hints. No single code fix; overlaps heavily with the 11
`agent_error` banks.

## Ranked plan (by fresh-FCNR banks per unit effort)

1. **Extractor fix A** (one change + tests): ~13 banks. Candidate for immediate
   implementation; guards F1–F4 already protect the write path.
2. **Operator sidecar review** (no code): +3–4 banks (bom 21, indian 30, kotak 34,
   icici 5-vs-13 needs judgement).
3. **Registry/URL repair batch for class C + agent_error class** (per-bank, mixed
   effort): up to ~20 banks, includes WAF work already on the backlog (canara, csb,
   AU FCNR).
4. **Div-grid extraction B**: 3 banks — fold into the html_js improvement track.
5. **Discovery for the 3 reverse-gap banks + cosmos**: `--expand-nri` runs.

Ceiling check: 9 fresh + 13 (A) + 4 (review) + ~3 (B) ≈ 29 banks before touching
class C; the ≥60 FCNR-bank target additionally needs the 13-bank cohort gap and the
23 FBs with no FCNR URL at all (discovery work, per the A5 target list).

---

## Post-fix outcomes (same day, after Fix A + follow-ons)

Fix A landed in three commits — `eef6fdd` (currency-aware chunk selection),
`4c8243e` (same filter in the `_llm-fallback` dispatcher path), `43743f3`
(union-of-single-currency-chunks for per-currency-table layouts) — plus
`c6c1842` (jkb registry repair) and `58fc66a` (per-bank
`extraction.<product>.expected_currencies` registry override; emirates-nbd
declared USD-only).

Live re-validation of the 13-bank class A (plus icici/hsbc):

| Outcome | Banks |
|---|---|
| Committed fresh to canonical | jkb 69 slabs (dated, JPY present) |
| Extracted correctly → pending (canonical is curated, rule 1) | pnb 30 (exactly matches curated count — strong cross-check), uco 30, city-union 34, dhanlaxmi 16, doha 9, karnataka 36, karur-vysya 36, punjab-sind 34, rbl 30, emirates-nbd 11 (USD-only via override) |
| Still failing | bandhan + bank-of-ceylon + idbi (`missing_currency_multi` — kept chunk has tokens but LLM output currency-less; needs per-bank look), icici (thin 5-slab page, shrink-blocked — known ICICI gap), hsbc (validate-rates critical), dcb (clean `no_currency_chunk` fast-fail — grid loads on tab interaction, class C confirmed) |

Net: extraction capability restored for **11 of 13** class-A banks. The
freshness bottleneck moved from the extractor to **operator promotion review**:
27 pending sidecars carry today's extractions (list via
`scripts/analysis/triage-cohort-run.js`), most against curated June files that
rule 1 rightly protects. Class B closed as empty (jkb/dcb/indusind all resolved
to wrong-URL / JS-loaded — no div-grid extractor needed; YAGNI).
