# QA & Data Quality — Draft Design

**Status:** Draft — pre-sprint design exploration. Not yet assigned to a sprint.
**Started:** 2026-06-18
**Author:** Samir Joshi (design), Claude (synthesis)

---

## Problem Statement

The rate discovery pipeline collects FD rates from ~1900 Indian banks. Many things can go wrong silently: incorrect HTML parsing, reading a stale or dated page, a WAF blocking the real page and returning a decoy, recycling old output as fresh, PDF URLs going stale when a bank publishes a new document. The pipeline currently produces output without any systematic mechanism to detect these failures or learn from them over time.

Quality assurance has three distinct axes:
1. **Automated detection** — statistical and structural checks that flag anomalies after collection
2. **Context-aware collection** — better per-bank knowledge that reduces errors before and during extraction
3. **Human QA sampling** — ground-truth verification that calibrates the automated systems

These axes are complementary. Automated detection can only flag anomalies relative to baselines. Human verification is the only way to know the agent is actually right, not just internally consistent. Per-bank context knowledge reduces the error rate so there is less to detect and correct.

---

## Axis 1 — Automated Detection

### 1.1 Statistical signals

**RBI repo rate spread**
FD rates have historically not sustained below repo − 50 bps. If a bank reports 5.5% in a 6.5% repo environment, it is either genuinely cutting rates or extraction failed. Flag when any senior-tenor slab falls below `repo_rate − threshold` (threshold configurable, default 50 bps).

**Historical drift per bank**
Track each bank's rates across runs. Any single-run change of >100 bps for the same tenure is suspicious. Gradual drift over multiple runs at the same direction is legitimate (bank is moving rates); sudden spike or crash is not.

**Category / peer-group average**
Segment banks by `bank_type` (PSB / PVB / SFB / co-op / FB) and asset-size tier. Compute the peer-group median for each tenure bucket per cohort run. A bank more than N standard deviations from its peer group warrants a flag. An SFB offering 7.2% when its cohort is at 8.5% is more suspicious than the same gap between SFB and PSB.

### 1.2 Structural signals (no reference rate needed)

**Slab count regression**
If a bank had 9 tenures last run and now has 3, that is a coverage collapse, not a rate change. Flag when slab count drops by more than 30% from the established baseline.

**Tenure coverage gap**
If we previously saw tenures `1Y / 2Y / 3Y / 5Y` and now only see `1Y / 5Y`, the middle tenures were silently dropped. This often indicates the agent parsed only one section of a multi-section rate table.

**Senior citizen premium sanity**
Virtually every Indian bank adds exactly 25–50 bps for senior citizens. Zero premium or a 200 bps premium are both anomaly flags. Senior citizen rates must always be ≥ regular rates for the same tenure.

**Tenor monotonicity**
FD rates are not always monotone, but reversals of >100 bps within the same bank's ladder for the same customer type (regular/senior) are suspicious and warrant review.

**FCNR currency spread**
USD / GBP / EUR FCNR rates follow expected relative spreads. EUR offering more than USD for the same tenure is a red flag. Flag cross-currency inversions.

**Hard plausibility bounds**
Any rate outside [1%, 12%] for an Indian FD is almost certainly a parse error. Enforce at write time.

### 1.3 Source freshness signals

**Page Last-Modified / ETag vs. run timestamp**
If the source page has not changed in 90+ days but we are serving it as freshly scraped, flag it.

**Stale-recycle fingerprint**
If the output `_rates.json` is a byte-for-byte match to a run from >N days ago *and* the source page hash has changed, the pipeline recycled old output rather than writing fresh data. This is one of the most insidious failure modes — rates look fine but are stale.

**Resolved URL tracking**
Record the *final* URL after all redirects in the run log, not just the configured URL. PSB sites frequently redirect to stale quarterly archives around quarter-end. If `resolved_url` diverges from the configured `rate_page_urls.fd`, flag it automatically.

**Dated URL staleness**
Some banks (e.g. Axis Bank) embed dates in PDF URLs (`domestic-fixed-deposits-21-may-26.pdf`). When the bank publishes new rates, the old URL may return 404 or redirect to a "document not found" page with a 200 status. Detect by: HTTP status ≠ 200 OR content hash changes from known-good state.

### 1.4 Confidence calibration

The current `extraction_confidence` field is self-reported by the same agent that may have made the error — an inherent conflict of interest. Separate into two signals:

- `agent_confidence` — what the extractor claimed (`high / medium / low / none`)
- `structural_confidence` — result of the invariant checks above (`pass / warn / fail`)

A bank with `agent_confidence: high` but `structural_confidence: fail` is a priority human-review case. Track miss rate (automated system did not flag, human found error) and false-alarm rate (automated flagged, human cleared) over time to calibrate thresholds.

---

## Axis 2 — Context-Aware Collection

### 2.1 Per-bank operational profile

The `_config.json` already captures `scraper_type`, `rate_page_urls`, and `extraction_method`. What is missing is the operational knowledge that determines *how well* the scraper works and *what to do when it fails*.

Proposed additions to `_config.json` (or a companion `_profile.json`):

```json
{
  "waf_profile": "cloudflare | akamai | none | unknown",
  "page_layout": "html-table | rate-card | embedded-pdf | js-rendered-table | image-only",
  "rate_page_stability": "stable | volatile | seasonal",
  "fallback_methods": ["playwright", "fetch-with-delay"],
  "known_issues": [
    "Rate page requires Accept-Language: hi",
    "PDF URL embeds date — must re-discover quarterly",
    "Redirects to archive every quarter — validate URL freshness"
  ]
}
```

This profile is populated two ways:
1. **Retroactive inference** — derive from existing artifacts (scraper_type → preferred_method; slab count history → stability signal). Gets ~60–70% coverage automatically.
2. **Incremental enrichment** — every time a run fails or a human QA finding is recorded, the recovery conclusion is written back to the profile. The discipline shift: **recovery analysis must end with a profile write**, not just a sprint note.

### 2.2 Failure taxonomy → corrective action

Without a taxonomy, every failure gets the same generic retry. With one, the pipeline routes to the correct correction:

| Failure type | Correct response |
|---|---|
| `waf_block` | Rotate UA, add delay, escalate to Playwright |
| `js_not_rendered` | Escalate to Playwright (fetched static, got empty table) |
| `pdf_only` | Escalate to PDF extractor |
| `layout_changed` | Flag + queue manual config update |
| `rate_page_url_moved` | Trigger rate-page re-discovery (not full bank re-discovery) |
| `stale_recycle` | Force cache-bust, re-fetch |
| `waf_decoy` | Fetch returned 200 with misleading content — Playwright or flag |

The failure type must be recorded in the run log and in the profile's `known_issues` if it recurs.

### 2.3 Extraction invariants at write time

Before writing `_rates.json`, enforce:
- At least one slab if `extraction_confidence ≠ "none"`
- No rate outside [1%, 12%]
- Senior citizen rates ≥ regular rates for the same tenure
- Slab count within 30% of established baseline (warn, not block, on first occurrence)

These are cheap, deterministic, and catch the most common parsing bugs before they reach the output.

### 2.4 Parallel extraction for tier-1 banks

For a small set of high-priority banks (top 50 by traffic or coverage importance), run two independent extractors and diff results. Agreement → high confidence. Disagreement → queue for human review rather than auto-accepting either. Expensive to do fleet-wide; targeted at the banks where errors are most costly.

---

## Axis 3 — Human QA Sampling

### 3.1 Why this axis is essential

Automated detection can only flag anomalies relative to baselines. It cannot tell you whether the baseline itself is correct. Human verification is the only source of ground truth. It also calibrates the automated systems — if the automated detectors have a 7x false-alarm rate (as measured in Sprint 008), the QA finding log is how you know which alarms to trust and suppress.

### 3.2 Sample selection — risk-scored queue

A QA engineer's time is limited. Random sampling is wasteful. The sample queue should surface the highest-leverage targets:

- Banks where `structural_confidence: fail` or `agent_confidence` ≠ `structural_confidence`
- Banks with slab count regression vs. previous run
- Banks not manually verified in >60 days
- Banks with `rate_page_stability: volatile`
- Banks where `resolved_url` diverged from configured URL
- Banks recently changed `scraper_type` (discovery found a different method)
- **Post-fix verification** — any bank flagged in a previous open QA finding

The QA engineer picks from this queue based on hunch or priority, but the queue itself surfaces high-leverage targets. Sample selection is auditable — you can see why a bank was chosen.

### 3.3 Structured finding format

QA observations must be machine-readable to close the loop. Free text notes are not actionable at scale.

```jsonl
{
  "reviewed_at": "2026-06-19T14:00Z",
  "reviewed_by": "qa-engineer",
  "bank_code": "axis-bank-limited",
  "run_ref": "2026-06-18T10:00Z",
  "verdict": "partial",
  "discrepancy_type": "missing_tenures",
  "severity": "moderate",
  "evidence": {
    "agent_reported": "5 tenures: 7D/14D/1M/3M/1Y",
    "website_shows": "8 tenures: 7D/14D/1M/3M/6M/1Y/2Y/3Y"
  },
  "recommended_action": "re-run",
  "status": "open"
}
```

**Verdict values:** `correct / partial / wrong / stale`
**Discrepancy types:** `wrong_rate / missing_tenures / wrong_product / stale_data / wrong_source_url / extra_tenures`
**Severity:** `critical` (rates are wrong) / `moderate` (tenures missing/extra) / `minor` (formatting, label)
**Status lifecycle:** `open → acknowledged → fixed → verified`

### 3.4 "Verified correct" is signal too

A finding with `verdict: correct` raises the confidence baseline for that bank and reduces its future sampling priority. Without this, the QA system only accumulates evidence of failure and has no way to record trust. Track a `trust_score` per bank that:
- Increases when a human verifies correct
- Decreases when a discrepancy is found
- Decays over time without re-verification (confidence earned last week is stronger than confidence earned 6 months ago)

### 3.5 Three feedback paths

A QA finding must flow into one or more of:

1. **Per-bank profile update** — `known_issues` updated, `rate_page_stability` revised, `fallback_methods` reconsidered. Triggers a targeted re-run of just that bank. This is the fastest loop.

2. **Detector calibration** — if the automated system missed a real error (false negative) or flagged something the QA engineer cleared (false positive), record it. Track miss rate and false-alarm rate per detector type over time. Tune thresholds accordingly.

3. **Sprint backlog** — if the same `discrepancy_type` appears across multiple banks (e.g., three co-op banks all have `wrong_source_url` because their `.bank.in` domains restructured), that is a systemic issue requiring an extractor fix, not per-bank patching. This path converts individual findings into roadmap signal.

---

## Axis 4 — Temporal Awareness

### 4.1 MPC calendar-aware anomaly weighting

Rate changes in India are not uniformly random. The RBI Monetary Policy Committee meets every two months (Feb / Apr / Jun / Aug / Oct / Dec). Repo rate decisions cascade to FD rates within days to weeks of the announcement. The anomaly detection layer should account for this:

- **Suppress rate-change anomalies** when a run falls within 14 days of an MPC meeting date. A 25 bps shift on 5 tenures simultaneously is expected, not suspicious, in that window.
- **Raise suspicion outside the window.** The same 25 bps shift mid-cycle warrants investigation.
- **Optimise run scheduling.** Cohort runs timed for the week *after* an MPC meeting maximise the chance of capturing fresh rates rather than pre-announcement values.

Implementation: a small calendar file (`data/mpc-dates.json`, updated twice a year) that the anomaly scorer consults. Not a complex model — a lookup and a date range check.

### 4.2 Rate diff log — legitimate change vs. error

When rates change between runs, the system currently knows *that* a change happened but not *what specifically* changed. A structured diff log per bank captures this:

```jsonl
{
  "diff_at": "2026-06-18T10:00Z",
  "tenure": "1Y",
  "customer_type": "regular",
  "previous_rate": 7.00,
  "current_rate": 7.25,
  "change_bps": 25,
  "direction": "up"
}
```

This serves two purposes:

1. **QA disambiguation** — a 25 bps increase on 5 tenures simultaneously after an MPC meeting is a legitimate reprice. A 200 bps jump on 1 tenure mid-cycle is a parse error. The diff log makes both patterns visible and distinguishable.
2. **Consumer value** — the most useful information is not just "what is the rate today" but "what changed and when." The diff log is directly consumable by the PM's UI as a rate-change feed.

The diff log can be computed as a post-processing step by comparing consecutive run log `output_hash` entries with the actual rate files — no in-pipeline writer needed if rate files are versioned (see §Rate Data Versioning below).

### 4.3 Profile inheritance — cross-bank learning

When the pipeline fixes a problem for one bank, that fix often applies to a whole family. Bandhan, Axis, HDFC, and ICICI all use Cloudflare — a WAF bypass that works for one probably works for all. Co-op banks on `.bank.in` share layout patterns.

A **profile inheritance** model lets a bank's `_config.json` reference a shared profile:

```json
{ "inherits_profile": "cloudflare-pvb" }
```

A single update to `profiles/cloudflare-pvb.json` propagates to all member banks without touching each config individually. Banks can override any inherited field locally. This converges with the extractor family concept (`.bank.in` co-op family) from earlier sprints — the profile system and the extractor family system are the same idea at different layers.

---

## Axis 5 — External Ground Truth

### 5.1 Three-tier external validation

The pipeline's own baselines can only detect anomalies relative to themselves. External references that do not depend on the pipeline's output provide independent validation:

**Tier 1 — RBI repo rate ± threshold (loose bound)**
Already discussed. Any FD rate below `repo_rate − 50 bps` is suspicious. Requires only the current repo rate (updated after each MPC meeting). Catches gross errors but not subtle ones.

**Tier 2 — RBI DBIE category averages (tighter, category-level)**
The RBI's Database on Indian Economy (DBIE) publishes aggregate deposit rate data by bank category (PSB / PVB / SFB). Not per-bank, but a reliable category floor/ceiling. If the pipeline's SFB category average is 8.5% but the RBI's published SFB deposit rate for the same quarter is 7.8%, the gap warrants investigation. Requires quarterly update from DBIE; can be semi-automated.

**Tier 3 — Exchange filings and investor presentations (individual PSBs)**
PSBs (publicly listed, heavily regulated) disclose rate data in quarterly investor presentations filed with BSE/NSE. These are individual-bank ground truth, not estimates. Applicable to ~20 large PSBs but is the highest-fidelity external check available for that segment. Manual or semi-automated retrieval; used for targeted QA rather than fleet-wide checks.

### 5.2 RBI as a forcing function for confidence thresholds

The three tiers provide a way to calibrate the anomaly detection thresholds empirically rather than by intuition: if Tier 3 (exchange filing) says a bank's 1Y rate is 7.0% and the pipeline reports 6.8%, that 20 bps gap is a miss. Accumulate these misses across banks and time to measure what threshold the statistical detectors would need to have caught them.

---

## Rate Data Versioning

### Git as version history

`output/latest/` is currently overwritten on each run. The run log records operational metadata but not the rate data itself. If a run produces wrong output detected two cohorts later, there is no low-cost path to last-known-good rates.

The simplest approach: **git-track the output directory** and commit after each cohort run. This provides:
- Full diff history for free — `git diff HEAD~1 output/latest/axis-bank-limited_rates.json` shows exactly what changed
- Rollback to last-known-good — `git checkout HEAD~1 -- output/latest/axis-bank-limited_rates.json`
- Diff log computation as a post-process on git history, avoiding a bespoke in-pipeline writer

The run log commit message carries the run timestamp and cohort ID, linking git history to operational metadata.

**Size concern:** 1900 banks × N runs × ~5 JSON files accumulates quickly. Mitigations:
- Git only stores changed files (already how it works — unchanged banks cost nothing)
- Use a separate shallow repo just for rate data, or `output/history/<date>/` directories instead of overwriting `latest/`
- Prune history older than 12 months for co-op / small banks; retain full history for tier-1 banks

---

## Coverage vs. Accuracy

### The UNVERIFIABLE state — a product decision

The pipeline currently maximises coverage: any output is better than no output, even at low confidence. This is the right default while building coverage from zero. As the QA system matures, a different tradeoff becomes viable.

A bank where:
- Every run produces `structural_confidence: fail`
- No human QA review has ever returned `verdict: correct`
- `waf_profile` is `decoy`

...is producing noise, not signal. Serving that output as if it were real data is actively harmful to the consumer.

The quality gate could grow a third state: `BLOCK / PASS / UNVERIFIABLE`. An unverifiable bank is excluded from the pack but tracked as a known gap — the consumer sees "we could not reliably collect rates for these 12 banks" rather than wrong rates presented as correct.

This is a **product decision**: acceptable coverage gaps vs. known-wrong data. Worth surfacing to the PM alongside the QA sprint scope. The engineering side is straightforward once the policy is decided.

### WAF decoys — a specific unverifiable pattern

Most WAF discussion focuses on hard blocks (403, CAPTCHA, timeout). The harder problem is **soft blocks**: the WAF returns 200 with plausible-looking but stale or fabricated content. This passes HTTP checks, passes the parser, and may pass structural invariants if decoy rates are within plausible bounds.

Detection options, in increasing reliability:
- **Response fingerprint mismatch** — hash of a known-good response vs. current. If hash changed but rates did not, or vice versa in a suspicious pattern, investigate.
- **Decoy telltale heuristics** — WAF decoys have subtle tells: copyright year frozen in the past, "effective from" date months old, table structure identical to last run but with numbers swapped, missing JS artifacts when the real page is JS-rendered. Encode these as lightweight checks per `waf_profile: decoy`.
- **Dual-path fetch** — fetch via two different network paths (direct + proxy, or two cloud regions). A real page returns the same content to both. A fingerprint-based decoy may differ.
- **Playwright vs. fetch agreement** — if static fetch and Playwright return different rate tables for the same URL, one got a decoy. This is parallel extraction applied specifically to WAF defence.

Decoy profile is distinct from block profile in `_config.json`: `"waf_profile": "cloudflare-decoy"` requires different operational handling than `"waf_profile": "cloudflare-block"`.

---

## Persistent State Design

*(Updated to include new log types)*

### Run log — `<bank_code>_runs.jsonl`

Append-only. One record per pipeline run for this bank.

```jsonl
{
  "run_at": "2026-06-18T10:00Z",
  "method": "playwright",
  "outcome": "success | partial | failure",
  "slab_count": 9,
  "agent_confidence": "high",
  "structural_confidence": "pass",
  "failure_type": null,
  "source_url": "https://axis.bank.in/...",
  "resolved_url": "https://axis.bank.in/...",
  "source_url_hash": "a3f2c1...",
  "output_hash": "b8e4d2..."
}
```

### Rate diff log — `<bank_code>_diffs.jsonl`

Append-only. One record per changed slab between consecutive successful runs. Computed post-run by comparing output_hash entries.

```jsonl
{
  "diff_at": "2026-06-18T10:00Z",
  "tenure": "1Y",
  "customer_type": "regular",
  "previous_rate": 7.00,
  "current_rate": 7.25,
  "change_bps": 25,
  "direction": "up"
}
```

### QA findings log — `<bank_code>_qa_reviews.jsonl`

Append-only. One record per manual review session. Schema as shown in §3.3.

### Config extension

Fields added to `_config.json`: `waf_profile`, `page_layout`, `rate_page_stability`, `fallback_methods`, `known_issues[]`, optionally `inherits_profile`.

---

## Phasing

**Phase 1 — Instrumentation (foundation)**
- Run log writer in pipeline
- Config schema extension + migration script to populate from existing artifacts
- Resolved URL tracking in fetch/Playwright layer
- Git-track output directory; commit script for post-cohort run

**Phase 2 — Automated detection**
- Structural invariants at write time (hard bounds, senior citizen check, slab count gate)
- Stale-recycle fingerprint (`output_hash` comparison)
- Slab count regression vs. run log baseline
- Separate `agent_confidence` vs. `structural_confidence`
- Rate diff log computation from consecutive run hashes

**Phase 3 — Human QA tooling**
- Risk-scored sample queue CLI (`scripts/qa/sample-queue.js`)
- QA finding writer (`scripts/qa/record-finding.js`)
- Finding → profile feedback path (update `known_issues` from finding)

**Phase 4 — Statistical and temporal detection**
- MPC calendar file + anomaly score suppression window
- RBI repo rate spread check (static config updated per MPC meeting)
- RBI DBIE category average check (quarterly)
- Category / peer-group z-score (requires cross-bank aggregation)
- Historical drift per bank (requires N≥3 run log entries)

**Phase 5 — Calibration and policy**
- Miss / false-alarm rate tracking per detector
- Trust score per bank (decays over time, increases on verified-correct)
- Detector threshold calibration from accumulated QA findings
- UNVERIFIABLE quality gate state (after policy decision with PM)
- Profile inheritance (`inherits_profile` in config)

---

## Axis 6 — Agent as a White Box

### 6.1 Prompt versioning — making prompt changes observable

The run log records extraction method but nothing about which version of the agent instructions produced the output. If quality improves or regresses between runs, there is no way to attribute it to a prompt change vs. a site change vs. a pipeline change.

Fix: hash each prompt fragment at run time and record in the run log.

```jsonl
{
  "prompt_version": {
    "discovery-workflow": "a3f2c1",
    "field-learnings":    "b8e4d2",
    "schemas":            "c1d3e4"
  }
}
```

"Failure rate dropped from 15% to 8% after `field-learnings` hash changed from `b8e4d2` to `f1a2b3`" becomes a measurable, attributable statement rather than a guess.

### 6.2 The agent's reasoning trace as structured signal

The `warnings` field in `_rates.json` is currently human-readable prose. It is also data. Recurring patterns across the fleet reveal systematic extraction confusion:

- *"Table appears to be for savings account, not FD"* — 20 banks → disambiguation gap in the prompt
- *"Could not find senior citizen rates on this page"* — 15 banks → layout heuristic missing or wrong
- *"Found rates on second tab — static fetch would have missed this"* — signals wrong `scraper_type` in config

The minimal version: a post-run script that tokenises all `warnings` fields from the cohort and reports the most frequent phrases. No NLP needed — simple frequency counts catch the most common patterns. The expensive version: classify warnings by type (`product_confusion / layout_confusion / missing_section / low_confidence`) and track rates per `bank_type × scraper_type` over time.

This is the agent explaining its own failures systematically, rather than one bank at a time.

### 6.3 Context quality as a variable distinct from prompt quality

The agent receives two inputs: instructions (prompts) and context (content it works with). Both affect output quality but fail differently and require different fixes.

Context quality failure modes:
- **Truncated HTML** — WAF returns partial response; agent extracts from incomplete content but may not know it. Structural invariants catch the symptom (low slab count), not the cause (truncated input). Fix is in the fetch layer.
- **Wrong bank metadata** — `bank_type` misclassified during discovery causes wrong heuristics. Looks like extraction error; is actually a classification error. QA finding `discrepancy_type` should include `wrong_classification`.
- **Stale `known_issues`** — agent has no forewarning about a known quirk (e.g. "PDF URL embeds date") because the config is empty. Context gap, not prompt failure.
- **Missing prior-run signal** — agent has no visibility into the previous run's outcome. Feeding a one-line summary ("last run: waf_block, resolved by playwright") improves first-attempt success rate without any prompt change.

### 6.4 Prompt regression testing — CI for agent instructions

A fixed cohort of banks with human-verified correct outputs, run against any new prompt before fleet-wide deployment.

- **Test corpus** — 30–50 banks covering every `bank_type × scraper_type × page_layout` combination. Built naturally from QA findings: every bank a QA engineer marks `verdict: correct` is a corpus candidate.
- **Pass/fail** — output matches the verified corpus within tolerance (slab count within 1, rates within 5 bps).
- **Regression disambiguation** — if the source page hash is unchanged and the output changed, the prompt caused it. If the source hash changed too, the bank repriced legitimately.

### 6.5 Systematic error analysis — from individual findings to prompt sprint items

After N QA findings accumulate, compute `discrepancy_type × bank_type × scraper_type` cross-tabs. High-count intersections are prompt improvement candidates, not per-bank config fixes. This is the feedback loop from individual QA findings back to agent instruction quality — the path from "Bandhan Bank is missing tenures" to "the html_static extractor prompt for PVB table layouts needs a fix."

---

## Axis 7 — Bank Tiering and Data SLAs

### 7.1 Tier definition

Tier assignment follows a simple, stable, self-documenting rule:

**T1 — All PSBs + major PVBs (~25–35 banks)**
PSBs are government-defined (currently 12: SBI, PNB, Bank of Baroda, Canara, Union Bank, Bank of India, Indian Bank, Central Bank, Indian Overseas, UCO, Bank of Maharashtra, Punjab & Sind). Major PVBs converge on the same set by AUM: HDFC, ICICI, Axis, Kotak, IndusInd, Yes Bank, Bandhan, IDFC First, Federal, RBL. Changes only on bank mergers (rare). No subjective scoring needed.

**T2 — Mid-size PVBs + all SFBs (~150–200 banks)**
Remaining scheduled commercial banks with national or near-national reach.

**T3 — RRBs, foreign banks, large co-ops (~300–400 banks)**
Regional or limited-footprint banks. Automated detection sufficient.

**T4 — Small co-ops, DCCBs (~1500+ banks)**
Best effort. Any valid output better than none.

### 7.2 Tiered data SLAs

| Tier | Quality floor | Max staleness at pack time | Failure response |
|---|---|---|---|
| T1 | Verified correct (agent high-conf OR manual) | 48h | Immediate alert → manual override |
| T2 | Structurally valid, agent-verified | 7 days | Alert within 24h, manual within 48h |
| T3 | Structurally valid | 30 days | Next cohort cycle |
| T4 | Any output | Best effort | Automated detection only |

### 7.3 Manual entry as a first-class workflow

For T1 banks, manual entry is a core operational capability, not an escape hatch. When the agent fails a T1 bank, the operator must have a frictionless path to enter rates directly from the bank's website.

The manual entry tool writes `_rates.json` with provenance fields:

```json
{
  "extraction_method": "manual",
  "manual_entry": {
    "entered_by": "operator",
    "entered_at": "2026-06-19T14:00Z",
    "source_url":  "https://sbi.co.in/...",
    "source_verified_at": "2026-06-19T14:00Z"
  }
}
```

**Manual override protection.** A manually entered file must not be silently overwritten by the next agent run. When the agent runs a T1 bank with a manual entry, it compares output against the manual entry and auto-approves only if slab count and rates agree within tolerance. Divergence requires operator confirmation.

### 7.4 Quality gate — T1 completeness as a hard block

The pack quality gate must enforce T1 presence:

- `BLOCK` — any T1 bank absent from the pack
- `BLOCK` — any T1 bank with `structural_confidence: fail` AND no valid manual override
- `BLOCK` — any T1 bank's data older than 48h at pack-generation time
- `WARN` — equivalent conditions for T2
- T3/T4: current behaviour unchanged

### 7.5 Daily liveness check for T1

For T1 banks, waiting for the cohort run to discover a stale rate page is too slow. A lightweight daily check — HTTP HEAD to the known rate page URL, comparing `Last-Modified` / `ETag` — detects "bank silently updated its rate page" within 24h and triggers an out-of-cycle re-run rather than waiting for the next cohort. Cost: ~35 HTTP calls per day. High signal-to-noise for the most important banks.

### 7.6 Bank tier registry

Tier assignments live in `data/bank-domains.json` as a `tier` field per bank entry. All quality gate logic, alert routing, QA sample queue prioritisation, and manual entry tooling derive from this single source rather than maintaining separate hardcoded lists.

---

## Error Budget and Sampling

### At 1900 banks, "acceptable error rate" must be stated explicitly

| Error rate target | Banks with wrong rates | QA sample to detect at 95% confidence |
|---|---|---|
| 5% | ~95 | ~70 banks (random) |
| 2% | ~38 | ~200 banks |
| 1% | ~19 | ~450 banks |

Below 1% the sampling cost becomes prohibitive unless risk-stratified (focus on flagged banks rather than random draws). Practical operating model: automated detection + risk-stratified sampling targets 2% fleet-wide; T1 banks held to near-zero separately.

Two sampling roles with different purposes:
- **Risk-stratified sample** — drives corrections; selects banks the automated detectors flagged
- **Random spot-check sample** — measures the actual fleet error rate periodically; unbiased

---

## Axis 8 — Orchestration Architecture

### 8.1 Orchestration axes

Temporal ordering is one axis but not the most fundamental. Four axes together define where any given check belongs:

**Scope** — what does the check operate on?
- Per-slab (rate within plausible bounds?)
- Per-bank (slab count consistent with history?)
- Cross-bank / peer-group (outlier vs. category?)
- Fleet-wide (T1 completeness satisfied?)

Each scope level requires different data to be available. Per-slab runs during extraction. Fleet-wide only after all banks in a cohort are done. This creates a dependency graph, not just a timeline.

**Automation level** — how much human judgment is required?
- Fully deterministic (hard bounds — no model needed)
- Statistical / rule-based (z-scores, drift — no model needed)
- Reasoning-required (WAF decoy? warning text meaningful?) — model appropriate
- Ground truth only (is this rate actually correct?) — human required; model can assist

**Cost/speed** — fast-and-cheap vs. expensive-and-thorough
- Deterministic gates run on every bank every run
- Expensive LLM checks run only on escalation from cheaper checks
- Chain: deterministic → statistical → LLM judge → human. Each layer only fires when the previous layer raises a flag.

**Trigger** — what initiates the activity?
- Schedule-triggered (daily T1 liveness check)
- Event-triggered (run completes → post-run checks fire)
- Anomaly-triggered (structural check fails → escalate to judge)
- Human-triggered (QA engineer selects a bank for review)

Any given check has a position on all four axes. That combination determines exactly where it belongs and what invokes it — no ambiguity, no scattered logic.

### 8.2 Specialised agent network

One generalist agent doing discovery + extraction + confidence assessment + output formatting is asking too much. Specialisation decomposed into verifiable steps:

**Discovery agent** — finds the rate page, determines URL, classifies scraper type. Output: proposed config. Does not extract rates.

**Extraction agent** — receives page content, extracts rates. Does not judge whether the page is the right one. Focuses entirely on parsing.

**QA judge agent** — independently re-extracts rates from the same source without seeing the extraction agent's output first. Clean-room verification. Disagreement between extractor and judge is the trigger for human review. For T1 banks: runs on every run. For T2/T3: runs only on anomaly-triggered escalation.

**Triage agent** — given a failure or discrepancy, classifies the failure type and recommends corrective action. Handles routine cases automatically: "this is a `waf_block`, fix is switching to playwright" does not need a human decision.

**Anomaly analysis agent** — given a set of statistical anomaly signals, reasons about whether they collectively indicate a real error and what the probable cause is. Handles ambiguous cases rule-based detectors cannot.

**Context enrichment agent** — given a bank's run history and recent failures, suggests updates to `known_issues`, `waf_profile`, `fallback_methods`. Runs after a failure is resolved to encode the fix into config automatically.

**Prompt improvement agent** — given a cross-tab of QA findings by `discrepancy_type × bank_type × scraper_type`, analyses current prompt fragments and suggests targeted improvements. Runs periodically (per sprint or when a new error pattern reaches threshold count), not per-bank.

**Report / digest agent** — synthesises run logs, QA findings, and anomaly signals into a human-readable cohort summary for the operator, and a sprint-planning digest for the planner.

### 8.3 Agent network topology

The agents form an event-driven network, not a linear pipeline:

```
Daily liveness check ──→ [T1 page changed] ──→ Extraction agent
                                                      │
Cohort run complete ─→ Post-run checks ──→ [anomaly] ─┤
                               │                      ↓
                               │               QA judge agent
                               │              ↙         ↘
                               │        [agree]       [disagree]
                               │           ↓               ↓
                               │    auto-resolve    Human QA queue
                               │                        ↓
                               │              Context enrichment agent
                               ↓                        ↓
                        Anomaly analysis ──→ [systemic] → Prompt improvement agent
                               ↓
                        Pack quality gate ──→ [T1 fail] → Alert + manual entry
```

Each node has a defined: input, output, model tier, and trigger condition.

### 8.4 Model selection — Azure OpenAI only

Infrastructure constraint: Azure-hosted models only (Microsoft credit does not cover third-party marketplace models including Claude). Three effective tiers:

- **GPT-4o** — capable generalist; good at extraction, instruction following, HTML/PDF reasoning. Main workhorse.
- **GPT-4o mini** — fast and cheap; right for classification, triage, summarisation — high-volume low-stakes tasks.
- **o-series (o3-mini / o1)** — reasoning-optimised; slower and more expensive; worth it only where multi-step analysis depth matters more than throughput.
- **Phi-4** — Microsoft-native small model; candidate for cheap pre-filtering if GPT-4o mini is overkill (evaluate on task first).

| Agent role | Model | Reasoning |
|---|---|---|
| Structural invariants | Pure code — no model | Deterministic; model adds no value |
| Triage / failure classification | GPT-4o mini | Simple classification; high volume, low stakes |
| Context enrichment | GPT-4o mini | Config suggestions; cheapness matters more than depth |
| Report / digest | GPT-4o mini | Summarisation |
| Extraction agent | GPT-4o | Main extraction task; needs HTML/PDF + instruction following |
| QA judge (T2/T3) | GPT-4o | Independent extraction — same capability as extractor |
| QA judge (T1) | GPT-4o | Still extraction, not reasoning; o-series adds cost not accuracy here |
| Anomaly analysis | GPT-4o | Pattern reasoning over structured data |
| Prompt improvement | o3-mini | Genuinely reasoning-heavy: cross-bank failure pattern analysis + prompt edits |

Note: as Azure OpenAI releases newer models (o4-mini, GPT-4.1 series, etc.), the tier mapping should be revisited. The principle stays: deterministic code > cheap model > capable model > reasoning model — escalate only when the task genuinely requires it.

### 8.5 Agent-assisted QA — closing the human-machine loop

The human QA engineer's manual workflow (select bank → visit website → read rates → compare → write notes) can be partially automated at each step:

**Pre-review brief** — before the engineer visits a bank, a brief agent produces a one-page context from the last 3 run log entries and QA history. Engineer arrives informed, not starting from scratch.

**Side-by-side extraction** — while the engineer reviews the website, a parallel agent independently extracts the current rates from the same page and presents them alongside stored output. The engineer validates the comparison rather than doing the extraction themselves. Review time drops from ~20 minutes to ~5 minutes.

**Finding suggestion** — on confirmed discrepancy, the agent suggests structured finding fields (type, severity, recommended action). Engineer approves or corrects — no schema knowledge required.

**Config update suggestion** — immediately after finding is recorded, the context enrichment agent proposes the config change. Engineer approves in one click. Loop from "found error" to "config updated" shrinks from days to minutes.

### 8.6 Data lineage

Every slab in the pack should be traceable to its origin without re-running the agent. A `lineage/` index alongside the pack maps `bank_code → run_id → run_log_entry`. The pack carries only a `run_id` per bank; full provenance (source URL, resolved URL, fetch timestamp, extraction method, manual entry if applicable) is one lookup away. Supports: consumer challenges ("your site shows X but bank's site shows Y"), rollback to last-known-good, audit of what a pack contained at a given point in time.

### 8.7 The feedback loop — how fixes encode back to the agent

Each QA finding type has a defined encoding target:

| Finding type | Encoding target | Mechanism |
|---|---|---|
| `wrong_source_url` | `_config.json` rate_page_urls | Config update → re-run |
| `missing_tenures` (layout) | `docs/agent/field-learnings.md` | Prompt update → regression test |
| `wrong_product` (FD vs savings) | `docs/agent/discovery-workflow.md` | Prompt update → regression test |
| `waf_block` / `decoy` | `_config.json` waf_profile + fallback_methods | Config update; profile inheritance if cross-bank |
| `stale_data` | `_config.json` rate_page_stability: volatile | Config update → more frequent re-run |
| `wrong_classification` | `data/bank-domains.json` bank_type | Registry update |
| Systemic (N banks same type) | Prompt fragment | Prompt improvement agent cycle |

The QA finding tool prompts the operator for the encoding action at finding-close time. The finding-to-fix mapping accumulates over time, showing which error types recur despite fixes — those are sprint backlog items.

---

## Axis 9 — Action Granularity

### 9.1 What the current orchestrator gets right

The top-level action sequence in `lib/orchestrator.js` is already well-decomposed: `find_website`, `find_rate_page`, `fetch_page`, `classify_rate_page`, `commit_*` are each single-concern steps with clean inputs and structured phase events. The tier router (`selectDiscoveryAction`, `checkQuality`) does deterministic work correctly in code, with no LLM involvement. These do not need restructuring.

### 9.2 Where granularity breaks down

**`extract_html_table` — one action, four distinct jobs**

The action receives full page HTML and simultaneously: (a) identifies which table among many contains FD rates, (b) maps column headers to semantic roles, (c) extracts each row as a structured slab, (d) assesses confidence. These are cognitively distinct tasks that fail independently and require different model capability. When they are bundled, a failure in step (a) silently corrupts (c) with no diagnostic signal.

Proposed decomposition:

```
identify_rate_table(page_html, bank_context)
  → { table_html, section_heading, product_type, confidence }
  Model: GPT-4o mini — routing decision, not extraction

map_table_schema(table_html, bank_context)
  → { columns: [{ index, role: "tenure|rate_regular|rate_senior|amount_min|..." }] }
  Model: GPT-4o mini — structural interpretation

extract_rate_rows(table_html, column_schema, variant)
  → { slabs: [...], warnings: [...] }
  Model: GPT-4o mini — structured extraction with schema handed in explicitly
```

With the column schema pre-mapped, `extract_rate_rows` receives a precise contract: "column 0 is tenure, column 1 is regular rate, column 2 is senior rate." A cheap model executes this reliably. The full model is no longer needed for routine HTML extraction.

**`extract_pdf_table` — same problem, worse because PDF text is noisier**

PDF text from layout extraction loses column alignment. The single LLM call must simultaneously denoise, segment by product section, identify the FD rate section, and extract rows.

Proposed decomposition:

```
segment_pdf_sections(raw_pdf_text)
  → { sections: [{ heading, text, page_number }] }
  Model: none — deterministic heading detection (capitalised lines + whitespace)

identify_rate_section(sections, bank_context)
  → { section, confidence }
  Model: GPT-4o mini — which section is FD rates?

parse_rate_rows(section_text, variant, expected_currencies?)
  → { slabs: [...], warnings: [...] }
  Model: GPT-4o — PDF text is noisier than HTML; full model appropriate here
```

`segment_pdf_sections` is pure deterministic code. The LLM only touches smaller, cleaner inputs.

**`classify_rate_page` — deterministic and LLM concerns mixed**

URL extension sniffing (`.pdf` → pdf kind) and HTTP content-type detection are deterministic. JS-render detection requires light reasoning. WAF signal detection is a heuristic. These have different reliability profiles but run as one unit.

Proposed decomposition:

```
sniff_content_type(url, response_headers)
  → { kind: "pdf|image|html" }
  Model: none — deterministic

detect_rendering_mode(html_body)
  → { mode: "static|js_rendered", confidence }
  Model: GPT-4o mini — lightweight reasoning or heuristic

detect_waf_signal(body, status, headers)
  → { waf: "none|block|decoy", signals: [...] }
  Model: none — heuristic pattern matching
```

Centralising WAF detection here (rather than scattered across `fetch_html` and `cloud-block/inspector`) lets the orchestrator make a routing decision before attempting extraction.

### 9.3 Updated model tier table (post-decomposition)

| Action | Model | Notes |
|---|---|---|
| `segment_pdf_sections` | None | Deterministic heading detection |
| `sniff_content_type` | None | URL + header rules |
| `detect_waf_signal` | None | Heuristic pattern matching |
| `identify_rate_table` | GPT-4o mini | Routing; cheap model sufficient |
| `map_table_schema` | GPT-4o mini | Structural interpretation |
| `detect_rendering_mode` | GPT-4o mini | Light reasoning |
| `identify_rate_section` | GPT-4o mini | Section classification |
| `extract_rate_rows` | GPT-4o mini | Schema-driven; cheap model with precise contract |
| `parse_rate_rows` | GPT-4o | PDF noise warrants full model |
| `find_rate_page` | GPT-4o | Multi-step navigation; unchanged |
| `find_website` | GPT-4o mini / GPT-4o | Tier-routed; unchanged |
| QA judge (T2/T3) | GPT-4o | Runs same sub-steps independently |
| QA judge (T1) | GPT-4o | Extraction task; o-series adds cost not accuracy |
| Prompt improvement | o3-mini | Reasoning-heavy; runs rarely |

The practical result: most banks go through extraction using only GPT-4o mini with structured outputs. GPT-4o is reserved for PDF parsing, ambiguous layouts, and WAF-protected sites.

### 9.4 I/O precision — from hint bags to typed contracts

The current `hints` object is an open bag passed across action boundaries:
`{ cached_domain?, cached_rate_pages?, prefer_llm?, cached_body?, expected_currencies?, bank_name?, bank_type?, scraper_notes?, expected_slab_count?, ... }`

Every action receives the full bundle whether it needs it or not. The model must infer which fields are relevant — which defeats the purpose of granularity.

Each decomposed action should have an explicit typed contract — exactly what it needs, nothing more:

```js
// extract_rate_rows — precise contract
{
  table_html: string,           // the specific table, not the full page
  column_schema: ColumnSchema,  // pre-mapped by map_table_schema
  variant: Variant,             // "regular"|"nre"|"nro"|"fcnr"|"gift"
  bank_type: BankType,          // for senior-citizen premium expectation
  expected_currencies?: string[] // only for fcnr/gift
}
```

**Azure OpenAI structured outputs enforce the output side.** Using `response_format: { type: "json_schema", json_schema: ... }`, the API guarantees the model returns a valid instance of the declared schema — no `JSON.parse` inside try/catch, no model-invented fields. Schema validation moves from defensive post-processing to a guaranteed API contract.

---

## Axis 10 — Context Propagation

### 10.1 The core tension

More granular actions → smaller per-action context → smaller prompts → more reliable models. But actions are part of a pipeline: each needs *some* context from previous steps, and from the bank's accumulated profile. The wrong answers:

- **Global flat context, injected everywhere** — every action's prompt grows with each prior step. By `extract_rate_rows`, the prompt carries full bank profile, discovery result, WAF assessment, fetch headers, prior run history — mostly irrelevant noise. The model spends attention budget deciding what to ignore.
- **Fully pruned per-action context** — `extract_rate_rows` gets only `table_html + column_schema`. Works until a known quirk matters — "this bank uses reversed column order" — which lives in the profile and is now invisible.
- **On-demand tool call for everything** — elegant but adds a latency round-trip per context pull, and requires the model to know what it doesn't know. An action that doesn't know about a reversed-column convention won't think to ask for `bank_profile`.

### 10.2 Three-layer context design

**Layer 1 — Declared context (always injected, always small)**

Each action statically declares the minimal sub-trees it unconditionally needs. These are assembled and injected automatically — no model decision required:

```js
const ACTION_CONTEXT_REQUIREMENTS = {
  identify_rate_table:   ['bank_identity', 'run_state'],
  map_table_schema:      ['bank_identity', 'run_state', 'extraction_hints'],
  extract_rate_rows:     ['bank_identity', 'run_state', 'extraction_hints'],
  identify_rate_section: ['bank_identity', 'run_state'],
  parse_rate_rows:       ['bank_identity', 'run_state', 'extraction_hints'],
  detect_waf_signal:     ['bank_profile.waf_profile'],
};
```

Small, deterministic, always correct. This is the floor — the context the action always has.

**Layer 2 — Manifest (available but not injected)**

Every action also receives a one-line summary of what *else* is available in the context, without receiving the content. The model reads the manifest and requests sub-trees only if the summary suggests relevance:

```
Available context (call get_context(name) if needed):
- bank_profile: "WAF: cloudflare, layout: html-table, 2 known issues"
- prior_run:    "2026-06-11: 9 slabs, html_static, high confidence"
- fetch_result: "1.2MB HTML, content-type text/html, no WAF signals"
- classification: "html_static, no JS rendering, no WAF decoy"
```

The manifest entry is a *summary of current content*, not the content itself. A model reading "2 known issues" before extracting a table may pull `bank_profile` to read them. If the table is straightforward it ignores the manifest entirely. The decision is informed but not forced.

Manifest summaries are generated deterministically from the current context state — no LLM involved:

```js
function summariseSubtree(name, data) {
  if (name === 'prior_run')
    return `${data.last_successful_at}: ${data.slab_counts.regular} slabs, ${data.method}, ${data.confidence}`;
  if (name === 'bank_profile')
    return `WAF: ${data.waf_profile}, layout: ${data.page_layout}, ${data.known_issues.length} known issue(s)`;
  // ...
}
```

**Layer 3 — Content store (large artifacts, referenced by handle)**

HTML bodies, PDF text, fetched bytes never travel in the context object. They live in an in-memory content store keyed by a handle (`fetch_result.body_handle`). Only the action that needs raw content receives it directly as a parameter. The context carries the handle and a size/summary, not the bytes.

This keeps the context object semantically dense but physically small — it describes what happened, it does not carry what happened.

### 10.3 Context object structure

Owned by the orchestrator, read-only from each action's perspective, enriched after each step completes:

```
context/
  bank_identity/        bank_code, bank_name, bank_type, state, category
  bank_profile/         waf_profile, page_layout, known_issues[], fallback_methods, rate_page_stability, inherits_profile
  run_state/            product, variant, mode, attempt_number, tier
  prior_run/            last_successful_at, slab_counts{}, method, source_url_hash, confidence
  discovery_result/     website_url, confidence           ← written after find_website
  rate_page_result/     url, redirect_chain               ← written after find_rate_page
  fetch_result/         status, content_type, body_handle, body_size_bytes, waf_signals_summary
  classification/       kind, rendering_mode, waf_verdict ← written after classify steps
  extraction_hints/     expected_slab_count, expected_currencies[], column_hints
```

The orchestrator owns all writes. An action returns its output; the orchestrator updates the relevant sub-tree before invoking the next action. No action writes directly.

### 10.4 What NOT to put in the context

- Raw HTML bodies, PDF text, fetched bytes — use the content store
- Computed values internal to one action's logic
- The full list of all banks in the cohort — not relevant per-bank
- Pack-level data — lives at a different scope entirely

The context holds *facts about this bank and this run*. It does not hold processing artifacts.

### 10.5 The QA judge and context

The QA judge is an independent agent that must not see the extraction agent's output before forming its own. It receives:
- **Declared context**: `bank_identity`, `run_state`, `extraction_hints` — same as the extractor
- **Manifest**: same manifest, so it has access to `bank_profile` if it needs known quirks
- **Content**: the same source HTML/PDF body handle — different agent, same source

The judge's output is compared to the extractor's output by the orchestrator — not by either agent. The judge never sees the extractor's slabs; the extractor never sees the judge's. Clean-room independence is enforced at the orchestrator level by withholding each agent's result from the other.

---

## Open Questions

1. Where do run logs, diff logs, and QA reviews live — alongside `output/latest/<bank>/` or in a separate `output/history/` tree? The `latest/` convention implies current state only; history needs a different home.
2. What is the RBI repo rate feed? Static config updated manually per MPC announcement, or an automated feed?
3. Who owns QA finding creation and manual data entry — dedicated QA role, or any team member? Affects tooling UX.
4. Should `structural_confidence: fail` block the pack quality gate for T2/T3, or only trigger a warning?
5. What is the retention policy for run logs and diff logs? Full history for T1; pruned for T4?
6. UNVERIFIABLE state: what is the acceptable gap threshold before PM approval is needed to exclude a bank?
7. Profile inheritance: flat override semantics (local wins) or merge semantics (local extends)? Flat is simpler; merge is more useful for `known_issues[]`.
8. Daily liveness check for T1: pull-based (scheduled job) or push-based (webhook if the bank supports it)?
9. Context manifest pull-through: how many round-trips per action is acceptable? Cap at 1 or 2 to bound latency.
10. Decomposed actions increase the number of LLM calls per bank. What is the acceptable call budget per bank per run, given Azure OpenAI rate limits and cost?

---

## Appendix — Deferred Threads

These topics were raised during design but require dedicated sprint time to do justice. Captured here for resumption.

### A. Prompt Regression Test Corpus — Management Over Time

The regression test corpus (30–50 banks with human-verified correct outputs) grows naturally from QA findings. The management challenges:

- **Staleness** — a verified-correct bank from February may have repriced in May. The corpus entry becomes an incorrect baseline. Mitigation: track `source_page_hash` at verification time; flag corpus entries where the live page hash has changed, requiring re-verification before the entry can be used in regression tests.
- **Coverage completeness** — the corpus must cover every `bank_type × scraper_type × page_layout` combination to catch category-specific regressions. Track which cells of this matrix are covered and which are empty; prioritise QA sampling to fill gaps.
- **Tolerance calibration** — "rates within 5 bps" is a starting heuristic. Measure actual rate-change granularity across the fleet (most banks move in 25 bps increments) to tighten or loosen this threshold empirically.
- **Corpus retirement** — entries more than 6 months old without re-verification should be flagged as uncertain; entries for banks that changed `scraper_type` since verification should be retired.

### B. Cold-Start / Baseline Bootstrapping

The run log, diff log, and statistical detectors are only useful after a bank has multiple runs. For a bank being discovered for the first time — or returning after a long dormancy — there is no baseline.

Explicit cold-start states:
- **First run** — write run log entry, set `baseline_established: false`, skip statistical anomaly checks, apply only hard structural invariants. Carry `baseline_established: false` in the pack for that bank.
- **Establishing** (runs 2–N, N=3 recommended) — compute first diffs, build initial slab-count baseline. Enable slab-count regression check but with wider threshold (50% vs. 30%).
- **Established** (after N successful runs) — full anomaly detection enabled. Narrow slab-count regression threshold to 30%.

Dormancy re-entry: a bank not run in 6+ months should re-enter `establishing` state rather than triggering false anomaly alerts against a stale baseline on the first re-run.

### C. Multi-Language Extraction

Several bank categories publish rate pages primarily or exclusively in regional languages:
- Co-operative banks (Maharashtra, Gujarat, Karnataka) — Marathi, Gujarati, Kannada
- DCCBs — frequently Hindi-only
- PSBs — regional-language communications often published before English versions

The current extraction treats all page text uniformly. For banks where rate table *headings* are in regional script, the agent may misidentify columns — `"1 वर्ष"` (1 year in Hindi) may not map to a tenure label — producing `missing_tenures` findings that look like layout issues but are language issues.

Design direction:
- Add `rate_page_language` to the bank profile (`hi`, `mr`, `gu`, `kn`, `en`).
- Include language-aware extraction heuristics in `docs/agent/field-learnings.md` for each supported language.
- Classify `discrepancy_type: language_extraction_failure` in QA findings to surface the pattern across banks.
- A single `field-learnings.md` update covering Hindi tenure labels would fix ~50+ co-op and DCCB banks simultaneously.

### D. Error Budget Operationalisation

The 2% fleet-wide error rate target (§Error Budget and Sampling) needs to be connected to concrete operational cadence:

- **Measurement cadence** — random spot-check sample of ~200 banks per quarter gives a statistically valid estimate of whether the 2% target is being met (95% confidence). Schedule this as a quarterly QA sprint activity, distinct from the ongoing risk-stratified sampling.
- **Target breach response** — if the random sample estimates error rate >2%, trigger: (a) immediate expansion of the risk-stratified queue, (b) cross-tab analysis to find the failure pattern, (c) sprint backlog item for the root cause. Define this escalation path explicitly so it is not ad hoc.
- **Per-tier targets** — T1: near-zero (< 0.5%, manual fallback covers the gap). T2: < 2%. T3/T4: < 10% (automated detection only, best effort). These should be stated in the product commitment document alongside coverage numbers.
- **Reporting** — the cohort summary digest (from the report agent) should include the current estimated error rate from the last random sample, not just pass/fail counts. This keeps the error budget visible to the sprint planner without requiring a separate report.
