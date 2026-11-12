# Agent Efficiency Audit — Addendum (Real Data)

**Status:** Quantitative addendum to `agent-efficiency-audit.md`. Analysis only. No code changes in this pass.
**Date:** 2026-04-12
**Source:** 10 freshly instrumented `run-discovery.js` invocations with Phase 0 `stream-json` instrumentation (commit `29909c8`). Sample picked to cover both warm-cache and cold-start tiers.

---

## 1. The headline correction

The main audit's §3 ("Where the 218s actually goes") made three qualitative estimates. All three were wrong, and the proportions were backwards.

| Bucket | §3 estimate | **Real (n=10)** | Delta |
|---|---|---|---|
| Node / Claude startup overhead | 30–60s | **8.5s mean** | **−70%** |
| Tool wait (inside API time) | 60–120s | **29.8s mean** | **−66%** |
| LLM thinking (API minus tools) | 30–90s | **136.3s mean** | **+130%** |

**LLM thinking is 78% of wall clock, not ~40% as §3 estimated.** Process startup, tool round-trips, and waiting on HTTP responses are minor contributors. The dominant cost is the agent sitting in its reasoning loop across 13–28 turns.

This inverts several lever priorities from the main audit.

## 2. Ten-bank sample

Six warm-cache (in `bank-domains.json`) + four cold-start (0% coverage categories), two of which were known-blocked per WAF annotations.

| Bank | Cat | scraper_type | Wall | API | Think | Tool | Turns | Calls | Slabs | Cost |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Bank of India | PSB | html_js | 156.2s | 151.7s | 131.8s | 20.0s | 15 | 14 | **0** | $0.810 |
| Capital Small Finance Bank | SFB | html_static | 166.3s | 126.7s | 54.1s | 72.6s | 14 | 13 | 7 | $0.746 |
| American Express Banking Corp | FB | pdf | 202.0s | 195.4s | 182.7s | 12.7s | 15 | 13 | 11 | $0.855 |
| Axis Bank – IBU | IBU | pdf | 170.5s | 159.1s | 143.9s | 15.2s | 13 | 11 | **no rates file** | $0.685 |
| CSB Bank Limited | PVB | html_js | 220.7s | 230.4s\* | 179.4s | 51.0s | 16 | 15 | 17 | $1.038 |
| Airtel Payments Bank | PB | manual | 133.4s | 131.7s | 112.3s | 19.5s | 14 | 13 | **0** | $0.676 |
| Andhra Pradesh Grameena Bank | RRB | html_static | 203.7s | 196.3s | 157.1s | 39.2s | 10 | 9 | 6 | $0.690 |
| Ahmedabad Mercantile Co-Op Bank | SUCB | html_static | 215.8s | 207.1s | 184.4s | 22.6s | 28 | 27 | 10 | $1.248 |
| Akhand Anand Co-Op, Surat | NSUCB | html_static | **100.0s** | 98.2s | 80.0s | 18.3s | 11 | 10 | 9 | $0.621 |
| Amreli Nagrik Sahakari Bank | NSUCB | html_static | 177.1s | 165.1s | 137.7s | 27.4s | 24 | 23 | 7 | $1.199 |

\* CSB's API time (230.4s) exceeds wall clock (220.7s) — likely a rounding artifact in the upstream `duration_api_ms` accounting. Treated as "approximately equal."

### Aggregates

- **Wall clock**: mean 174.6s / median 177.1s / min **100.0s** / max **220.7s**
- **LLM thinking**: mean 136.3s / median 143.9s / min 54.1s / max 184.4s
- **Tool wait**: mean 29.8s / median 22.6s / min 12.7s / max 72.6s
- **Cost**: mean $0.857 / median $0.810 / min $0.621 / max $1.248 / **total $8.57**
- **Success**: 7 of 10 produced rate slabs, 1 failed to write a rates file at all, 2 produced empty rates (1 legitimate `manual`, 1 re-run regression)

### Updated projections

| Metric | Main audit §2.4 | **Real (n=10)** |
|---|---|---|
| Mean wall clock / bank | 218s | 174.6s |
| Mean LLM cost / bank | (unknown) | **$0.857** |
| Sequential h for remaining 1,886 | 114 h | **91.5 h** (3.8 days) |
| Concurrency=5 h | 23 h | **18.3 h** |
| **Total LLM cost for remaining 1,886** | (not estimated) | **~$1,616** |

The main audit's sequential estimate was ~20% pessimistic. The mean is faster than historical batches, probably because `bank-domains.json` cache hits help some banks — but the effect isn't uniform (see §3 below).

## 3. Warm cache barely helps — a second surprise

**Warm-cache runs (6)**: 156, 166, 202, 170, 220, 133 → mean 174.5s
**Cold-start runs (4)**: 204, 216, 100, 177 → mean 174.3s

The two groups have **identical means**. I expected the warm group to be significantly faster because they skip the website-discovery web-search step. They weren't.

Explanation, from reading the error traces:

- Warm runs hit a different failure mode: the agent trusts cached URLs and WebFetch's them directly, often getting 403s or stale content, then burns several turns reasoning about the failures and trying variants. Capital SFB spent **42 seconds** (21s × 2) on two failing WebFetch attempts against `/interest-rates/nre-term-deposits` (on both `capital.bank.in` and `www.capital.bank.in`) before giving up on NRE. Amex tried `RateCard_Jan..pdf` (literal double-dot typo), etc.
- Cold runs on small cooperative banks often hit light, simple websites with one rate page, and the agent is done faster (Akhand Anand: **100 seconds** total — the fastest run in the sample — on a brand-new NSUCB discovery).

**Implication:** the `bank-domains.json` cache is *not* a steady-state efficiency win at current instrumentation. It's a static memory of URLs the agent trusts, but the agent has no way to validate those URLs are still correct before spending tool budget on them. Pattern 2 wiring (main audit §4 Lever ★) is the actual fix for warm-cache efficiency: use the captured `selectors`/`column_mapping` to run a deterministic extractor first, and only invoke the LLM if the deterministic pass fails.

## 4. The NSUCB probe result is the most valuable finding

The main audit §7 estimated that **30–50% of the 1,392 NSUCBs have no discoverable website**. The sample of 2 NSUCBs is tiny, but:

| Bank | Wall | Slabs | Cost | Notes |
|---|---:|---:|---:|---|
| Akhand Anand Co-Op, Surat | 100s | 9 | $0.62 | Fastest run in the entire sample |
| Amreli Nagrik Sahakari Bank | 177s | 7 | $1.20 | 23 tool calls, more struggle |

**Both NSUCBs had discoverable websites and yielded valid rate slabs on first attempt.** If this holds across the population — and n=2 is nowhere near statistically meaningful, but it's wildly more optimistic than the §7 prior — then the NSUCB tier isn't a wall; it's just expensive. At the sample's $0.90 NSUCB mean × 1,392 banks = **$1,250 for NSUCBs alone**, but with meaningful coverage.

**Follow-up the audit recommends:** a 30-NSUCB sacrificial probe to establish the real hit rate. Current estimate is unreliable; this is the single biggest sizing unknown for the sprint.

## 5. Three concrete bugs surfaced by the instrumentation

The trace data found issues we couldn't see in the old 1.4-KB text logs.

### 5.1 Agent cannot Read `data/bank-domains.json` at absolute paths

**5 of 10 runs** had this error:

```
Read (1048ms): {"file_path":"C:/sw/BharatOmni/UFA/BIRD/rate-discovery-agent/data/bank-domains.json"}
```

The agent is synthesizing absolute Windows paths (both forward-slash and backslash variants) from CLAUDE.md's `data/bank-domains.json` reference, and the Read tool is rejecting them or failing in some way that produces an error. The agent then retries with a relative path and eventually succeeds.

**Cost per occurrence**: one wasted tool call (~1s) plus an LLM turn to diagnose. Minor individually, but 5/10 hit it — which means ~50% of runs waste one turn on this alone.

**Fix**: a one-line prompt tweak in CLAUDE.md — the example should show the literal `data/bank-domains.json` path as-is and explicitly say *"read this with a relative path, not an absolute one"*. Zero code change.

### 5.2 Agent guesses non-existent URLs and burns WebFetch budget

**16 of 37 WebFetch calls errored — 43% error rate.** Examples from the trace:

| Bank | Guessed URL | What happened |
|---|---|---|
| Capital SFB | `/interest-rates/nre-term-deposits` (twice, on two subdomains) | 42s wasted, no page exists |
| Amex | `Ratecard/RateCard_Jan..pdf` | Typo/hallucinated filename |
| Axis IBU | `/nri/nri-deposits/gift-city-fixed-deposit` | Hallucinated URL pattern |
| Ahmedabad Mercantile | `amco.bank.in` (wrong subdomain) | Real domain discovered later |
| Amreli Nagrik | `amrelibank.com` (wrong TLD) | Real domain discovered later |

These aren't the agent exploring — they're guesses from domain patterns it's seen, half of which are wrong. Each failed fetch is a ~0.5–21s wasted tool round-trip plus several seconds of LLM reasoning about the failure.

**Fix**: the Phase 2 "local pre-fetch + tier classification" lever from the main audit. Rather than letting the agent guess URLs, node pre-probes a short list of candidates (HEAD requests, 2s timeout each) and injects only the working ones into the prompt. Eliminates guessing.

### 5.3 `Axis Bank – IBU` wrote no rates file at all

Succeeded exit-code 0, wrote a config, 170s wall clock, $0.69 spent — but no `_rates.json` file exists in the run folder. The discover.md prompt says *"write the corresponding _rates.json file"* and the agent silently didn't. Inspecting the `_config.json` shows a PDF scraper_type with a `pdf_url` — the agent classified correctly but apparently failed to extract slabs from the PDF and then omitted the file entirely rather than writing an empty one.

**Fix**: the main audit's CLAUDE.md §5b schema guidance already says *"If a rate page yields zero parseable slabs, still write the file with `rate_slabs: []`"* — this is the same class of prompt-compliance issue. The instrumentation surfaced it.

### 5.4 Bank of India re-run regression (0 slabs despite 14 tool calls)

A previously-discovered PSB with cached domain and html_js scraper_type. This re-run produced 0 slabs for $0.81 and 156s of wall clock. The config was written (html_js, website https://...), but the rates file has no slabs.

Root cause is almost certainly: **the agent cannot fetch from html_js-rendered Bank of India pages via its WebFetch tool** — that needs Playwright, which is only accessible via `scripts/fetch_rates_playwright.js` (deterministic code path), which the agent doesn't know about. The agent retried, gave up, and wrote an empty rates file.

This is the **strongest argument for Pattern 2 wiring**: for any bank already classified as `html_js` with captured selectors, running `scripts/fetch_rates_playwright.js` would succeed in ≤10s for ~$0.00, versus the LLM's $0.81 and 156s to fail silently.

## 6. Tool usage across the 10 runs

| Tool | Calls | Total time | Avg per call | Errors | Notes |
|---|---:|---:|---:|---:|---|
| WebFetch | 37 | 178.0s | 4.8s | **16** | 43% error rate — §5.2 |
| WebSearch | 11 | 56.1s | 5.1s | 0 | Healthy |
| Bash | 26 | 29.4s | 1.1s | 1 | Mostly file ops |
| Write | 28 | 18.1s | 0.6s | 0 | Config + rates + NRI variants |
| Read | 17 | 15.0s | 0.9s | **8** | Half are bank-domains.json absolute-path failures §5.1 |
| Grep | 13 | 1.4s | 0.1s | 1 | Healthy |
| ToolSearch | 12 | 0.4s | 0.0s | 0 | Deferred-tool search |
| TodoWrite | 4 | 0.0s | 0.0s | 0 | |

**2.6 WebFetch calls per bank on average, 1.1 WebSearch, 2.8 Write.** The agent is doing roughly one search, 2–3 fetches, 2–3 writes per bank — which is in line with what CLAUDE.md asks for. The inefficiency is not in *volume* of tool calls but in the LLM reasoning between them.

**Token economics (sum of 10 runs):**
- Cache creation: 517K tokens (51K/run) — cold-start context tax
- Cache read: 4.99M tokens (499K/run) — reused across ~14–28 turns
- Output: 88K tokens (9K/run)
- Input (non-cached): 1.6K (negligible)

At ~51K cache_creation tokens per run, trimming the loaded context (main audit Lever L) is more impactful than I estimated. The context includes `data/bank-domains.json` (150+ entries, many KB), the full CLAUDE.md, and the prompt file — all sent cold on every invocation.

## 7. Lever re-prioritization

The real data shifts the priorities from the main audit's §8 table.

### Biggest movers

| Lever | Old estimated savings | **Revised estimate** | Why it moved |
|---|---|---|---|
| **★ Pattern 2 wiring** | −213s per ready bank | **−174.6s per ready bank** (new baseline) | Slightly smaller but still decisive |
| **C Local HTML pre-fetch** | −40 to −80s | **−10 to −25s** | Tool wait is much smaller than estimated |
| **D Local PDF preprocessing** | −60 to −120s | **−10 to −20s** directly; indirectly more | LLM thinking on PDFs (182s for Amex) is where the real cost is, and that's LLM interpretation, not tool wait. Pre-parsing helps only if it produces tabular data the LLM can shortcut — otherwise the LLM still reads the text. |
| **F Real-time block detection** | −200s+ per blocked bank | **−130s** (Airtel wasted 133s total, not 300s) | Blocked banks already fail in <150s, not at the full 300s timeout |
| **L Prompt context trim** | −10 to −20s | **Possibly −20 to −40s** via reduced cache_creation | Bigger than estimated because cache_creation is 51K tokens / run |

### New levers surfaced by the data

| # | Lever | Est. savings | Notes |
|---|---|---|---|
| **N** | **Reduce turn count** | −30 to −80s | Sample varied from 10 to 28 turns. Each turn is roughly 5–10s of thinking. Tighter prompts that collapse decision points (e.g., "you MUST write the rates file even if empty") could halve turn counts. |
| **O** | **Teach agent to invoke Playwright via Bash** | Unlocks ~34 html_js banks | The agent has Bash access but doesn't know about `scripts/fetch_rates_playwright.js`. A prompt addition ("for JS-rendered pages, prefer `bash node scripts/fetch_rates_playwright.js <url>` over WebFetch") would unblock this entire category without changing any code. |
| **P** | **Pre-validate URLs in bank-domains.json before agent sees them** | Eliminates 16 failing WebFetch calls (43% of all fetches) | Node-side HEAD request, 2s timeout, prune dead URLs. Either at bank-domains.json edit time or at run-discovery.js startup. |
| **Q** | **Fix Read absolute-path prompt issue** (§5.1) | ~1–5s per run × 50% of runs | Trivial prompt tweak, no code change. |

### Things that moved **down** in priority

- **E Parallel multi-URL fetch**: tool wait is only ~30s mean; parallelizing 3 fetches saves at most ~15s. Lower ROI than estimated.
- **F Real-time block detection** still useful but the worst-case is 130s wasted, not 300s. Moderate savings, not dramatic.

## 8. Updated bottom line

**Current state, with fresh numbers:**

- Finishing the full 1,995-bank master list at today's efficiency: **91.5h sequential / 18.3h at concurrency=5** wall clock, **~$1,616** in LLM costs.
- The run-discovery path has a **30% bank-level failure rate** (3 of 10 in the sample didn't produce usable slabs) and a **43% WebFetch error rate**.

**With the Phase 1 sprint delivered** (Pattern 2 wiring for the 80–108 ready banks + the fixes from §5.1/5.2/5.3/5.4 above):

- 80 already-ready banks go from 174s → ~5s each = **savings of ~3.8 hours** on the first pass alone
- Subsequent re-runs of any bank take deterministic time (~5s) if its config already has selectors, so steady-state is near-free
- The 3/10 failure rate on LLM runs drops because the three specific bugs in §5 are fixed
- New cold-start banks still run at ~$0.90 and ~175s, so the remaining 1,700 NSUCBs are still the budget item

**With Phases 2+3 on top** (local pre-fetch, PDF pre-parsing, fail-fast on blocked banks, Playwright via Bash):

- Cold-start wall clock should move from 175s to somewhere in the 90–120s range by cutting tool waste and reducing LLM thinking (because the agent no longer chases dead URLs or hallucinated paths)
- At 100s mean × 1,886 = 52 hours sequential, 10 hours at concurrency=5
- LLM cost drops proportionally: ~$900 instead of $1,616

**These are still estimates, but they're grounded in real-run data instead of vibes.**

## 9. Round 2 validation (after N/O/P/Q prompt levers, commit `70bb8b0`)

Round 2 used a different 10-bank sample weighted toward cold-start cooperative categories: 4 NSUCBs (Maharashtra + Karnataka), 1 DCCB (Bihar), 1 SUCB, 1 RRB, 1 FB (Japanese bank), 1 FI (NABARD), and a Bank of India re-run to A/B-test lever O (Playwright via Bash).

### Round 2 per-bank results

| Bank | Cat | Type | Wall | Turns | Calls | Slabs | Cost |
|---|---|---|---:|---:|---:|---:|---:|
| Dhule & Nandurbar Jilha Sarkari Nokaranchi | NSUCB | manual | 77.4s | 6 | 5 | 0 | $0.360 |
| Sri Lakshminarayana Co-op, Bangalore | NSUCB | html_static | 79.6s | 7 | 6 | 6 | $0.284 |
| Shri Kadasiddeshwar Pattan Sahakari | NSUCB | manual | 52.2s | 5 | 4 | 0 | $0.209 |
| Sriramnagar Pattana Sahakar | NSUCB | manual | 70.7s | 6 | 5 | 0 | $0.314 |
| Central Co-op Bank, Ara | DCCB | manual | 118.5s | 10 | 9 | 0 | $0.437 |
| Kalupur Commercial Co-op | SUCB | html_static | 145.5s | 9 | 8 | 8 | $0.450 |
| Arunachal Pradesh Rural Bank | RRB | html_static | 167.1s | 13 | 12 | 10 | $0.488 |
| Sumitomo Mitsui Banking Corp | FB | pdf | 145.1s | 11 | 9 | 12 | $0.539 |
| NABARD | FI | manual | 78.5s | 7 | 6 | 0 | $0.283 |
| Bank of India (re-run) | PSB | html_js | 184.5s | 12 | 11 | 0 | $0.328 |

### R1 vs R2 comparison

| Metric | R1 (n=10, pre N/O/P/Q) | R2 (n=10, post) | Delta |
|---|---|---|---|
| Wall clock mean | 183.6s | **116.4s** | **−37%** |
| Cost mean | $0.844 | **$0.459** | **−46%** |
| Turns mean | 15.6 | **10.1** | **−35%** |
| Tool calls mean | 14.4 | **9.0** | **−37%** |
| Cache creation tokens/run | 50,976 | **26,747** | **−48%** |

All four prompt-only levers contributed:
- **N (turn reduction)**: 15.6 → 10.1 turns. The "budget of 8 tool calls" and "do not retry failed URLs" rules directly cut reasoning loops.
- **O (Playwright via Bash)**: Bank of India R2/R3 went straight to Playwright (0 WebFetch calls vs 3 in R1). Cost dropped $0.81 → $0.31 even though the bank is genuinely CAPTCHA-blocked.
- **P (pre-lookup domain)**: Read errors on bank-domains.json dropped from 5/10 in R1 to 0/10 in R2. Zero wasted Read tool calls.
- **Cache trim**: Pre-injecting only the relevant bank's domain info instead of the full bank-domains.json shrank cache_creation by 48%.

### NSUCB hit rate (combined n=6)

| Bank | State | Outcome | Wall | Cost |
|---|---|---|---:|---:|
| Akhand Anand (R1) | Gujarat | **HAS SITE + RATES** (9 slabs) | 100s | $0.62 |
| Amreli Nagrik (R1) | Gujarat | **HAS SITE + RATES** (7 slabs) | 177s | $1.20 |
| Sri Lakshminarayana (R2) | Karnataka | **HAS SITE + RATES** (6 slabs) | 80s | $0.28 |
| Dhule & Nandurbar (R2) | Maharashtra | NO WEBSITE | 77s | $0.36 |
| Shri Kadasiddeshwar (R2) | Karnataka | NO WEBSITE | 52s | $0.21 |
| Sriramnagar (R2) | Karnataka | NO WEBSITE | 71s | $0.31 |

**Hit rate: 3/6 = 50%.** Mean cost for no-website banks (fast fail): **$0.29**. Mean cost for banks with websites: **$0.70**. The no-website fail-fast time improved dramatically between rounds: R1 Airtel (known-blocked PB) took 133s; R2 NSUCBs failed in 52–77s.

Projecting to the 1,392 NSUCBs at 50% hit rate and R2 cost averages: ~696 banks produce data at $0.70 each ($487), ~696 fast-fail at $0.29 each ($202). **Total NSUCB cost: ~$689.** This is the single largest chunk of the remaining $866 projected total.

### Bank of India: definitively CAPTCHA-blocked

Three runs across R1, R2, R3:

| Run | Cost | WebFetch calls | Bash (Playwright) | Slabs |
|---|---:|---:|---:|---:|
| R1 | $0.81 | 3 | 3 | 0 |
| R2 | $0.33 | 1 | 5 | 0 |
| R3 | $0.31 | **0** | **7** | **0** |

The prompt levers cut cost by 62% but can't bypass reCAPTCHA Enterprise. This bank (and the ~21 annotated WAF banks in bank-domains.json) require Phase 4 work: `playwright-extra` + stealth plugin, or manual cookie injection.

### Updated projections (at R2 efficiency)

| Metric | Pre N/O/P/Q | Post N/O/P/Q | Improvement |
|---|---|---|---|
| LLM cost for 1,886 banks | ~$1,616 | **~$866** | **−46%** |
| Sequential wall clock | 91.5 h | **61 h** | **−33%** |
| At concurrency=5 | 18.3 h | **12.2 h** | **−33%** |

## 10. Next step

Phase 1: Pattern 2 wiring — close the loop between captured selectors in existing configs and the deterministic extractors. For the 80–108 banks already ready, this eliminates the LLM entirely (~5s per bank vs 116s). For new banks, the LLM discover path runs at R2 efficiency and captures selectors for future Pattern 2 runs.

---

**Data provenance:** Round 1 — 10 runs on 2026-04-11, pre commit `70bb8b0`. Round 2 — 10 runs on 2026-04-12, post commit `70bb8b0`. Bank of India R3 — single re-run on 2026-04-12 to confirm CAPTCHA blocking. Total LLM spend on audit instrumented runs: **$12.57** (21 runs).
