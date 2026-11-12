# Sprint 003 — Retrospective

**Sprint window:** 2026-05-12 → 2026-05-18 (one extended week, pivoting through 4 sub-tracks)
**Branch:** `azure-openai-agent` @ `db1b8f2` (10 commits ahead of `main`, unpushed)
**Closed:** 2026-05-18
**Author:** operator + Claude

The forensic spine of this retro is the sequence of dated implementation docs in `sdlc/sprints/sprint-003/implementation/`: `option-a-c-handoff-2026-05-16.md` → `to-80-percent-strategy-2026-05-16.md` → `prompt-improvement-2026-05-18.md` → `hdfc-regression-2026-05-18.md` → `tenure-parse-and-dedup-fix-2026-05-18.md` → `slab-quality-anomalies-2026-05-18.md`. Each was written before or during the work it describes and stands as the line-level evidence. This retro is the operator-facing summary.

## Verdict in one line

**Item #1 (action decomposition) shipped end-to-end with anti-fabrication guarantees and per-bank cost telemetry. Items #2/#3/#5 did not start. Item #4 (framework eval) was deferred per Sprint 002 retro's "defer framework adoption" decision.** Sprint 003 is closed with the orchestrator path producing trustworthy slabs on a 5-bank smoke, and Sprint 004 takes the work to a 200-bank cloud run.

## What shipped (Item #1 — action decomposition, plus emergent quality + cost work)

The original scope was 5 numbered items. Mid-sprint, after the Phase 3 smoke surfaced 18 % orchestrator-path coverage vs the LLM-path baseline, the sprint pivoted into a "to-80-percent strategy" focused exclusively on lifting orchestrator coverage to a production-credible level. The pivot was the right call — every other Sprint-3 item depends on the orchestrator being trustworthy, and trying to validate a downstream scraper pipeline (#2) or build operator-resolution tooling (#3) against a fabricating extractor would have wasted both.

What did ship under Item #1:

### Phases 1–3 (option A+C, committed before sprint window peak)

- **Phase 1** — consolidated HTTP into `lib/actions/_http.js` with byte-cap + truncation flag (commit `71f7b3c`).
- **Phase 1.5** — `find_rate_page` trusts `cached_path` under WAF when HEAD fails (`0659cdb`).
- **Phase 2** — `lib/actions/_playwright_session.js` library module with per-bank session lifecycle (`4e55901`).
- **Phase 3** — orchestrator HTTP routed through Playwright session (`cb3ce7e`). Bypasses Indian-bank WAF protection for HDFC / AU SFB / BOI-IBU.

### Audit pivot + Step 1 (2026-05-17 → 2026-05-18)

- **`19bfc46`** — Audit pivot. LLM fallback gets bank context + full body. Byte cap 512 KB → 2 MB. 5-bank smoke jumps from 31 to 122 trustworthy slabs (17.8 % → 70.1 % of LLM-path baseline).
- **`ef24c79`** — Step 1A + 1G: BOI-IBU `fd_gift` URL seeded in `data/bank-domains.json`; `_playwright_session` default `waitFor` flipped to `domcontentloaded`. BOI-IBU goes 0 → 21 in 35 seconds.

### Phase 4: single-fetch + cost tracking (`ddce343`)

New `lib/actions/fetch_page.js` does ONE full-quality Playwright fetch per (bank, product); the body is threaded into `classify_rate_page` (sniff) and `extract_html_table` (parse) via `hints.cached_body`. Eliminates the 2–3 redundant fetches per page that were costing 90 s of wall time per bank and crashing HDFC's 1.2 MB rendered DOM through the subprocess dispatcher. Cost telemetry from each AOAI call now propagates into `summary.json`'s `total_cost_usd` / `input_tokens` / `output_tokens` — the orchestrator path was previously reporting $0 silently.

### Per-table LLM chunking + anti-fabrication (`debb627`)

The single biggest correctness shift in the sprint. Before this commit, the LLM extractor sent the full page body (120 KB cap) and on heavy multi-table pages the rate tables landed past the cut. The model dutifully filled gaps from priors — SBI FCNR shipped USD 1y = 5.00 % when the live page shows 4.40 %; BOI-IBU shipped fabricated tenure boundaries the operator wouldn't have caught without spot-reading the page.

The fix:
- `extractTableChunks` in `_cheerio_tables.js` splits the body into one chunk per scored rate-bearing table + nearest heading + W.E.F. context. Each chunk well under the input cap; truncation becomes structural and rare, never silent.
- LLM is called per chunk concurrently (up to 6). The prompt is rewritten with hard rules: every emitted slab's `source_row_text` must appear verbatim in the input, every rate digit string must appear in the chunk, and the model must declare blocking conditions in a new `errors[]` field.
- Post-validation drops any slab whose row text doesn't trace back. The runtime is deliberately strict — we lose a few real slabs to LLM paraphrasing but never accept invented numbers.
- When `errors[]` is non-empty, the LLM output is discarded in favour of the deterministic result.

Two follow-on tweaks made the rewrite production-worthy:
- **`ad4ce65`** — drops tenure-less FCNR/GIFT slabs (the savings-rate rows BOI-IBU's third table emitted alongside the FD slabs).
- **`8f5d7e9`** — sweeps stale `gpt-4o` references; defaults to `gpt-4.1` / `gpt-4.1-mini` everywhere. The Azure resource only has the 4.1 family deployed; the `gpt-4o` strings would have 404'd if reached.

### HDFC regression + generic uplift (`3ccfa4e`)

The anti-fabrication commit dropped HDFC from 71 (hallucinated) to 2 (trustworthy). Two slabs is correct-but-empty; the diagnosis was that cheerio Path A actually extracted 19 rows but `dedupSlabs` collapsed them to 2 because most rows had `tenure_min_days = null` (parseTenure couldn't handle HDFC's "7 - 14 days" / "1 Yr" / "above 5 years" phrasings). Five common bank tenure formats were missing from the parser.

Fix: extend `parseTenure` with 5 patterns; make `dedupSlabs` use `tenure_text` as a fallback discriminator when bounds are null. Both are generic — they help every bank that uses any of those phrasings, not HDFC alone. 5-bank smoke jumps 153 → 265 trustworthy slabs.

### A1 + A2 + A3 anomaly cleanup (`4d8c1ab`)

Reviewing the 265-slab dump row-by-row surfaced three more pattern classes:
- **A1**: BOI-IBU shipped 112 slabs where 64 was the truth — the per-chunk LLM emitted the same data with inconsistent `deposit_range` labels ("above 1.00 Mn" vs "above_1.00_Mn"), surviving dedup as distinct. Fix: `normaliseDepositRange` canonicalises before dedup.
- **A2**: SBI NRE/NRO embedded deposit-amount tier indicators ("Up to Rs.5.00 lacs") and penalty rules ("Premature withdrawal") in the FD output. Fix: extended `non_fd_filter` to all variants + sub-1 % rate threshold.
- **A3**: HDFC's `<` / `<=` / multi-unit tenures (e.g., `"2 Years 11 Months 1 day <= 3 Year"`) were unparseable. Fix: two-pass parser with parenthetical stripping, `sumUnitTokens` helper, strict-less vs inclusive semantics.

Result: HDFC went from 5/19 parsed bounds to **19/19** without bank-specific selectors.

### SDLC bookkeeping

- `e864254`, `211d63f`, `db1b8f2` — SDLC docs (scope, follow-ups, prior-session sprint files that were drafted but never tracked).

## What did not ship

| Item | State | Reason |
|---|---|---|
| **#2 — Validate `packages/scraper/` pipeline** | Not started | Sprint pivoted to orchestrator coverage; validating a scraper pipeline against fabricating extractor output would have wasted work. Sprint 004+ once Track A confirms larger-cohort coverage. |
| **#3 — Operator resolution CLI** | Not started | ADR-011/012 pending-sidecar artifacts (`bank-domains-pending.json`, `<slug>_rates.pending.json`) are still being produced; no operator session has built up enough pending entries to need the tool yet. Defer to Sprint 004+. |
| **#4 — Framework evaluation spike** | Deferred per Sprint 002 retro (`workflow_orientation_decision`) | Decision was already made before Sprint 003 started; we stay with bespoke Node scripts through Sprint 003. Re-eval triggered by either a Sprint 5 incident or a hire that wants to migrate. |
| **#5 — Vision API integration** | Not started; `extract_via_vision.js` exists from prior work but uncalibrated | Gated on existential-question outcome (Sprint 002 retro). No image-only rate-card banks in the Sprint-3 smoke set so the gap wasn't acute. |
| **A4 — Multi-tier section-header propagation (AU SFB-style)** | Captured as Sprint-004 candidate in `slab-quality-anomalies-2026-05-18.md` | Invasive: changes chunk schema, dedup key, slab tagging. Held for dedicated design pass in Sprint 4 Track A. |

## Numbers

| Metric | Sprint start (`cb3ce7e`) | Sprint end (`4d8c1ab` smoke) |
|---|---:|---:|
| Tests passing | 420 | 480 (+60 from this sprint's additions) |
| Tests failing | 0 | 0 |
| 5-bank smoke total slabs | 31 (mostly hallucinated where multi-table) | 175 (all traceable to source HTML) |
| HDFC parsed bounds | 0 (LLM-fabricated) | 19 / 19 |
| SBI FCNR slabs | 0 → 6 (cheerio) → 24 (LLM, wrong) | **36** (= 6 tenures × 6 currencies, matches the live page exactly) |
| BOI-IBU slabs | 0 | 64 (4 currencies × 8 tenures × 2 deposit tiers) |
| Average per-bank cost | $0.00 (silent — telemetry broken) | $0.01–$0.06 (now visible) |
| Commits on branch | (start) | 10 |

## Wins

1. **The anti-fabrication contract is real.** Every committed slab traces back to source HTML — no more silent LLM gap-filling. This is the load-bearing change of the sprint; everything else builds on it.
2. **Two unrelated quality bugs got the same fix shape.** Generic improvements (parseTenure expansion, dedup-text-fallback, deposit_range normalisation, non_fd filter extension) benefit any bank using the relevant phrasing — not HDFC-specific, not SBI-specific. The "200/1800-bank target set" thinking surfaced early and kept us off bank-specific shortcuts.
3. **Cost telemetry exists.** Each cloud run will now have a per-bank cost number in `summary.json`. We caught the silent-$0 bug specifically because the orchestrator path's outputs reported zero costs while we knew real AOAI calls were happening.
4. **SBI FCNR's 6×6 = 36 layout is recognised and extracted correctly.** Currency-as-columns tables are common in foreign-bank and IBU rate cards; the per-chunk LLM extraction handles them now, where the deterministic cheerio mapping never could.
5. **HDFC structurally fixed.** Before this sprint HDFC was a 1.2-MB-page failure that crashed Playwright subprocesses. After Phase 4 (`fetch_page`), HDFC fetches once via the per-bank session and never spawns a subprocess at all.

## Misses

1. **5-bank smoke was too narrow.** Three of the five anomaly classes (A1, A2, A3) were caught only after row-by-row inspection of the 265-slab dump. A 50-bank smoke spanning categories would have surfaced them earlier and reduced the number of incremental sub-commits. → Sprint 4 Track A explicitly addresses this.
2. **No retro mid-sprint when the pivot happened.** The "to-80-percent strategy" pivot on 2026-05-16 was the right call but it happened in a commit message, not in a doc that summarised the change of plan. A 1-paragraph "we're now doing X because Y" note at the time would have made the trail clearer for future-us.
3. **AU SFB's variant-agnostic page behaviour is non-deterministic across smokes.** Some runs emit 3 INR variants (60 slabs total), some emit only regular (24 slabs). The LLM's per-chunk choices vary. Not blocking but unsatisfying for a system trying to be deterministic.
4. **HDFC follow-up doc (`hdfc-regression-2026-05-18.md`) overshot.** It speculated about 4 root-cause candidates including post-validation gates and subprocess crashes — none of which were the actual cause. The actual cause was found by reading the warnings field of the rates JSON, which would have been a one-line task. Premature diagnosis cost ~30 minutes of writing before we looked at the data.
5. **The smoke output telemetry has a known latent bug.** `summary.json`'s `failure_signals.slab_count` reports 0 for runs that successfully wrote rate files. Each run report had to re-count slabs from the rate JSON files. Captured but not fixed.

## Learnings (codified)

L14. **Per-chunk extraction beats whole-page extraction** when truncation is a risk. The LLM will hallucinate to fill gaps if the input is incomplete; the only safe defence is to send it just one table at a time so "incomplete" becomes structural and visible.

L15. **Post-validation against source HTML is the load-bearing anti-fabrication mechanism.** Tripwires on LLM self-disclosure ("truncated", "assumed") were rejected — the LLM can hallucinate silently — but `source_row_text` traceability cannot be faked, so it's the right place to enforce the guarantee.

L16. **Generic parser improvements scale; bank-specific selectors don't.** Every line of bank-specific config is a maintenance tax that grows linearly with the 200/1800 bank counts. Each fix in this sprint was tested against the question "does this help one bank or every bank that uses this phrasing".

L17. **Dedup keys should never collapse rows that visibly differ.** When `parseTenure` produces `(null, null)` for unparseable input, the old dedup logic collapsed every unparseable row into one bucket. Text-fallback dedup is defence in depth — even if a new bank uses a phrasing we don't recognise, the rows survive.

L18. **The Playwright session is the right abstraction for WAF-protected fetches.** Plain Node HTTP gets 403'd on HDFC / AU SFB / BOI-IBU. Per-bank Playwright sessions threaded through `_http.js` (and now `fetch_page`) bypass the WAF cleanly without bank-specific tokens.

L19. **Cost telemetry must be load-bearing, not optional.** The silent-$0 bug went undetected for weeks because nothing depended on the cost number. Once `summary.json`'s `total_cost_usd` becomes the per-bank cost gate, regressions surface immediately.

## Sprint 4 candidates

Promoted from this sprint to Sprint 4:

**Solidify track:**
- A4 — Multi-tier section-header propagation (`slab-quality-anomalies-2026-05-18.md` §"A4")
- 50-bank category-spanning local smoke to surface remaining anomaly classes
- Any A5+ anomalies discovered during the 50-bank smoke

**Deployment track:**
- Per-bank incremental blob upload (currently batch-end only — mid-run crash loses processed banks from blob)
- Single-command operator CLI: `node scripts/azops/start-cohort.js --cohort top-200 --env prod`
- ACR deploy idempotency + rollback (currently manual `deploy-image.sh` walk)

**Scale track:**
- `data/cohorts/top-200-banks.json` (versioned cohort file — currently a strategic reference, not a file)
- Cloud run of the 200-bank cohort with measured cost / coverage / trust rate

Held for Sprint 5+:
- #2 packages/scraper pipeline validation (need 200-bank cohort outputs first)
- #3 operator resolution CLI (need pending-sidecar accumulation first)
- #5 Vision API calibration (need image-only banks in the cohort first)
- Framework migration (decision triggers not yet hit)
- Full 1,800-bank cloud run

## Open questions taken into Sprint 4

- Will the 50-bank smoke surface more than 3 anomaly classes? If so, where do we stop fixing in-sprint vs deferring?
- Does the per-bank blob upload increase total cloud cost / IO measurably? The 50-bank smoke is the first place to measure.
- Will A4's tier-header capture work via the existing `extractTableChunks` API, or does it need a deeper schema change?
- What's the right operator-experience boundary for `start-cohort.js` — does it block on completion or just kick off and return?

## Branch + commit summary

10 commits on `azure-openai-agent`, unpushed at sprint close:

```
db1b8f2  sdlc: commit prior-session sprint docs that were drafted but never tracked
4d8c1ab  extract: deposit_range normalisation + non-FD filter + <= comparators (A1+A2+A3)
211d63f  sdlc(sprint-003): slab-quality anomalies — next-iteration scope (A1-A4)
3ccfa4e  extract: expand parseTenure + dedup-fallback (HDFC regression + generic uplift)
8f5d7e9  chore: drop stale gpt-4o references; default to gpt-4.1 / gpt-4.1-mini
ad4ce65  extract: drop tenure-less FCNR/GIFT slabs (savings rows leaking into FD output)
e864254  sdlc(sprint-003): 2026-05-18 status — Phase 4 + prompt-improvement results + HDFC follow-up
debb627  extract: per-table LLM chunking + anti-fabrication contract (no more hallucinated rates)
ddce343  orchestrator: single-fetch via fetch_page + cost tracking in summary.json
ef24c79  agent: seed BOI-IBU GIFT URL + default playwright session to domcontentloaded (Step 1 A+G)
```

Plus the earlier Phase 1/2/3 commits from before the sprint-window peak (`cb3ce7e`, `4e55901`, `0659cdb`, `71f7b3c`, `3182212`, `19bfc46`). The full Sprint-3 commit range is `3182212..db1b8f2`.

**Push status:** all 10 commits local-only at retro time. Awaiting operator decision on push timing (after Sprint 004 plan approval seems natural, but no blocker).
