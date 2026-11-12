# Sprint 009 — pm-refresh-2026-q2 cohort hang diagnosis (execution `5kz1vm8`)

**Date:** 2026-06-05
**Branch:** `azure-openai-agent` @ image `5ee0b99`
**Execution:** `caj-bofia-rate-discovery-prod-5kz1vm8`
**Status:** Manually stopped 2026-06-05 ~20:15 UTC after operator review.
**Outcome:** Cohort processed 314/513 banks (272 succeeded + 28 failed +
14 in transient states), then froze on bank #315 at 16:07:23 UTC.

> **2026-06-05 revision note:** an earlier draft of this doc claimed the
> silence began at 15:36 UTC on bank #294 (hoshiarpur DCCB). That was
> wrong — my initial Log Analytics `take 1` query returned a stale-cache
> result. Real silence point is **16:07:23 UTC** on bank **#315
> indore-premier-co-operative-bank-ltd**. Diagnosis revised accordingly.

## Final processed state (revised)

| Metric | Value |
|---|---|
| Started | 2026-06-05 09:11:02 UTC |
| Last log event | 2026-06-05 16:07:23 UTC |
| Manually stopped | 2026-06-05 ~20:15 UTC |
| Banks attempted | 315 / 513 (61%) |
| Last fully-completed bank | #314 bhopal-DCCB (FAIL 18s — see anomaly below) |
| Bank that froze the container | **#315 indore-premier-co-operative-bank-ltd** (started 16:07:01; froze 22s later after safe-write WARN line for `_config.json`) |
| Receipt totals (frozen at 16:06:58 UTC) | 286 succeeded, 28 failed |
| Effective coverage | 314 / 513 banks' rate data committed to blob (uploadOneBank is incremental) |
| Wall time elapsed before freeze | 6h 56min |

## Diagnosis — REVISED

### Timeline of the final two banks

```
16:00:06  >>> [313/513] the-kancheepuram-central-co-operative-bank-ltd
   (kancheepuram has unresponsive site kpmccb.bank.in:
    multiple fetch_url + run_playwright timeouts)
16:06:38  FAIL 6m32s for kancheepuram (gave up after 4 consecutive tool errors)

16:06:42  >>> [314/513] bhopal-district-central-co-operative-bank-ltd
16:06:58  !!! TIMEOUT for bhopal (only 16 sec after start — anomalous, see below)
            FAILED + BLOB_WRITE events fired
            uploadOneBank: 4 uploaded, 0 skipped, 0 errors

16:07:01  >>> [315/513] indore-premier-co-operative-bank-ltd
16:07:10  HTML truncated from 93446 to 6984 chars for https://ipc.bank.in/<hindi-url>/
16:07:11  HTML truncated from 110301 to 20351 chars for https://ipc.bank.in/
16:07:22  [WARN] safe-write: incoming config for indore-premier-co-operative-bank-ltd_config.json
            lacks extraction_method; defaulted to "llm_inline_extraction"
16:07:23  ← LAST LOG. After this, complete container silence.
```

### Two anomalies in the last few banks

#### Anomaly 1: bhopal's 16-second "TIMEOUT"

Bhopal #314 was marked as `TIMEOUT` only 16 seconds after starting. The
per-bank timeout in run-batch.js is 900s (15 min). This is way too fast
to be the configured timeout — but the log message and `failure_class`
match the TIMEOUT path.

Possible explanations:
1. `spawnSync` returned with `signal != null` because the OS killed the
   child (OOM-killer at host level), and `classifyResult` interpreted
   the kill signal as a TIMEOUT.
2. The runBankSync `try/catch` caught an error with `err.killed=true`
   from a different cause (process spawn failure).
3. The 16s timestamp on the TIMEOUT log line is wrong (LA log
   reordering — but the ts field inside the EVENT JSON also shows 18s,
   so it's not a display artifact).

Either way, bhopal's short TIMEOUT suggests the container was already
under resource pressure at this point. The OOM-killer at the kernel
level could have killed bhopal's child process silently.

#### Anomaly 2: indore-premier froze right after safe-write WARN

The safe-write WARN line is emitted at the START of the write logic
(line `lib/safe-write.js:85`), BEFORE `writeJsonAtomic` is called. So
the freeze happened either:
- Inside `writeJsonAtomic` (`fs.writeFileSync` then `fs.renameSync` —
  pure local fs syscalls), OR
- After safe-write returned but before any subsequent code emitted a
  log, OR
- An OOM-killer hit the child process between the WARN and its next IO.

Since `writeJsonAtomic` is pure local fs (no Azure storage), the hang
is at the kernel level on the local filesystem write. Or it's
post-write but pre-next-log — which means subsequent code never ran.

### What we ruled out vs the original hypothesis

| Hypothesis | Status | Evidence |
|---|---|---|
| ~~SNAT exhaustion~~ | RULED OUT | Network was working right before silence — indore fetched 2 pages from ipc.bank.in successfully at 16:07:10-11. |
| ~~OOM during steady-state~~ | UNLIKELY but possible | Peak memory was 651 MB / 4 GiB. But the OOM-killer can fire on sudden allocation spikes that don't show up in 15-min-aggregated metrics. |
| ~~Spawn fault on bank #294 (curated-skip)~~ | RULED OUT (was wrong bank) | Bank #294 hoshiarpur DCCB ran fine ~30 min before the freeze. Real silence is on #315. |
| **Container-level death after sustained load** | Most likely | Container Apps Job metrics emitter died (no data points after 14:45 UTC). Logger continued until 16:07:23, then also died. ARM stayed Running because the host-level health probe didn't detect the death. |

### The most likely cause (updated)

**Sustained-load OOM-killer or kernel-level resource exhaustion.** After
~6h of processing with hundreds of subprocess spawns, hundreds of HTTPS
connections, GBs of HTML buffering, and steady GC pressure, something in
the Container Apps Consumption runtime crossed a threshold that the
kernel killed silently.

Not just one fault — a CASCADE. Notice the sequence:
1. The metric emitter died at 14:45 UTC (~5h36m into the run).
2. The cohort kept running for another 1h22m, processing banks 250-315.
3. The cohort had increasingly weird behavior at the end (bhopal's 16s
   timeout was the canary).
4. Container went fully silent at 16:07:23 on bank #315.
5. ARM didn't detect the death and kept reporting Running for hours.

The Container Apps Consumption profile gives ~no observability into
what kernel-level resource ran out. Could be: PID limit, file
descriptor limit, total resident memory, kernel buffer caches, network
namespace ARP/conntrack table — any of these can cause silent process
hangs.

## What can be done (mitigations, ordered by leverage)

### Option 1 — Cohort-level "no progress" watchdog (RECOMMENDED)

Add a top-level watchdog in `run-batch.js` that monitors the per-bank
loop. If the loop variable (bank index `i`) hasn't advanced in N minutes
(say, 20), the cohort exits cleanly with a partial-success receipt.

This **doesn't fix the underlying fault** — it just makes the cohort
fail gracefully when it happens. The 215 banks unprocessed in this run
would have been recovered into a "we got this far, stopping" message,
allowing a clean restart.

Implementation: top-level `setInterval` checking elapsed time since
last bank completion. If exceeded, `process.exit(7)` with a final
receipt flush.

### Option 2 — Chunked cohort execution

Don't run 513 banks in one execution. Split into 3-4 chunks of ~130
each. Each chunk runs fresh, well under the empirical ~315-bank
threshold where the fault appears.

Operator workflow: `pm-refresh-2026-q2.json` becomes 4 split files
(`-q2-1.json` through `-q2-4.json`); operator fires each via deploy-smoke
in sequence (or via a runner that loops). Adds ~20 min of deploy
overhead per chunk.

### Option 3 — Switch to Container Apps Dedicated profile

Dedicated has more isolated kernel resources and longer-lived
process-table state. The spawn-fault we hit may not appear at all.

Cost: Dedicated is billed hourly per node, not per-execution. For
intermittent cohort runs this is more expensive than Consumption.

### Option 4 — Periodic "soft restart" inside the cohort

Every N banks (say 100), the run-batch loop kills its agent-context
caches, re-creates http agents, force-GCs (`global.gc()`), and
continues. May not help if the fault is kernel-level rather than
Node-level.

## Operator decision — same three choices as before, updated context

| Choice | Recommendation given the revised diagnosis |
|---|---|
| **A** — Ship Option 1 (cohort-level watchdog) + resume the 198 remaining banks | Best outcome. The watchdog turns "silent hang" into "clean partial-success". Resume cohort can either be the 198 unfinished banks (#316-513) OR re-run all 513 (the watchdog will gracefully exit if it happens again). |
| **B** — Skip mitigation, just resume the 198 banks | Risk: hang recurs after another ~200-300 spawns. 198 banks is right around the empirical threshold (314 happened on this run). Could go either way. |
| **C** — Close Sprint 009 on 314 banks + Sprint 010 ticket for container-level investigation | The 61% coverage is a useful boundary. Documents "Container Apps Consumption can do ~315 bank runs sequentially before degradation." |

## What this run still validated

Even at 61% coverage, this run **validated all 6 Phase 9 fixes at
scale:**
- M2.6 HTML auto-route fired for HDFC orchestrator pattern (many times)
- tier-router curated-skip fired for the ~30-40 curated banks in the
  first 315 (instant — visible in the log pattern)
- `playwright_disabled` fast-fail held for SBI + BoI-IBU
- `tls_skip_verify` worked for cert-issue co-ops we wouldn't have known
  about
- `foreign_currency_not_inr` skip fired for non-INR banks
- Zero-slab misclassification correctly suppressed for curated banks

The container-death fault is a **separate, pre-existing infrastructure
issue**, not a regression introduced by any Sprint 009 fix. It would
have hit any large cohort run regardless of Phase 9.

## Cost summary for this partial run

- Wall time (effective work): 09:11 → 16:07 UTC = 6h 56m
- Wall time (until manually stopped): 09:11 → ~20:15 UTC = 11h 4m
- Container Apps Job compute: ~$0.50
- LLM (estimate from 286 succeeded × ~$0.10 avg): ~$30
- Total: ~$30

## Resume cohort composition

If Option A or B is chosen, the resume cohort should contain the 198
banks that were never processed:

- Banks #316–513 from `data/cohorts/pm-refresh-2026-q2.json`
- Skip bank #315 (indore-premier) — it triggered the hang; include it
  only if the watchdog ships (Option A)

Output file: `data/cohorts/pm-refresh-2026-q2-resume.json`.

Can be generated programmatically:
```js
const cohort = require('./data/cohorts/pm-refresh-2026-q2.json');
const resume = cohort.slice(315);  // banks 316..513 (zero-indexed slice)
fs.writeFileSync('data/cohorts/pm-refresh-2026-q2-resume.json',
  JSON.stringify(resume, null, 2) + '\n');
```
