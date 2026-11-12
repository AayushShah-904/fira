# Step 4 — Phase E pilot-50 migration runbook

**Sprint:** 006
**Step:** 4
**Status:** Runbook + helper CLI ship in this commit. **Migration itself is operator-driven** — `scripts/author-template.js --write` and `bin/approve-accept.js` refuse agent invocations by design (Sprint 5 Phase D2 refusal cascade). Operator runs each wave from a clean TTY.

## Context

Sprint 6 Steps 1-3 shipped the foundation:
- Hardened fetch layer (`lib/fetch/*`) with retry escalation + challenge detection
- Per-bank manifest + run-summary rollup
- Dispatcher fallback chain with 4 new template extractors + `_generic-html-3col` + `_llm-fallback`

Step 4 wires those into a per-wave migration flow. The pilot 50 composition is locked in `../plan/pilot-50-cohort-selection.md`:

| Wave | Banks | Cumulative |
|---|---:|---:|
| 1 | 5 co-op + 2 PSB + 2 PVB + 1 SSCB | 10 |
| 2 | +10 co-op + 5 PSB + 5 PVB | 30 |
| 3 | +3 PSB + 3 PVB + 8 FB + 4 RRB + 2 IBU | 50 |

Each wave is one commit. Operator runs the pack quality-gate after each wave and pauses if blocking findings appear.

## Per-bank migration steps (operator workflow)

For each bank in the wave:

```
# 1. Capture live HTML (if golden fixture not yet present)
RDA_AGENT_HARVEST_OK=1 node scripts/analysis/harvest-golden-html.js \
  --banks <bank-code> --force

# 2. Dry-run author-template against the captured HTML
node scripts/author-template.js <bank-code> --variant regular \
  --from-file tests/golden-html/<bank-code>.html

#    Inspects: fingerprint hash, cluster matches across existing templates,
#    suggested template_id, replay slabs + delta vs tmp/baseline-pre-reset/

# 3. If cluster match was acceptable, write the template block.
#    This is the step that requires TTY + non-agent shell.
node scripts/author-template.js <bank-code> --variant regular \
  --from-file tests/golden-html/<bank-code>.html \
  --reuse-template <template_id> --write

# 4. (Optional) Pre-emptively accept a controlled-cleanup finding
#    for banks like APSCB where the new extractor drops null-tenure
#    noise rows. The pack gate sees the accept as PASS-compatible.
node bin/approve-accept.js --bank <bank-code> --variant regular \
  --finding-hash sha256:<from-quality-report> \
  --reason "controlled cleanup: legacy extractor captured N null-tenure rows; new extractor correctly drops them"
```

## Per-wave migration steps (operator workflow)

```
# Phase A: capture + author all banks in the wave (loops the per-bank flow above)
node scripts/migrate-pilot-wave.js <1|2|3> --dry-run

#   Reads pilot-50-cohort-selection.md, walks the wave's banks, prints what
#   would happen for each (existing template? proposed template? expected
#   parity status?). NO writes. NO network. Operator reviews the plan.

# Phase B: execute (interactive — confirms each bank's write)
node scripts/migrate-pilot-wave.js <1|2|3> --execute

#   Refuses to run under agent / CI / non-TTY.
#   Per-bank loop:
#     1. Fetch + fingerprint (calls scripts/author-template.js dry-run)
#     2. Operator [y/N] to write
#     3. On y, writes template block, runs replay, prints parity
#     4. On n, marks bank as skipped + logs reason
#   Emits a wave summary at the end.

# Phase C: rebuild pack + quality-gate
node pack/build-pack.js
node scripts/quality-gate.js \
  pack/dist/rates-pack.json pack/history/rates-pack-2026-05-14.json \
  --out-dir pack/dist

#   Exit 0 = wave is green. Exit 1 = blocking findings; operator
#   reviews quality-report.md and either:
#     (a) fixes the extractor (Phase C+ iteration)
#     (b) pre-emptively accepts via bin/approve-accept.js
#     (c) rolls back the wave (git reset --hard HEAD~1)

# Phase D: commit
git add data/bank-domains.json output/latest/_manifest_summary.json
git commit -m "sprint-006(step-4-wave-N): migrate N banks to deterministic templates"
```

## Parity-check protocol (per-bank)

The `author-template.js` CLI emits a per-bank parity comparison when it replays the extractor:

- Compares **current extracted slabs** (from the new dispatch path) against **baseline slabs** in `tmp/baseline-pre-reset/<bank>_rates.json`
- Tolerance: ±1 slab AND ±5bps on shared tenures (1y, 3y, 5y)
- Reports delta + per-slab diff

A bank fails parity if:
- New slab count is more than 1 less than baseline (loss of real rates), OR
- Any shared-tenure rate differs by >5bps without explanation

Failures BLOCK promotion. Operator either:
1. Fixes the extractor and re-runs (Phase C+ iteration mid-sprint), OR
2. Pre-emptively accepts the delta as "controlled cleanup" via `bin/approve-accept.js`, OR
3. Skips the bank (it stays on the legacy path; Sprint 7 revisits)

## Pre-emptive accepts list (known controlled cleanups)

From Phase 0 + Sprint 5 findings:

| Bank | Variant | Reason |
|---|---|---|
| `the-andhra-pradesh-state-co-operative-bank-ltd` | regular | New extractor drops 3 null-tenure rows (Period of Deposit header, Above-1-year section divider, Add. Int. for Senior Citizens note). Sprint 5 Phase C finding #2. |
| Additional banks TBD | TBD | Operator adds entries here as they surface during wave execution |

For each, run BEFORE the wave's pack quality-gate:

```bash
node bin/approve-accept.js \
  --bank the-andhra-pradesh-state-co-operative-bank-ltd \
  --variant regular \
  --finding-hash sha256:<from-quality-report-after-rebuild> \
  --reason "controlled cleanup per Sprint 5 finding: legacy captured 3 null-tenure rows; new extractor correctly drops them"
```

## Helper CLI: `scripts/migrate-pilot-wave.js`

Ships in this commit. Wraps the per-bank flow with wave-level orchestration + safety rails.

```
node scripts/migrate-pilot-wave.js <wave-number> [options]

Options:
  --dry-run            Walk the wave, print planned actions, exit. No writes. (default)
  --execute            Interactive per-bank flow. Refuses agent / CI / non-TTY.
  --skip <bank>        Skip specific banks (comma-separated)
  --only <bank>        Run only specific banks (comma-separated; for targeted re-runs)
  --help               Show usage

Exit codes:
  0   success / dry-run complete
  2   usage error / unknown wave
  10  refused (CI)
  11  refused (agent session)
  12  refused (no TTY for --execute)
  20  one or more bank migrations failed parity check
```

The wave composition is hard-coded from `pilot-50-cohort-selection.md` so a typo in --execute can't swap in an unintended bank.

## Verification

### Pre-execution (operator runs)

1. Confirm `tmp/baseline-pre-reset/` exists and is the right snapshot (`SNAPSHOT_MANIFEST.json`)
2. Confirm operator key exists at `~/.rate-discovery/operator.key`
3. Confirm AOAI env vars are set if LLM-propose will fire (Sprint 7 — not in pilot scope)
4. Run `node scripts/migrate-pilot-wave.js 1 --dry-run` and inspect output

### Per-wave (operator runs)

1. Run the wave: `node scripts/migrate-pilot-wave.js <N> --execute`
2. Verify `output/latest/_manifest_summary.json`:
   - `manifests_loaded` reflects the wave's banks
   - `deterministic_pct ≥ 70` (Sprint 6 exit criterion #2)
   - No `needs_template_authoring` for the wave's banks (all should be operator-authored)
3. Build pack: `node pack/build-pack.js`
4. Run gate: `node scripts/quality-gate.js ...`
5. Expect exit 0; if 1, inspect `quality-report.md` and decide accept / fix / rollback

### End-of-sprint smoke (operator runs after all 3 waves)

- All 50 pilot banks have `template` blocks in `data/bank-domains.json`
- `_manifest_summary.json` shows all 50 on deterministic templates (or operator-accepted fallbacks)
- Pack quality-gate exits 0
- `npm test` green

## Risks

1. **Real-bank fetch failures.** Pilot composition explicitly excluded known WAF/timeout banks, but live fetch can surface new failures. Mitigation: `--skip <bank>` flag; failed banks defer to Sprint 7.
2. **Per-bank parity check too strict.** Some banks legitimately have more slabs in the new extractor than baseline (better column-mapping fixes the FCNR cell-loss issue). Mitigation: parity check FLAGS the case as `controlled_cleanup_candidate`, operator manually approves via `bin/approve-accept.js`.
3. **Pack quality-gate finds an unrelated regression.** A bank not in the wave might have regressed independently. Mitigation: filter findings by the wave's bank list; an off-wave regression is logged but doesn't block the wave's commit (Sprint 7 revisits).
4. **AOAI cost spike during authoring.** Only fires when LLM-propose path is needed (cluster miss). Mitigation: 50-bank pilot favors --reuse-template for known clusters; estimate <$10 total LLM cost.

## Open follow-ups

- **`scripts/migrate-pilot-wave.js` execute path**: this commit ships dry-run + the orchestration skeleton. The `--execute` path that actually invokes `author-template.js --write` per bank is wired but UNTESTED end-to-end (requires real Playwright + operator TTY). Operator runs the first wave; any orchestration bug surfaces immediately and is fixed mid-sprint.
- **Wave 3 IBU banks** (HDFC-IBU, IDBI-IBU) are the riskiest — their `ibu-static-pdf-quarterly` extractor's DocIntel path is a skeleton (Sprint 7). If pdfText extraction yields <3 slabs, the wave will need a Sprint 7 follow-up before the gate goes green.
