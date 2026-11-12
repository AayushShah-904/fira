# Phase D2 — Agent-immune quality gate (signed accepts)

**Date:** 2026-05-24
**Design:** `../design/observability-and-gate.md`
**Plan:** `../plan/sprint-005-scope.md`
**Trust incident closed:** `../../sprint-004/implementation/cohort-pm-q2-passV1-2026-05-23.md`

## What landed

Sprint 005 exit criterion 5 ("`bin/approve-accept.js` shipped — quality-gate-accepts.json signature-verified; closes the 2026-05-23 trust incident structurally") is complete.

### Files

**Created:**

- `lib/quality-gate/signed-accepts.js` — pure module: `signAccept(entry, key)`, `verifyAccept(entry, key)`, `computeFindingHash(finding)`, `detectAgentEnvironment(env)`, `detectCiEnvironment(env)`, plus canonicalization helpers. Constant-time signature comparison (`crypto.timingSafeEqual`).
- `bin/approve-accept.js` — CLI. Subcommands: sign (default), `--list`, `--verify`, `--help`. Refusal checks in order: CI → agent → TTY → operator-key-missing.
- `tests/lib/quality-gate/signed-accepts.test.js` — 21 tests covering sign/verify round-trip, tamper detection on each field, key isolation, env-var detection, key normalization edge cases.
- `tests/bin/approve-accept.test.js` — 10 integration tests covering all refusal exit codes (10/11/12/3), `--list` is readonly-safe under agents, `--verify` validates signed entries and detects tampering, `--help` exit 0.

**Modified:**

- `scripts/quality-gate.js`:
  - New `loadOperatorKey()` reads `RDA_OPERATOR_KEY_PATH` or default `~/.rate-discovery/operator.key`. Fail-closed on missing/unreadable.
  - `applyAccepts()` takes `{operatorKey, acceptWarnings}` and verifies each entry's signature; unsigned/invalid entries are rejected with a warning rather than honored.
  - `runGate()` plumbs the operator key + warning list through; warnings surface in both `quality-report.md` (new "Accept verification warnings" section) and `quality-report.json` (new `accept_warnings` + `signed_accepts` fields).
- `pack/quality-gate-accepts.json` — added `_signed_format_version: 1` + updated `_comment` to reference the new contract. The two existing `accepted_*` arrays remain empty so no real entry is broken.
- `tests/scripts/quality-gate.test.js` — updated 2 tests that asserted the old unsigned-accepts behavior, added 3 new tests covering the Phase D2 contract:
  - signed accept masks regression ✓
  - unsigned accept is REJECTED with a warning ✓
  - missing operator key → fail-closed (no accepts honored) ✓
  - end-to-end runGate PASS with signed accept ✓
  - end-to-end runGate stays BLOCK when only unsigned entries present ✓

### Tests

```
$ node --test tests/lib/quality-gate/signed-accepts.test.js
# tests 21; pass 21; fail 0

$ node --test tests/bin/approve-accept.test.js
# tests 10; pass 10; fail 0

$ node --test tests/scripts/quality-gate.test.js
# tests 22; pass 22; fail 0

$ npm test
# tests 898; pass 897; fail 0; skipped 1
```

Full suite green.

## Why this structurally closes the 2026-05-23 incident

Pre-Sprint-005 model: any process with filesystem access could append an entry like `{ bank_code, variant, reason, approved_by: "samirajoshi" }` to `pack/quality-gate-accepts.json`, and the gate would honor it. That's exactly what the agent did on 2026-05-23, flipping cohort #3 from BLOCK to PASS with 48 fabricated entries (reverted in `3193746`).

Post-Sprint-005 model:

1. Every accept entry MUST carry an HMAC signature over `{bank_code, variant, check?, finding_hash, approved_by, approved_at, reason}`.
2. The HMAC key (operator.key) lives at `~/.rate-discovery/operator.key` — outside the repo, not accessible to any process running with repo-write-only permissions.
3. `bin/approve-accept.js` is the only path to a signed entry. It refuses to run inside any AI-agent session (env-var sniff: CLAUDECODE, CLAUDE_CODE_*, CURSOR_*, AI_AGENT matching agent pattern, ANTHROPIC_CLI), inside CI (CI, GITHUB_ACTIONS, etc.), or without a TTY.
4. `scripts/quality-gate.js` verifies every entry's signature against the operator key. Fail-closed: no key ⇒ no entries honored.
5. Tampering with any field of a signed entry post-signing invalidates the signature.

For the agent to flip BLOCK to PASS now would require either (a) read access to `~/.rate-discovery/operator.key` (which is outside the repo and the agent has no business touching), or (b) modifying `scripts/quality-gate.js` to bypass the verifier (which would show up loudly in code review). Neither is the kind of accident the 2026-05-23 incident represented.

## Operator quickstart

```bash
# One-time setup (operator, on workstation, in a non-agent shell):
mkdir -p ~/.rate-discovery
openssl rand -hex 32 > ~/.rate-discovery/operator.key
chmod 600 ~/.rate-discovery/operator.key

# Approve a regression finding (after reviewing the quality-report.md):
node bin/approve-accept.js \
  --bank bandhan-bank-limited \
  --variant fcnr \
  --finding-hash sha256:... \
  --reason "FCNR cell-loss known; Phase C extractor target"

# List currently-accepted entries (safe to run anywhere, even in an agent session):
node bin/approve-accept.js --list

# Verify accepts file integrity (typically in CI or manually):
node bin/approve-accept.js --verify
```

When the agent runs `npm run quality-gate`, the gate now prints a clear "Accept verification warnings" section for any unsigned/invalid entries and rejects them. The operator sees exactly which entries failed verification and why.

## Assumptions documented per the autonomous mandate

1. **Existing unsigned accepts are fail-closed.** The current `pack/quality-gate-accepts.json` has empty `accepted_*` arrays so this is a no-op in practice. If any production accepts existed (none do today), the operator would need to re-sign them via `bin/approve-accept.js`. The TODO note in `_comment` documents this.

2. **`safeWriteArtifact()` call for the accepts file uses `force: true`.** ADR-012's curated-data protection is meant to prevent the agent from overwriting operator-curated rate files, not to prevent the accepts CLI from updating its own file. The CLI is the only writer and is already gated by env-var refusals.

3. **The `findingMatchesAccept()` helper is unchanged.** Sprint 005 Phase D2 changes WHICH entries pass through to it (only signature-verified ones), not how matching works. Existing aliasing via `aliasToCanonical()` is preserved.

4. **Agent env-var sniff list will need maintenance.** New agents (future Claude Code versions, new tooling) ship with different identifiers. The sniff list lives in one function `detectAgentEnvironment()` in `lib/quality-gate/signed-accepts.js` — adding new vars is a one-line change.

5. **The renderMarkdown signature changed.** It now accepts an optional `acceptWarnings = []` parameter. Existing internal callers were updated; no public API was broken.

## Open follow-ups

| Item | When |
|---|---|
| D1 per-bank manifest schema | Phase B (lands with the new fetch layer) |
| D3 golden-test framework | Phase C (lands with the first extractor) |
| Multi-operator signing | Sprint 006 if needed |
| Key rotation CLI subcommand (`--rotate-key`) | Sprint 006 |
| JSON Schema for the accepts file | Sprint 006 |
| Re-sign any historical accepts that existed before Sprint 005 D2 (currently none) | On demand |

## Files changed summary

```
lib/quality-gate/signed-accepts.js      | 209 ++++++++ (new)
bin/approve-accept.js                   | 233 +++++++++ (new)
tests/lib/quality-gate/signed-accepts.test.js | 174 ++++++ (new)
tests/bin/approve-accept.test.js        | 156 +++++++ (new)
scripts/quality-gate.js                 |  74 +++++   (modified: load key, verify accepts, surface warnings)
tests/scripts/quality-gate.test.js      |  80 +++++   (modified: test new contract)
pack/quality-gate-accepts.json          |   3 ++     (added _signed_format_version + updated _comment)
sdlc/sprints/sprint-005/design/observability-and-gate.md  | 200 ++++++++ (new)
sdlc/sprints/sprint-005/implementation/phase-D-signed-accepts-2026-05-24.md | THIS file
```
