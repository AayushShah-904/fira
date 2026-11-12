# Cloud-as-truth cutover — implementation log (2026-07-08)

Companion to `../design/cloud-source-of-truth-2026-07-08.md`. Goal of the day:
a high-quality FCNR rate pack generated from cloud state.

## Shipped this morning

| Change | Commit | Notes |
| --- | --- | --- |
| `push-bank-domains-merge.js`: port run-authored fields (`cloud_block_status`, `cloud_capability`) from cloud when `last_observed` newer | e18b9a0 | 63 fields from the 07-07 runs preserved; local-wins for config. Verified merged file carries jkb `/interest-rates` + emirates USD-only fixes. |
| `seed-latest-from-local.js` (new): scraped_at-guarded one-way local→blob seeding, safe-write-consistent verdicts | e18b9a0 + follow-up | Auto: blob-missing, local-newer non-shrink, blob-empty repair. REVIEW bucket (no auto-upload): >50% shrink either direction. |
| Quality gate in cloud finalize + baseline moved to `pack/baseline/` | ac9144c | Root cause: `pack/publish.js` hard-blocks without `QUALITY-GATE.json`; finalize never ran the gate; baseline was dockerignored under `logs/`. rates-pack container had been stale since 2026-06-05. Takes effect on next image deploy. |
| `pull-latest-from-blob.js` (new): bulk blob→staging puller (SDK, parallel, `:`-name translation) | ce6da29 | Enables pack assembly FROM cloud state on the operator machine while the deployed image predates the gate fix. Refuses to write into `output/latest`. |

Test suite after all changes: 1661 tests, 0 fail, 44 skipped.

## Key finding

**Cloud pack publish has been silently broken since 2026-06-05** — every cloud
finalize built a pack and then failed the publish precondition (missing gate
verdict), logged non-fatally. The `rates-pack` container still serves the
June 5 pack. Under the new strategy this was the first thing to fix.

## Blocked on operator (classifier-gated prod writes)

1. Registry push: `node scripts/azops/push-bank-domains-merge.js`
   (dry-run verified: 1037 banks, 63 run-authored fields preserved).
2. Artifact seeding: `node scripts/azops/seed-latest-from-local.js --apply`
   (after reviewing the REVIEW bucket in `output/seed-latest-plan-2026-07-08.json`).
3. Optional but recommended: rebuild+deploy image (picks up gate-in-finalize,
   registry fixes, leaner context) so the cloud run publishes the pack itself.

Then: `node scripts/azops/start-cohort-run.js --cohort fcnr-cohort-2026-07-07 --env prod --rates-only`
(~90 min), then pack + gate + PM deliverable from cloud state.
