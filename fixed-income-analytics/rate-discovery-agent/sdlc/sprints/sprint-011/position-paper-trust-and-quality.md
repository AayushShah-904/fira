# Position Paper — Trust Is the Product

**From a rate-collection pipeline to a fixed-income engine people stake money on.**

| | |
|---|---|
| **Status** | DRAFT for operator review — analysis & proposed framing, not an adopted decision |
| **Date** | 2026-06-26 |
| **Author** | Samir Joshi (direction) · Claude (synthesis & measurement) |
| **Audience** | Operator + PM (handoff stakeholders) |
| **Builds on** | `sdlc/sprints/sprint-011/design/qa-data-quality-draft.md` (the mechanism library), Sprint 005–010 retros, `sprint-011/plan/sprint-011-scope.md` |
| **Supersedes framing of** | the "four problem buckets" as the unit of work — it reorganizes them, it does not discard them |

---

## 0. TL;DR

We have been treating this as four engineering problems: (1) container/blob runs, (2) URL discovery, (3) download/parse, (4) confidence/QA. We got good at the plumbing. But the goal — hand the product to the PM and schedule auto-runs by tier — is blocked on something the four-bucket framing doesn't name: **a person about to move real money has no way to know whether the rate we surface is real.**

When you organize the work around *that person's decision* instead of our pipeline, trust turns out to have **seven** dimensions, not two. We measured the three that were measurable. The results:

- **Freshness:** only ~35% of shipped slabs are verifiably <6 months old; **42% carry no date at all**; the staleness badge is silently broken.
- **Completeness:** **4 of 578 banks** are independently verified as complete; **ICICI — a top-5 bank — ships 2 rate slabs** when it should have 30+. This dimension is essentially unmeasured across the fleet.
- **Coverage:** the "1,995 banks" denominator is 87% tiny co-ops; against the ~235 banks anyone actually searches, we're strong.

The realization: **the product ships bare numbers with none of the trust signals attached** — even though we've already *built* much of the machinery (snapshots, confidence tiers, cross-check, lineage). It lives in audit logs, not on the rate.

The proposal: make **a per-rate Trust Contract** the organizing artifact — every rate the site shows declares, on all seven axes, how far you can trust it, with a clickable source. That contract is simultaneously the product feature that earns real-money trust ("don't trust us — verify"), the handoff deliverable to the PM, and the definition of "done" for every item in the QA design draft.

**The ask:** adopt the Trust Contract as the spine, and sequence the work as *cheap trust wins first* (surface what's already built; fix freshness hygiene) → *ground-truth seed set* (the keystone that unblocks correctness + completeness) → *reliability for unattended runs* → *coverage as an explicit product decision.*

---

## 1. The question behind the question

The brief was: "we keep struggling to collect rates — four issue buckets — create a strategy to close them so we can hand the product to the PM and schedule auto-runs by bank tier."

The four buckets are real and they are where the pain has been felt:

1. **Managing container runs + writing complete info (data + control plane) to blob.**
2. **Discovering the correct URL for each bank.**
3. **Downloading and parsing the information correctly.**
4. **Overall confidence — assuring quality.**

But buckets 1–3 are *means*. Bucket 4 — "the confidence is missing" — is the actual blocker, and it is stated from our side of the glass ("are *we* confident?"). The product is a website that wants to be **the analytic engine for fixed income**. A user arrives in a *discovery* phase — "what's the best FD rate for my money and tenure?" — and the very next step is **investment: real money moves.**

So the operative question is not "are we confident?" It is:

> **How do we assure the person — at the moment they're about to commit real money — that the rate we surface is real, current, complete, and theirs to act on?**

Everything below is organized around answering that, because that is the bar the PM and the end user will hold us to. The four buckets don't disappear; they become the means of populating an answer.

---

## 2. What the runs taught us — the problems, honestly

Five sprints of field experience (005–010), mined for hard-won learnings. Condensed; full detail in each sprint's retro.

**Bucket 1 — orchestration & blob.** Two different problems wear one label:
- *Data integrity is solved.* Safe-write Rules 2/3 blocked **41 destructive overwrites** in the 513-bank `550ptm4` cohort; the 25-minute cohort watchdog survived a clean 6h25m run. Garbage-overwrite incidents (axis 162→0, BoB 73→0) are structurally prevented.
- *Execution success is not.* The last 44-bank batch was **38/44 — 6 failed**, and the failures were **axis, kotak, indusind, csb, tamilnad-mercantile, bombay-mercantile**: tier-1 banks. "No corruption" was hiding "the marquee banks don't complete." 138 banks are registry-marked cloud-incapable (75 repeat zero-slab, 63 crash pre-flight).

**Bucket 2 — discovery.** Field rules (`.bank.in` preference, multilingual search, WAF decay registry, TLS skip-verify) are codified and working. But **discovery accuracy was never quantified** — there has been no funnel and no success-rate number. The biggest *internal* leak: banks with a working domain but no FD rate page located.

**Bucket 3 — extraction.** The deterministic dispatcher systematically under-extracts relative to the LLM (an old audit found the LLM caught **759 slabs** the dispatcher missed across 87 banks; 104 banks where the dispatcher returned 0 and the LLM found rows). Multi-table, PDF, and OCR paths exist; IBU pre-flight crashes and image-only co-ops remain.

**Bucket 4 — confidence/QA.** Gates were added reactively, each one sprint *after* an incident exposed the need: bounds (S004) → semantic checks (S008) → coverage gate (S010). The judge that measures value-correctness **over-flags 7×** (5.3% headline vs ~0.7% true error). The golden regression gate is built but **dormant** (blocked on snapshot backfill).

**The meta-pattern across all four:** *metrics have exposed our problems faster than architecture has caught them.* We learned about the 29 wrong banks (Sprint 007) from an independent audit, about the partial_silent regression from a post-cohort pack diff, about the FCNR contamination from a PM catching Yes Bank missing. **Every major quality failure was found by looking, after the fact — not by a gate firing.** That is the deepest lesson, and it dictates the strategy: *shift measurement to the left, attach it to the rate, and make it user-visible.*

---

## 3. The reframe — trust from the money decision backward

Picture the user. They see:

> **Bank X — 7.75% · 18 months · senior citizen**

and they are about to lock in ₹10 lakh. For that single line to be trustworthy, **seven** things must hold. The first two we already worried about; the other five the pipeline framing quietly skipped.

| # | The user's actual question | Why it matters for *this* product |
|---|---|---|
| 1 | **Correct** — "Is this really their rate?" | A wrong number is a wrong investment. |
| 2 | **Complete (this bank)** — "Is this their *best*, or did you miss a higher slab?" | A "best-rate engine" that misses the best slab has failed its one job — and **a missed slab is invisible**, where a wrong number might trip a plausibility check. |
| 3 | **Complete (all banks)** — "Is the best rate maybe at a bank you don't list?" | "Best" is only as good as the set we compare across. |
| 4 | **Current** — "Is this still offered today?" | A 2-year-old rate the bank no longer pays is a lie of omission. |
| 5 | **Applicable to me** — "Is this for *my* amount, age, tenure, resident type?" | A rate that's only for senior-citizen ≥₹2cr non-callable, shown as general, is a *correct number* and a *wrong recommendation*. |
| 6 | **Verifiable** — "Why should I believe you — can I check?" | Real money demands proof, not assertion. |
| 7 | **Honest about doubt** — "What do you *not* know here?" | A trustworthy engine distinguishes "verified" from "best-effort" so the user can calibrate. |

Rows **2, 5, and 6** are exactly what an inside-out "fix the pipeline" framing under-serves. They are not edge cases — they are the difference between *a list of numbers* and *an analytic engine you would stake money on.* In particular:

> **Completeness is a correctness failure in disguise.** If we extract ICICI's 2-slab "ladder" perfectly, every number we show is correct — and we have still misled every user looking for ICICI's best rate, because the 7.9% on the tenure we never parsed is the answer they came for.

---

## 4. The three axes — Reliability, Quality, Trust

The seven dimensions stack into three axes, and the stack is a **dependency order**:

```
   RELIABILITY   →   QUALITY        →   TRUST
   (the system)      (the data)         (the user's warranted belief)

   runs complete     correct            verifiable / has provenance
   writes don't      complete           confidence is calibrated
     corrupt         current            uncertainty is disclosed
                     applicable
```

- **Reliability** — *does the pipeline run to completion and persist exactly what it extracted, without loss or corruption?* (Original bucket 1.) Necessary, because a run that dies mid-cohort or clobbers good data can't produce good data.
- **Quality** — *is what we extracted actually good?* The four intrinsic properties: correct, complete, current, applicable. (Buckets 2–3 produce it; bucket 4 measures it.) These are true or false **whether or not anyone looks.**
- **Trust** — *can the person about to invest believe us, and should they?* Trust is **Quality made visible and provable**: provenance, calibrated confidence, disclosed doubt.

Each axis is **necessary but not sufficient** for the next. Perfect uptime delivering unverified numbers isn't a product. Perfect data nobody can verify won't be believed with real money.

**And here is the strategic indictment of our own history:** we have spent **most** of our engineering on Reliability, **some** on measuring Quality, and **almost nothing** on Trust — the only layer the user actually experiences. The pack ships bare numbers. The snapshots, the confidence tiers, the cross-check, the lineage design — the raw material of Trust — all exist, but **in `output/audit/` logs, not on the rate.** Closing the gap is mostly *exposure and calibration of work already done*, not green-field building. That is good news for cost and timeline.

---

## 5. The measured scorecard — current state (2026-06-26)

We held a discipline this whole exercise: **measure before planning.** Three read-only measurement passes over the shipped pack (`pack/dist/rates-pack.json`, 9,202 slabs / 578 banks, generated 2026-06-11), the registry (`data/bank-domains.json`), and `output/latest/`. Method and caveats in the Appendix.

### 5.1 Coverage — the funnel

| Stage | Count | % of universe |
|---|---:|---:|
| **Universe** (RBI master list `data/Indian_Banks_Comprehensive_List_RBI.csv`) | **1,995** | 100% |
| In registry (`bank-domains.json`) | 1,037 | 52% |
| Has a domain | 1,028 | 51% |
| Has an FD rate page | 723 | 36% |
| Produced output | 570 | 29% |
| **Produced ≥1 slab** | **448** | **22%** |
| High extraction-confidence | 428 | 21% |

**The denominator is mostly noise.** 1,744 of the 1,995 (**87%**) are tiny **Non-Scheduled Urban Co-ops (1,392) + District Central Co-ops (352)** — many with no website at all. The **consequential set** — 12 PSB + 21 private + 11 SFB + 44 foreign + 37 IBU + 28 RRB + the scheduled co-ops — is **~235 banks**, and our high-confidence coverage is concentrated there. "22% of universe" is a denominator artifact; against the banks people search, we are strong. Biggest *internal* leak: **305 banks** have a working domain but no FD rate page located.

### 5.2 Freshness — "timely," measured

Reference date 2026-06-26. Freshness field is `effective_date` at the variant level.

| | Fresh (<6mo) | Stale (>18mo) | **Undated** | **Stale + undated** |
|---|---:|---:|---:|---:|
| By slab (of 9,202) | 34.96% | 10.17% | **41.75%** | **51.9%** |
| By bank (worst-case, of 578) | 15.57% | 11.94% | 61.07% | **73.0%** |

Three findings make this a *trust* problem, not just a number:
- **42% of slabs carry no `effective_date`** — we cannot state their age at all.
- **The `stale` badge is broken.** It only parses ISO dates, but 79 of 321 dates are free-form (`1st July 1995`, `18.12.2020`), so it **undercounts true staleness by ~33%.** The one freshness signal in the product can't be trusted.
- `effective_date` is **format-inconsistent** (ISO mixed with `01.07.2025`, `8th June 2026`) — a write-layer hygiene defect.

The honest sentence to the PM today: *"only ~35% of what we ship is verifiably under six months old, and we can't tell you the age of 42% of it."*

### 5.3 Completeness — the blind spot

| Signal | Result |
|---|---|
| Independently **verified complete** (Sprint-008 cross-check, all-FULL) | **4 of 578 banks** |
| **Never cross-checked at all** | **94%** of shipped banks |
| Visibly thin/empty ladders (structural proxy) | **~173 of 578 (30%)** |
| Banks shipping **zero** FD slabs | 126 |
| `truncated_ladder` anomalies | 0 — *but the gate floor is permissive; a 6-slab ladder on an 18-tenure page passes clean* |

The smoking gun: **ICICI Bank ships 2 regular slabs** (`india-post-payments-bank`, `nsdl-payments-bank`, `mashreqbank` likewise at 2). 16 more banks have slabs but **zero parsed tenures** (J&K Bank n=39, Shinhan n=26) — which also blinds the truncation detector. And it's systemic, not incidental: **45% of variants rode the LLM path vs 26% deterministic**, precisely because the deterministic path under-extracts — heavy LLM reliance is the *symptom*, not the cure.

**This is the least-verified dimension of all three.** Correctness has at least been sampled; freshness is fully measurable; completeness on the shipped pack is essentially unknown — and for a best-rate engine it's the most damaging, because it's invisible.

### 5.4 Correctness — from the existing value audit

The Sprint-008 value-correctness sampling audit (`output/audit/2026-05-27T14-51-50-155Z/summary.json`): **5.3% measured error**, de-noised to **~0.7% true** after correcting the judge's 7× over-flag (tier-mismatch false positives). Two caveats keep this from being reassuring: (a) the ~0.7% rests on **1 confirmed bug in n=281** — the confidence interval is wide; **we cannot yet quote a tight error bar**; (b) **470 of ~751 sampled slabs were "not-found"** by the audit — it couldn't even re-locate them in the source, itself a provenance/freshness signal.

### 5.5 The consolidated 7-dimension scorecard

| Dimension | Axis | Measured reality (2026-06-26) | State |
|---|---|---|---|
| 1 Correct | Quality | 5.3% measured / ~0.7% true; no tight error bar; 470/751 not re-locatable | Sampled, shaky |
| 2 Complete (bank) | Quality | **4/578 verified; ~30% visibly thin; ICICI = 2 slabs** | **BLIND SPOT** |
| 3 Complete (universe) | Quality | 126 ship zero data; consequential ~235 covered; co-op tail unaddressable | Partial |
| 4 Current | Quality | **51.9% stale-or-undated; 42% undated**; badge broken | Measured, poor |
| 5 Applicable | Quality | qualifiers present but unverified; 16 banks unparsed tenures; tier-mismatch = audit's #1 confusion | Unverified |
| 6 Verifiable | Trust | snapshot/lineage substrate exists but **internal-only** | Built, not surfaced |
| 7 Honest about doubt | Trust | verified/needs_review tiers computed but **not surfaced**; only 4 positively verified | Built, not surfaced |

> **The one-sentence truth:** *Of 578 shipped banks, exactly four have been independently verified as complete; we cannot state the age of 42% of our rates; and the product exposes none of the seven trust signals to the user. We have a pack of numbers, not yet an engine you would stake money on.*

---

## 6. The Trust Contract — the core deliverable

### 6.1 The principle

> **Every rate the site surfaces declares — on all seven axes — how far you can trust it, and links to its source.**

This single artifact is three things at once: the **product feature** that earns real-money trust, the **handoff contract** to the PM, and the **definition of "done"** for every mechanism in `qa-data-quality-draft.md`. We stop asking "are we confident?" and start *attaching the answer to each rate.*

### 6.2 The per-rate trust profile (proposed schema)

Carried per slab (or per variant where a field is uniform), denormalized into the pack and surfaced by the UI:

```jsonc
{
  "rate": 7.75,
  "trust": {
    // 1. CORRECT
    "correctness": "verified | cross_checked | single_source | unverified",
    "correctness_basis": "ground_truth | dual_extraction_agree | structural_pass",

    // 2. COMPLETE (this bank)
    "ladder_completeness": "verified_complete | agreement_complete | unverified | known_partial",
    "completeness_basis": "ground_truth | extractor_judge_agree | slab_count_plausible",

    // 4. CURRENT
    "effective_date": "2026-06-13",      // normalized ISO, REQUIRED — null is a failure state, not a blank
    "freshness": "fresh | recent | aging | stale | undated",
    "verified_at": "2026-06-20T...",     // when we last confirmed against source

    // 5. APPLICABLE
    "qualifiers": {
      "customer_type": "general | senior",
      "deposit_tier": "below_2cr | bulk_2cr_plus",
      "callable": true,
      "scheme": "regular | special_xyz",
      "residency": "domestic | nre | nro | fcnr | gift",
      "currency": "INR"
    },

    // 6. VERIFIABLE  — the user-facing trust lever
    "source_url": "https://icicibank.com/.../fd-rates",
    "source_snapshot": "snap://<content-hash>",   // click-through to what we actually read
    "captured_at": "2026-06-20T...",

    // 7. HONEST ABOUT DOUBT
    "confidence_tier": "gold | silver | bronze",
    "warnings": ["..."]                  // disclosed, not hidden
  }
}
```

### 6.3 What populates each field — and how it maps to work already designed

| Trust field | Populated by | Status / source |
|---|---|---|
| `correctness` | ground-truth seed set + recalibrated judge; structural checks | judge exists (recalibrate); `lib/checks/structural-checks.js` exists |
| `ladder_completeness` | **extractor↔QA-judge agreement on the slab set** | this is the QA-judge / parallel-extraction in draft §2.4, §8.2 — promote from audit to per-bank gate |
| `effective_date` / `freshness` | date normalization at write time + broken-badge fix | **new, cheap** — hygiene fix |
| `qualifiers` | extractor contract completeness | draft §9.4 typed contracts; today partial |
| `source_url` / `source_snapshot` | the snapshot substrate, **exposed** | substrate exists (S008 Phase 1) + draft §8.6 lineage — currently internal |
| `confidence_tier` | confidence scorer, **surfaced** | `lib/confidence/score.js` exists (verified/needs_review) — currently behind a flag |

The pattern is unmistakable: **most fields are populated by machinery we already built — we just never attached it to the rate.** Rows 6 and 7 are nearly free. Row 4 is a hygiene fix. Rows 1 and 2 need the seed set (§7.3).

### 6.4 The user-facing manifestation — "don't trust us, verify"

Provenance (field 6) is the **cheapest, highest-leverage** trust lever we have. A skeptical investor who can click a rate and see *the bank's own page, as we read it on this date* is being offered proof, not a promise. For a fixed-income engine, that single affordance does more for credibility than any internal gate. The substrate exists; the work is exposure (a public snapshot view + source link), not construction.

### 6.5 What the PM actually receives

Not "a pack of numbers" but **"a pack where every number declares how far you can trust it, and why,"** plus:
- a **trust-tier rollup** per bank (Gold/Silver/Bronze) the UI can badge and filter on;
- a **freshness SLA** statement per tier (§8);
- an **honest coverage statement** — "best among N covered banks; here are the M we can't reliably collect" — rather than silent gaps;
- a **runbook** for triggering/monitoring scheduled runs.

---

## 7. Strategy — how we populate the contract

The spine is the **tier cohort**, reconciled with the tiers already defined in `qa-data-quality-draft.md` §7.1:

| Tier | Banks | Trust target |
|---|---|---|
| **T1** — all PSBs + major PVBs | ~30 | Gold: verified-complete + correct + fresh; manual fallback guarantees presence |
| **T2** — mid PVBs + all SFBs | ~150–200 | Silver: dual-extraction agreement + structural pass |
| **T3** — RRBs, foreign, large co-ops | ~300–400 | Bronze: structural pass + provenance |
| **T4** — small co-ops, DCCBs | ~1,500+ | Best-effort, explicitly classified; the unaddressable tail is *labeled*, not chased |

### 7.1 Two sharpening principles

**(a) The ground-truth seed set is the keystone.** Human-verify **~50–75 banks** (T1 + the top of T2) **once.** That single asset is, simultaneously: the **judge calibration set** (kills the 7× over-flag, gives a real error bar), the **golden-test fixtures** (activates the dormant gate — for these banks only), the **prompt-regression corpus** (draft Appendix A), and the **correctness + completeness ground truth** (fields 1 and 2 of the contract). It is the one expensive thing that unblocks the most contract fields at once.

**(b) Trust budget follows surfacing probability — verify "tier-1 *answers*," not just "tier-1 banks."** The site *recommends.* The slab currently ranked #1 for "best 1-year senior FD" is seen by every user with that query and must be bulletproof; a mid-ladder slab at an obscure co-op is low-stakes. Weight verification by **surfacing-probability × money**: the current top-of-leaderboard slab in each (tenure × category × customer-type) bucket is the highest-stakes object in the whole system.

### 7.2 Sequence — cheap trust wins first

1. **Freshness hygiene + surface what's built (days, not weeks).** Normalize `effective_date` at write time; require a date on every slab (investigate the 42% undated — see §9); fix the broken stale badge; **expose `source_url` + snapshot + `confidence_tier` on every rate.** This lights up contract fields 4, 6, 7 — the Trust axis — almost entirely from existing material. Largest trust gain per unit effort.
2. **Ground-truth seed set + judge recalibration (the keystone).** Unblocks fields 1 and 2 for the banks that matter; converts the quality gate from *count* to *correctness*; produces a defensible error bar.
3. **Completeness gate.** Promote the extractor↔QA-judge cross-extraction from a 6%-coverage audit to a **per-bank agreement gate** (draft §2.4/§8.2). Disagree → take the union, flag `unverified`. This is the genuinely new build, and the one that fixes the blind spot.
4. **Reliability for unattended runs.** Out-of-process watchdog (Sprint-010 Phase 7, deferred; scope item 2), control-plane retry, and fix the **tier-1 execution failures** (axis/kotak/indusind) — *the same cohort as the seed set*, so do them together. Decide the Consumption-freeze question: diagnose or accept D4 (~$144/mo ≪ analyst time).
5. **Coverage as an explicit product decision (§9).** Attack the measured funnel leaks (305 no-rate-page; 63 crash-pre-flight) tier by tier; classify the unaddressable tail rather than chasing it.

**Relationship to the QA design draft:** `qa-data-quality-draft.md` is the **mechanism library** — detection signals, the agent network, lineage, SLAs, the QA-judge, manual entry. This paper is the **prioritization and the product contract** those mechanisms serve. Where they meet: the draft's QA-judge becomes contract field 2; its lineage becomes field 6; its confidence split becomes field 7; its tiering becomes the cohort spine. Nothing in the draft is discarded; it is *sequenced* by which contract field it lights up, cheapest-trust-first.

### 7.3 Note on Sprint-011's current scope

The Sprint-011 plan already front-loads several items that map cleanly onto this frame and should be kept: **item 18** (extract ALL configured variants — a *completeness* fix), **item 21** (LLM dedup + effective-date sanitisation — a *freshness/correctness* hygiene fix, directly the 42%-undated and `1st July 1995` problems), **item 20** (cohort UNION rule — a *coverage-honesty* fix), and **item 12** (clean-but-fewer safe-write — *reliability*). This paper doesn't replace that backlog; it gives it a **why** and a priority order: the items that light up Trust-axis contract fields for T1/T2 answers come first.

---

## 8. What "done" looks like — handoff & auto-scheduling

Tiered SLAs (from draft §7.2), now expressed as *contract guarantees*:

| Tier | Max staleness at pack time | Trust floor | On failure |
|---|---|---|---|
| T1 | 48h | Gold (verified or manual) | Immediate alert → manual entry |
| T2 | 7 days | Silver (dual-extraction agree) | Alert ≤24h |
| T3 | 30 days | Bronze (structural + provenance) | Next cohort |
| T4 | best-effort | labeled | automated only |

**Auto-scheduling becomes possible only once the contract is populated**, because a schedule is a promise of freshness, and you can't promise freshness you don't measure. The scheduling engine is **change-detection-driven** (the snapshot substrate already exists): re-run a bank when its source changes or its SLA clock expires — cadence by tier (T1 weekly + daily liveness HEAD-check per draft §7.5; long tail monthly/quarterly). This is what makes auto-runs both *timely* and *cheap*.

**Exit criteria for "trustworthy enough to hand over":**
1. Every shipped rate carries a populated trust profile (all 7 fields non-null or explicitly `unverified`).
2. T1 (~30 banks): 100% present, Gold, <48h — enforced as a hard gate (draft §7.4).
3. A **measured fleet error rate with a stated confidence interval** (from the seed set + random spot-check), not a guess.
4. Freshness: 0% undated in the shipped pack; stale badge correct for all date formats.
5. Provenance live: every rate links to a source snapshot in the UI.
6. The PM has the trust-tier rollup, the SLA statement, and a run/monitor runbook.

---

## 9. Open decisions & risks

1. **Coverage product decision (PM-level).** Do we claim "all ~2,000 Indian banks" or **"every bank that matters, to an SLA, + an explicit list of the ones we can't reliably collect"?** The data says the latter is the only honest option (87% of the roster is website-less co-ops). This gates the funnel target, the schedule, and the marketing. Needs an explicit call. (Draft §"Coverage vs Accuracy" proposes the `UNVERIFIABLE` gate state for exactly this.)
2. **The 42%-undated root cause.** Capture failure (extractor never grabbed the date the page showed) or pack-drop (we have it, the builder nulls it)? This decides whether freshness hygiene is a 2-day fix or a re-extraction job. **First task of any plan.**
3. **Model constraint is fixed.** Azure OpenAI only (Microsoft credit excludes Claude/marketplace models) — per draft §8.4. All agent/judge/extraction design must stay within GPT-4o / 4o-mini / o-series. No strategy here assumes otherwise.
4. **Cost per refresh.** Auto-scheduling the consequential set weekly has a token cost the PM will own; execution receipts already track `total_cost_usd`. Tiered cadence is partly a cost-control decision, not only a freshness one. Surface the number.
5. **Judge trust is bootstrapped from a small sample.** The ~0.7% true error rests on 1 confirmed bug in 281; the seed set must be large enough to give the error bar real power (draft §"Error Budget" sampling math: ~200 banks for a 2% fleet estimate at 95%).

---

## 10. Appendix — measurement method & provenance of the numbers

- **All numbers are read-only measurements taken 2026-06-26**; no files modified, nothing re-scraped. Aggregation via single-file `jq`, `node -e` scripts, and Grep (the permission layer blocks glob-wildcard shell commands).
- **Coverage funnel:** universe from `data/Indian_Banks_Comprehensive_List_RBI.csv` (1,995 rows; category split sums exactly); registry from `data/bank-domains.json` (1,037 keys); output from `output/latest/` (570 domestic + 186 variant rate files). Conversion %s are pipeline throughput, not strict set inclusion.
- **Freshness:** `pack/dist/rates-pack.json`, field `banks[].products.fd.<variant>.effective_date` (variant level); reference 2026-06-26; non-ISO dates normalized (0 parse failures). `stale` badge cross-checked — undercounts by ~33% (ignores non-ISO).
- **Completeness:** primary signal `output/audit/crosscheck-2026-05-27.../cross-check.json` (FOUND but 6% coverage, template-only, predates the pack, author-labeled low-precision — *not a pack verifier*); secondary `sdlc/sprints/sprint-003/.../under-extraction-scope.md`; structural proxies computed from the pack. The defensible "~30% visibly thin" is a floor; true incompleteness among the 398 "looks-full" banks is **unknown** and likely higher.
- **Correctness:** `output/audit/2026-05-27T14-51-50-155Z/summary.json` (5.3% raw; ~0.7% de-noised; 470/751 not-found).
- **Caveat carried throughout:** the single cleanest signal that does **not** exist on disk is a full-coverage, rate-centric cross-check of the *shipped* pack. Producing it is the completeness-gate work in §7.2 step 3.

---

*This is a draft for review. It proposes a framing and a sequence; it does not commit the sprint. The measured numbers in §5 are facts as of 2026-06-26 regardless of whether the framing is adopted.*
