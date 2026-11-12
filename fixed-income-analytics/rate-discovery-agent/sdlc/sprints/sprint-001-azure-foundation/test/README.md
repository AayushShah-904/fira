# Sprint 001 — Test

This folder holds test results and manual verification logs for the sprint. Expected contents (added as work progresses):

- `unit-test-results.md` — coverage summary, notable additions, known gaps
- `integration-test-results.md` — fixture-based integration test outcomes (local fs + Azurite modes)
- `regression-baseline.md` — snapshot of the golden `rates-pack.json` used as the regression baseline, with the bank list it covers
- `smoke-tests/` — one file per smoke test scenario
  - `local-end-to-end.md`
  - `cloud-manual-trigger.md`
  - `pm-pack-fetch.md`

Refer to the top-level [`test-strategy.md`](../../../test-strategy.md) for the layered approach this sprint implements.
