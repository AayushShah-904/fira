# ADR-017: RBI repo rate is operator-approved macro metadata

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | The macro anchor (RBI repo rate + per-bank_type FD spreads) used by the Phase-7 rate-reasonableness detector lives in `data/macro-rates.json` as **operator-approved metadata**. The agent may *propose* a value (from RBI-site / tier-2 research) into `data/macro-rates.proposed.json`, but never self-approves; the repo anchor is inactive until an operator promotes + stamps `approved_by`. |
| Decided by | Samir Joshi (2026-05-28) |
| Sprint | 008 (Phase 7) |
| Related | ADR-016 (confidence), `feedback_no_fake_approvals`, Phase-3 structural checks |

## Context

Phase 7 flags rates that deviate from (peer median, **RBI repo rate**, bank history). The repo rate is a macro fact that (a) changes with RBI monetary policy, (b) is not in the codebase, and (c) directly gates whether a bank's rate is judged "implausible". A wrong or stale repo value would mis-flag (or mis-pass) real data. Per the project's hard rule that the agent must not fabricate or self-approve sign-off data (`feedback_no_fake_approvals` — the 2026-05-23 fabricated-accepts incident), the macro anchor must be operator-controlled, not agent-asserted.

## Decision

`data/macro-rates.json`:
```json
{ "repo_rate": 6.5, "effective_date": "YYYY-MM-DD", "source_url": "https://rbi.org.in/...",
  "approved_by": "<operator>", "approved_at": "<iso>",
  "spreads_by_bank_type": { "PSB": {"low":1.0,"high":1.0}, "SFB": {"low":0.5,"high":2.5},
    "FB": {"low":2.0,"high":2.0}, "default": {"low":2.0,"high":2.0} } }
```
- A skeleton ships with `repo_rate:null`, `approved_by:null` → the detector treats the repo anchor as **inactive** (emits an INFO note; peer + historical anchors still run). No silent default.
- `scripts/macro/propose-repo-rate.js --repo <r> --effective <d> --source <url>` writes ONLY `data/macro-rates.proposed.json`. The numeric value is supplied by research (RBI site or a tier-2 agent), recorded — not invented by the script. It refuses to write the approved file or set `approved_by`.
- `bin/approve-macro-rate.js` (operator-run) promotes `.proposed.json` → `macro-rates.json`, stamping `approved_by` (from the operator identity / `~/.rate-discovery/operator.key` owner) + `approved_at`. This is the only path that activates the repo anchor.

### Why a band per bank_type, not a single number
FD rates sit at different offsets from repo by lender class (PSBs near repo, SFBs well above). A single global band would mis-flag whole categories. The spreads map encodes `[repo - low, repo + high]` per `bank_type` (with a `default`).

## Consequences

**Positive.** The macro anchor is auditable (dated, sourced, approved) and impossible for the agent to fabricate. Stale-repo risk is visible (the `effective_date` ages like any rate). The detector degrades gracefully (peer+historical) until approved.

**Costs.** The operator must refresh + re-approve when RBI moves the repo rate (a few times/year). The propose→approve step adds a manual hop — intentional, matching the signed-accept discipline.

**Neutral.** The repo anchor is one of three; even inactive, the detector remains useful via peer-median + historical agreement.

## Verification
`scripts/macro/propose-repo-rate.js` asserts it never touches the approved file. With `approved_by:null`, the gate reports the repo anchor INFO-inactive and does not flag on it. After approval, a planted 2.0% 1y PSB fixture fires repo+peer → ANOMALY. See `tests/checks/rate-reasonableness.test.js`.
