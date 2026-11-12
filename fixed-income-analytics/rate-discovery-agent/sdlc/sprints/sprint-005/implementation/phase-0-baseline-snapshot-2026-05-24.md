# Phase 0.5 — Baseline snapshot

**Date:** 2026-05-24
**Design / handoff:** `../plan/phase-0-data-mining-handoff.md`
**Script:** `scripts/analysis/baseline-snapshot.js`

## What landed

Locked the current production extraction state into `tmp/baseline-pre-reset/` as the immutable ground truth for Phase E per-bank parity checks (±1 slab, ±5bps on shared tenures before a bank can be promoted to a deterministic extractor).

| Source | Destination | Size |
|---|---|---|
| `output/latest/` (whole dir) | `tmp/baseline-pre-reset/output-latest/` | 2271 files, 5,340,271 bytes |
| `pack/dist/rates-pack.json` | `tmp/baseline-pre-reset/rates-pack.json` | 3,626,350 bytes |
| `pack/dist/quality-report.json` | `tmp/baseline-pre-reset/quality-report.json` | 221,968 bytes |
| `pack/dist/quality-report.md` | `tmp/baseline-pre-reset/quality-report.md` | 33,995 bytes |
| `pack/dist/SUMMARY.json` | `tmp/baseline-pre-reset/SUMMARY.json` | 1,348 bytes |
| `pack/dist/SUMMARY.md` | `tmp/baseline-pre-reset/SUMMARY.md` | 4,966 bytes |
| `pack/quality-gate-accepts.json` | `tmp/baseline-pre-reset/quality-gate-accepts.json` | 2,163 bytes |

`SNAPSHOT_MANIFEST.json` records the timestamp, sources, and purpose for future archaeology.

## Why this had to run before anything else

Per [[feedback_preserve_scraped_artifacts]] `output/latest/` carries real scraped data — analysis must never mutate it. Locking the baseline first means any future change to `output/latest/` (intentional re-runs, accidental writes from a dev script) is recoverable by comparing against `tmp/baseline-pre-reset/`.

## Rerun protocol

The script refuses to clobber an existing snapshot. Pass `--force` to replace — only do this if there's a documented reason to advance the baseline (e.g., a pre-reset late fix that we want included). Default behavior is "frozen baseline forever" until Sprint 005 closes.

## Consumed by

- Phase E per-bank parity check: `tmp/baseline-pre-reset/output-latest/<bank>_rates.json` is the comparison target.
- Phase 0.4 golden harvest: pulls from the baseline (not live) to ensure goldens reflect what shipped to prod, not what a concurrent re-run might produce.

## Open follow-ups

None. Snapshot is final unless `--force` is used.
