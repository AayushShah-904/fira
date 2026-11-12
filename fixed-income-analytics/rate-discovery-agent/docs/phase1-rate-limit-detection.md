# Phase 1: Rate Limit Detection & Backoff — Implementation Notes

**Date:** 2026-03-28
**Status:** Complete
**File modified:** `rate-discovery-agent/run-batch.js`

## Problem

The foreign bank batch had 91% failure rate (40/44 banks). All failures were API rate limits ("You've hit your limit · resets 1:30am"), but `run-batch.js` classified them as generic `"failed"` — indistinguishable from genuine failures. The batch runner had no backoff logic, so it burned through all 44 banks in seconds, each instantly failing. The `--resume` flag couldn't distinguish rate-limited banks from failed ones, so re-running would either skip them all (if output existed) or retry them all (hitting limits again).

## Changes Made

### 1. Rate-Limit Detection Function (`detectRateLimit`)

Added after the CSV parsing section (~line 136). Scans log file contents for user-facing rate-limit messages:

- `"You've hit your limit"` (Claude CLI message)
- `"too many requests"` (generic HTTP)
- `"HTTP 429"` (status code)

**Important design decision:** Only checks the first 2KB and last 2KB of large log files (>5KB). This avoids false positives from internal Claude API telemetry events like `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",...}}` that appear in the middle of successful 245KB log files (observed in `axis_bank_limited.log`). Genuine rate-limit failures produce tiny logs (<500 bytes) where the error message is in the first few lines.

Also extracts the API reset time when available (regex: `resets? <time>`), e.g., "1:30am (Asia/Calcutta)".

### 2. Four-Way Status Classification

Previously: `success | failed | timeout`
Now: `success | failed | timeout | rate_limited`

After each `spawnSync` returns, the batch runner reads the bank's `.log` file (already written by `run-discovery.js`) and runs `detectRateLimit()` on it. Rate-limit detection takes priority over exit code — a bank that exited with code 1 but whose log contains a rate-limit message is classified as `rate_limited`, not `failed`.

Each result now includes `elapsed_sec` for timing analysis. Rate-limited results additionally include `rate_limit_message` and `reset_time`.

### 3. Consecutive Rate-Limit Backoff

Tracks `consecutiveRateLimits` counter that increments on each rate-limited bank and resets to 0 on any non-rate-limited result (success, failure, or timeout). Backoff escalation:

| Consecutive hits | Action |
|---|---|
| 1 | Warning logged, delay increased from default to 60s |
| 2 | 5-minute pause (blocks via `Atomics.wait`), then resumes |
| 3+ | Batch aborts with clear message showing reset time |

On any non-rate-limited result, delay resets to the original value (from `--delay` flag or default 2s).

### 4. Smart `--resume` with Previous Results

The `--resume` flag now loads the previous `_batch_results_<category>.json` file and uses it for intelligent skip/retry decisions:

| Previous status | `--resume` behavior | `--resume --retry-failed` |
|---|---|---|
| `success` (+ config exists) | Skip | Skip |
| `rate_limited` | **Retry** (always — transient) | Retry |
| `failed` | Skip (with hint message) | **Retry** |
| `skipped` | Re-evaluate | Re-evaluate |
| No previous record, config exists | Skip (legacy compat) | Skip |
| No previous record, no config | Process normally | Process normally |

### 5. New `--retry-failed` Flag

Opt-in flag that, combined with `--resume`, also retries banks that previously had `status: "failed"`. Without this flag, failed banks are skipped with a message: `"SKIP <bank> (failed previously, use --retry-failed)"`.

### 6. Expanded Batch Results Schema

Before:
```json
{ "name": "Bank X", "status": "failed", "exitCode": 1 }
```

After:
```json
{ "name": "Bank X", "status": "rate_limited", "rate_limit_message": "You've hit your limit", "reset_time": "1:30am (Asia/Calcutta)", "elapsed_sec": 5 }
```

Top-level summary also includes `rate_limited` count:
```json
{ "succeeded": 4, "failed": 0, "rate_limited": 17, "skipped": 23, "results": [...] }
```

## Testing

Validated against 105 existing log files:
- 17 correctly identified as rate-limited (all "You've hit your limit" with reset times)
- 0 false positives (the `axis_bank_limited.log` false positive from internal `rate_limit_event` telemetry was eliminated by the head+tail sampling approach)
- Syntax check passed (`node -c run-batch.js`)
- Usage output shows new flags correctly
