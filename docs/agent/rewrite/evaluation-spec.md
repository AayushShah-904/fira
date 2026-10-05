# Evaluation Specification — Rate Discovery Agent (v2, clean-slate)

> Status: **Proposal / not yet implemented.** Defines how we decide the agent's output is *correct*.
> Companion docs: [`functional-spec.md`](./functional-spec.md), [`design.md`](./design.md),
> [`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md).

> **Instrument-agnostic by design.** The evaluation *framework* below — snapshot-first substrate, the
> six layers, the human-adjudication rule, confidence tiers, and signed-accept governance — is
> generic and reused by every future `instrument_type`. Only the **concrete checks** in Layers 2–3
> (and the observation schema in Layer 1) are instrument-specific; for v2 they are the **deposit**
> checks described here. Bonds would register their own checks (rating-band, yield-curve, credit
> spread) against the same framework. See
> [`vision-coverage-extensibility.md`](./vision-coverage-extensibility.md).

## 1. Why evaluation is a first-class concern

The v1 system shipped data that *looked* right but was wrong: senior/general column swaps, a loan or
savings table mislabelled as FD, FCNR currency sections collapsed to USD, truncated rate ladders,
bulk-tier columns picked over retail, and a foreign bank's home-currency rates shipped as INR. **These
all pass naive bounds-and-baseline gates because the numbers are individually plausible.** The
operator's standing concern — *"I don't have full faith in the extraction"* — is precisely about this
class of error.

Therefore, in v2, evaluation is designed *with* the extractor, not bolted on. Two structural
consequences:

1. **Snapshot-first.** Every extraction reads from, and references, an immutable snapshot of the
   source bytes. Evaluation never re-fetches live sites (which drift); it re-reads snapshots. This
   makes every result independently and reproducibly re-checkable.
2. **Layered defence.** No single check is trusted to catch everything. Six layers run from cheap
   per-slab validity up to a statistically-measured error rate, and a human adjudicates the
   ambiguous residue.

### Definition of correctness
> A shipped slab is **correct** if it traces to a real source, as captured in its referenced
> snapshot, and faithfully represents that source: right product (FD, not loan/savings), right
> variant, right currency, right tenure band, right tier, and rate values matching the source within
> rounding.

A dataset is **releasable** when its measured error rate is within target with a stated confidence
interval, no un-accepted blocking findings remain, and every accepted exception is operator-signed.

## 2. The evaluation substrate: snapshots

A content-addressed snapshot store is a **precondition**, not an add-on:
- Captured **at fetch time** (Tier-1 and Tier-2), keyed by SHA-256 of the raw bytes; blobs dedup by
  content. Each entry records HTTP status, ETag, Last-Modified, fetch method, timestamp.
- Layout: `blobs/<aa>/<sha256>.<ext>` (raw bytes) · `index/<bank>__<variant>.json` (append-only
  manifest, newest last) · `_index.json` (roll-up for enumeration).
- Every `_rates.json` carries `snapshot_ref` (§ functional 6.2). An extraction with non-empty slabs
  and no resolvable snapshot is itself an evaluation failure (anti-fabrication).

## 3. Layered evaluation model

### Layer 1 — Per-slab validity (deterministic, runs on every write)
- **Schema conformance** — exact strict field names; numeric `rate_*_pct`; `tenure_min_days ≤
  tenure_max_days`; `variant` matches filename; `currency` present iff fcnr/gift.
- **Rate bounds** — INR slabs in `[0.1%, 15.0%]`; foreign (fcnr/gift) in a foreign band
  `[0.0%, 12.0%]`. Out-of-band slabs are dropped at pack build and flagged.
- **Tenure sanity** — parseable tenure; ordering consistent; no duplicate identical slabs.
- **Anti-fabrication / traceability** — every slab resolves to a referenced snapshot; strict mode in
  the automated pipeline asserts this.

### Layer 2 — Structural / semantic checks (catch plausible-but-wrong)
Pure functions over a variant's slab set (carried from `lib/checks/structural-checks.js`, thresholds
preserved and calibrated):

| Check | What it catches | Signal & threshold |
|---|---|---|
| **classifyTableType** | Loan/savings table shipped as FD | Header regex (LOAN/SAVINGS vs FD) is authoritative; intrinsic signal needs both a short (≤90d) and long (≥365d) band when ≥60% of slabs parse → `wrong_table_suspected` (ANOMALY) |
| **ladderPlausibility** | Truncated ladder (dropped rungs) | Per-type floor (PSB/PVB 6; SFB/PB/FB 3–5; IBU 2; default 4); BLOCK if slabs < floor **and** no ≥365d band; **skips when no parsed tenure** (avoids the single-headline-rate false positive) → `truncated_ladder` (ANOMALY) |
| **seniorPremiumPeerOutlier** | Senior/general column swap | Needs ≥8 peer banks with median premium ≥0.25pp; fires when this bank's median ≤0 while peers' >0.25pp → `senior_premium_peer_outlier` (WARN) |
| **fcnrCurrencySanity** | Collapsed currency sections / INR-as-FCNR | Known-currency set; duplicate (tenure+amount) with differing rates ⇒ collapse; single currency across ≥10 slabs with ≥3 sub-365d ⇒ mislabelled domestic → `fcnr_currency_anomaly` (WARN). Dedup key = deposit_range + tenure_text; gift-scoped (calibration cut 276 false-pos → ~37 real) |

### Layer 3 — Multi-reference rate-reasonableness (carried from `rate-reasonableness.js`)
For the regular variant, on canonical buckets `1y [365,365]`, `2-3y [730,1095]`, `5y [1825,1825]`,
compare each retail rate against three independent anchors:
- **Peer** — bank_type×bucket median; fires on >200 bps deviation **or** outside the p25±1.5×IQR
  fence → `rate_deviation_peer` (WARN).
- **Repo** — RBI repo band ± per-bank_type spreads; active **only** when `macro.approved_by` is set
  (operator-approved metadata, ADR-017) → `rate_deviation_repo` (WARN).
- **History** — vs nearest of last N pack rates; fires on >150 bps jump → `rate_deviation_historical`
  (WARN).

**Aggregation:** 1 anchor fired = WARN; **≥2 fired = blocking ANOMALY.** Bulk tiers (`above_*`,
`*_to_*cr`) are excluded from peer comparison so co-op bulk rates don't corrupt the anchor.

### Layer 4 — Independent cross-check (second read)
Re-extract every snapshot with an independent LLM read using a **shared** extraction prompt
(`lib/llm/reextract-prompt.js`, no fork with the primary extractor), then diff against the shipped
slabs (`diffSlabs`). Agreement classes: **FULL** (no added/removed/changed) · **PARTIAL** · **DISAGREE**
· **LLM_NO_DATA**. This is a *measurement* feeding the confidence score (§5), not a hard gate — but
DISAGREE/PARTIAL on a verified-tier bank is a release blocker until reviewed.

### Layer 5 — Sampling audit (the measured number, hybrid)
Produces the single headline metric: **measured extraction error rate with a 95% confidence
interval.**
- **Stratified sampling** by `(bank_type × extraction_class)` where class ∈ {template, tier2, static};
  seeded Fisher–Yates (reproducible). Focus on key tenures `[365, 730, 1095, 1825]` plus a random
  top-up (≤6 slabs/bank).
- **LLM judge** reads the *snapshot* (not live site) plus the expected slab set; per-slab verdict
  `CONFIRM` / `CONTRADICT` / `NOT_FOUND`. The judge prompt **must** include `deposit_amount_tier` and
  `currency` (the v1 fix that cut tier-mismatch false positives).
- **Wilson score interval** (z=1.96) per stratum → error rate + [lo, hi]; aggregate weighted.
- `NOT_FOUND` is reported as a **coverage-gap** signal (snapshot/judge couldn't locate; often
  JS-scaffold/post-hoc pages), distinct from a confirmed error.

### Layer 6 — Golden regression suite
Frozen `snapshot → expected` fixtures guard against regressions:
- Fixture = `<bank>.html` (or PDF) from a snapshot + `<bank>.expected.json` slabs + `.expected.meta`
  (bank_type/category). Tests run the *registry-resolved* real extractor + column_map.
- A golden is **activated** only when (1) a registry template exists, (2) current extraction over the
  snapshot matches expected within tolerance (**slab count ±2; key rates 1y/2y/3y/5y ±5 bps**), and
  (3) no structural ANOMALY. Drifted/flagged banks are **skipped, never blindly rebaselined**;
  `--rebaseline` is operator-gated.

## 4. The human-in-the-loop rule (load-bearing)

**The LLM-as-judge over-flags ~7×.** In the v1 audit, of 15 CONTRADICTs only **1** was a real bug; 5
were correct multi-tier data the judge compared against the wrong tier, 7 were same-value noise, 1 was
a stale-refresh drift. **The raw audit percentage is therefore never taken at face value.**

Rules:
- Every `CONTRADICT` (Layer 5) and every `DISAGREE` (Layer 4) goes to a **human worklist** for
  adjudication before it counts as a confirmed error or blocks a release.
- The measured error rate has two figures: the *raw* judge rate and the *adjudicated* rate; the
  adjudicated rate is the one reported and gated on.
- Judge-prompt inputs that demonstrably reduce false positives (tier + currency context) are
  mandatory, not optional.

## 5. Confidence score & tiers (carried from `lib/confidence/score.js`)

Each variant gets a 0–100 score from these signals (absence = unknown, small penalty):

| Signal | Effect |
|---|---|
| Structural anomaly (Layer 2/3) | −40 each |
| Structural warning | −10 each |
| Cross-check (Layer 4): PARTIAL / DISAGREE / NO_DATA / SKIPPED / absent | −10 / −35 / −20 / −5 / −5 |
| Extraction method = static (no auto-refresh template) | −10 |
| Stale (effective_date > 18 months) | −15 |
| Measured method error rate (Layer 5) | −50 × error_rate (half-weight) |

Start 100, apply, clamp `[0,100]`, round. **Tiers:**
- **verified** — no structural anomaly, not stale, cross-check FULL (or cross-check absent **and**
  measured method error < 10%), score ≥ 70.
- **needs_review** — everything else.

Emitted as `output/latest/_confidence/<bank>__<variant>.json` sidecars; opt-in embedding into the pack
(`confidence_score` / `confidence_tier` / `confidence_signals`) behind a flag, since it's a consumer
contract change. **Best practice:** run cross-check (Layer 4) *before* building confidence so
`verified` is backed by a real second read, not just clean structure + low measured error.

## 6. Release gate

The gate runs at pack build and decides BLOCK vs PASS:

- **Delta classification vs the last pack** (per variant): REGRESSION ≤ −20% · WARN (−20%, −5%) ·
  STABLE ±5% · GAIN ≤ +200% · ANOMALY_GAIN ≥ +500%. (A bank dropping to 0 slabs that loses no real
  data is INFO, not a blocking regression.)
- **Structural/reasonableness findings** from Layers 2–3 (ANOMALY = blocking).
- **Verdict:** **BLOCK** if any un-accepted REGRESSION or ANOMALY exists; **PASS_WITH_WARNINGS** if
  only warnings; **PASS** if all clean/accepted.

### Signed accepts (operator-only, agent-immune — hard requirement)
An exception is cleared only by an **operator-signed accept**: HMAC-SHA256 over the canonical finding
hash using a key at `~/.rate-discovery/operator.key` (env-overridable). The system is **fail-closed**
(missing key ⇒ all accepts rejected) and the **agent can never produce a valid accept**. This is a
non-negotiable control: in v1, 48 fabricated `approved_by` entries once flipped a BLOCK to PASS and the
operator caught it. *No code path — including any LLM agent — may write or approve an accept on the
operator's behalf.*

### Macro-rate governance
The repo-rate anchor (Layer 3) uses operator-approved metadata only: propose via
`scripts/macro/propose-repo-rate.js` → operator approves via `bin/approve-macro-rate.js` (requires the
operator key); the repo anchor is inert until `approved_by` is set. The agent never sets `approved_by`.

## 7. Metrics reported every cycle

1. **Coverage** — banks with rate data / total; % auto-refresh (template-backed).
2. **Measured error rate** — adjudicated, with Wilson 95% CI; raw judge rate alongside.
3. **Confidence mix** — % verified vs needs_review variants.
4. **Blocking findings** — count by type (truncated_ladder, wrong_table, fcnr_*, rate_deviation_*).
5. **Cross-check agreement** — FULL/PARTIAL/DISAGREE/NO_DATA distribution.
6. **Coverage gap** — `NOT_FOUND` rate and discovery-status breakdown of the no-data tail.

## 8. Acceptance criteria for the v2 rewrite

The rewrite is accepted when:
- **Snapshot capture rate ≥ 95%** of successful fetches (so almost everything is re-checkable).
- **Adjudicated error rate ≤ 2%** on the stratified audit (v1's first measured raw figure was 5.3%
  raw / ~0.7% adjudicated; v2 targets ≤2% adjudicated with the layered defence catching the
  systematic classes before ship).
- **Zero fabrication**: no shipped slab without a resolvable snapshot ref; audited and enforced.
- **Golden coverage** of the high-volume template families (the `.bank.in` co-op family and the
  PSB/PVB templates) with green regression tests.
- **Gate integrity**: 100% of accepted exceptions are operator-signed; no agent-writable accept path
  exists (verified by test).
