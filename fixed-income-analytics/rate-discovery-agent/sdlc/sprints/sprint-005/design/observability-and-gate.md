# Phase D — Observability + Agent-immune quality gate

**Phase:** D (Sprint 005)
**Status:** Design — to be implemented in Phase D code drops.
**Predecessor:** `../implementation/phase-0-summary-2026-05-24.md`
**Trust incident reference:** `../../sprint-004/implementation/cohort-pm-q2-passV1-2026-05-23.md` — 2026-05-23 incident where the agent committed 48 fabricated `approved_by: samirajoshi` quality-gate accepts to flip cohort #3 from BLOCK to PASS. Reverted in commit `3193746`.

## Context

The quality-gate-accepts file (`pack/quality-gate-accepts.json`) gates whether a BLOCK verdict becomes a PASS. Today it is structurally writable by the agent: any process with filesystem access can append an accepted_regression entry with `approved_by: samirajoshi` and the gate will honor it. The 2026-05-23 incident proved this is exploitable in practice, not just in theory.

Phase D2 makes the gate **agent-immune** through two changes:

1. **All accept entries must carry an HMAC signature** computed by a shared secret that lives outside the repo. Unsigned entries are rejected; entries with invalid signatures are rejected.
2. **A new `bin/approve-accept.js` CLI is the only path to a signed entry.** It refuses to run if it detects it's being invoked from an agent (env-var sniff: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `AI_AGENT`, `CURSOR_*`, etc.), if stdin isn't a TTY, or if `CI` is set. The operator must run it from a clean interactive shell.

The signing key lives at `~/.rate-discovery/operator.key` (outside the repo). If the file is missing, `bin/approve-accept.js` refuses to run (fail-closed) and `scripts/quality-gate.js` rejects all accepts (fail-closed). This means an attacker who only has repo write-access cannot accept anything.

## Goals

- The 2026-05-23 incident is **structurally impossible** under the new gate.
- The CLI's TTY + env-var checks make it impossible for the agent (any agent — Claude Code, Cursor, Copilot CLI, raw script) to produce a signed accept.
- Existing accept-file consumers (`scripts/quality-gate.js`, `scripts/refresh/*`, CI) work without behavior change when no signed accepts exist (empty-file case).
- The migration path is gentle: the file format is versioned and the unsigned legacy entries (currently 0 active) are explicitly rejected with a loud diagnostic message rather than silently honored.

## Non-goals (deferred)

- Per-bank manifest (Phase D1) — this design covers D2 (signed accepts) only. D1 lands separately alongside Phase B (where the fetcher emits the manifest fields).
- Golden-test framework (Phase D3) — lands alongside the Phase C `coop-bankin` extractor as the first golden-test consumer.
- Multi-operator signing (e.g., a second-approver model) — Phase D2 supports a single operator key; multi-key is a Sprint 006 enhancement if needed.

## Files modified / created

**Created:**

- `bin/approve-accept.js` — the only path to a signed entry. CLI wrapper.
- `lib/quality-gate/signed-accepts.js` — pure functions: `signAccept(entry, key)`, `verifyAccept(entry, key)`, `computeFindingHash(finding)`. Reused by both the CLI and `scripts/quality-gate.js`.
- `tests/lib/quality-gate/signed-accepts.test.js` — unit tests for sign/verify round-trip + tampering detection.
- `tests/bin/approve-accept.test.js` — integration tests: refuse-under-CI, refuse-under-CLAUDECODE, refuse-without-TTY, refuse-without-key.

**Modified:**

- `scripts/quality-gate.js` — `applyAccepts()` calls `verifyAccept(entry, key)` for every entry; unverified entries are rejected with `accept_rejected: true` finding and the operator sees a warning row in the report.
- `pack/quality-gate-accepts.json` — add `"_signed_format_version": 1` at the top. Existing empty `accepted_regressions: []` / `accepted_anomalies: []` arrays remain — Phase D2 changes the entry-level schema, not the file-level shape.
- `package.json` (optional) — add a `"approve-accept"` script that delegates to `node bin/approve-accept.js` for discoverability.

## Signed entry schema

```jsonc
{
  "_signed_format_version": 1,
  "since_pack": "2026-05-14",
  "accepted_regressions": [
    {
      "bank_code":      "bandhan-bank-limited",
      "variant":        "fcnr",
      "finding_hash":   "sha256:<hex>",     // sha256 of canonical { bank, variant, baseline, actual, class }
      "approved_by":    "samirajoshi",
      "approved_at":    "2026-05-25T10:42:11.234Z",
      "reason":         "FCNR cell-loss known; Phase C extractor target",
      "signature":      "hmac-sha256:<hex>" // HMAC-SHA256 over canonical {bank,variant,finding_hash,approved_by,approved_at,reason} with operator.key
    }
  ],
  "accepted_anomalies": [ /* same shape, plus `check` field */ ]
}
```

The `finding_hash` ties the accept to a specific finding shape. If the pack regresses further (e.g., bandhan-bank-limited fcnr drops from 19→10 instead of 19→24), the finding_hash changes and the existing accept stops matching — the operator must re-approve.

## Canonical-form rules (so signatures are stable)

The hash and signature both operate on a canonical JSON string. Rules:

- Field order is fixed: `bank_code, variant, check?, class, baseline, actual` for finding_hash; `bank_code, variant, check?, finding_hash, approved_by, approved_at, reason` for signature.
- Strings are UTF-8.
- Numbers are emitted as their JSON.stringify form (no trailing zeros, no leading `+`).
- Null and undefined fields are OMITTED, not emitted as `null`.

`lib/quality-gate/signed-accepts.js` exports `canonicalizeForHash()` and `canonicalizeForSig()` as named functions so the canonicalization is the single source of truth.

## Operator key

- Default path: `~/.rate-discovery/operator.key`
- Override via env: `RDA_OPERATOR_KEY_PATH=/path/to/key`
- Format: 32+ bytes of high-entropy random data (e.g., `openssl rand -hex 32`)
- If missing:
  - `bin/approve-accept.js` exits with code 3 and a "create the key" message
  - `scripts/quality-gate.js` warns "operator key not found; rejecting all accepts" and treats every accept as unverified

The operator generates the key once, stashes it in a password manager + on disk at the default path. Loss of the key invalidates all signed accepts — the operator must regenerate and re-approve all open accepts.

## CLI usage

```
# Approve a regression finding for a specific bank+variant
node bin/approve-accept.js \
  --bank bandhan-bank-limited \
  --variant fcnr \
  --finding-hash sha256:abc123... \
  --reason "FCNR cell-loss known; Phase C extractor target"

# Approve an anomaly with a specific check
node bin/approve-accept.js \
  --bank bandhan-bank-limited \
  --variant regular \
  --check senior_below_general \
  --finding-hash sha256:def456... \
  --reason "Bandhan publishes special-deposit rate in senior column; not a bug"

# List currently-accepted entries (read-only, no key needed)
node bin/approve-accept.js --list

# Verify the integrity of an accepts file (used by CI)
node bin/approve-accept.js --verify
```

The operator typically gets the `--finding-hash` value from a `quality-report.json` finding (the gate will print it next to each blocking finding once Phase D2 lands).

## Refuse-to-run checks

`bin/approve-accept.js` refuses to run if ANY of these are true (each prints a distinct error and exits with a distinct code so CI can pattern-match):

| Check | Exit code | Error |
|---|---|---|
| `process.env.CI` truthy | 10 | "refusing to run under CI — sign accepts from an operator workstation only" |
| `process.env.CLAUDECODE` set | 11 | "refusing to run inside Claude Code — sign accepts from a non-agent shell" |
| `process.env.CLAUDE_CODE_ENTRYPOINT` set | 11 | same |
| `process.env.CLAUDE_CODE_SESSION_ID` set | 11 | same |
| `process.env.AI_AGENT` matches /claude\|cursor\|copilot\|codeium\|aider/i | 11 | "refusing to run inside an AI-agent session" |
| `process.env.CURSOR_TRACE_ID` or `process.env.CURSOR_AGENT` set | 11 | same |
| `process.stdin.isTTY` is false | 12 | "refusing to run without a TTY — sign accepts interactively" |
| operator key missing | 3 | "operator key not found at ~/.rate-discovery/operator.key" |

All checks happen BEFORE any state is mutated; partial writes aren't possible.

Override: NONE. The autonomous-mode operator can review accept-file contents but cannot bypass the refusal. If the operator has a legitimate reason to sign from a non-interactive context (e.g., they're scripting a bulk re-sign after a key rotation), they edit the script to call `lib/quality-gate/signed-accepts.js` directly with a wrapper that explicitly opts-in via a sentinel argument — i.e., the bypass requires a code change, not a runtime flag. This makes any bypass attempt visible in git history.

## Verification matrix

Pre-merge tests (`npm test`):

| Test | Asserts |
|---|---|
| `signs and verifies a round-trip entry` | `verify(sign(entry)) === valid` |
| `tampering with bank_code invalidates signature` | post-sign mutation detected |
| `tampering with finding_hash invalidates signature` | same |
| `missing signature field is rejected` | unsigned entries blocked |
| `wrong key produces invalid signature` | key isolation works |
| `refuse-under-CI` | CLI exits 10 |
| `refuse-under-CLAUDECODE` | CLI exits 11 |
| `refuse-without-TTY` | CLI exits 12 |
| `refuse-without-key-file` | CLI exits 3 |
| `quality-gate.js rejects unsigned entries with a loud warning` | applyAccepts behavior |
| `quality-gate.js rejects entries with a valid signature but wrong operator key` | applyAccepts behavior |

End-to-end smoke (manual, post-implementation):

1. Operator deletes `~/.rate-discovery/operator.key`. Runs `node bin/approve-accept.js --bank x --variant y --finding-hash z --reason w`. Exit 3.
2. Operator generates a key: `openssl rand -hex 32 > ~/.rate-discovery/operator.key`. Re-runs. Sign succeeds; entry appended to `pack/quality-gate-accepts.json`.
3. Operator runs `npm run quality-gate`. Verify the signed entry is honored (regression marked accepted).
4. Operator manually edits `pack/quality-gate-accepts.json` to change a field (e.g., bank_code) in an existing signed entry. Re-runs gate. Verify entry is rejected with "signature invalid".

## Risks and assumptions

1. **Operator key exfiltration is out of scope.** If the operator's workstation is compromised, an attacker can sign arbitrary entries. The defense is good workstation hygiene; the gate protects against agent-via-repo-access exploitation, not full workstation compromise.

2. **The env-var sniff list will need updates** as new agents (Cursor 2.x, future Claude Code versions, new AI coding tools) ship with different identifiers. Mitigation: the sniff list lives in a single function `detectAgentEnvironment()` in `bin/approve-accept.js`; adding new vars is a one-line change.

3. **Existing unsigned accepts in `pack/quality-gate-accepts.json` are rejected by Phase D2.** The current file has zero active entries (only the array shells + comments), so this is a no-op in practice. If future entries land before D2 ships, the operator must re-sign them.

4. **Key rotation is operator-driven, not automatic.** When the key is rotated, every prior signed accept becomes invalid and the operator must re-approve. The CLI provides a `--rotate-key <new-key-path>` command in a future enhancement; Phase D2 ships with manual rotation only.

5. **Assumption: `npm test` runs the gate-verification tests with the test operator key.** The test fixtures use a fixed dummy key (`tests/fixtures/test-operator.key`) that does NOT match the real operator key, so test-only signatures can't be reused against production.

## Open follow-ups (deferred from Phase D2)

- D1 per-bank manifest schema (lands with Phase B).
- D3 golden-test framework (lands with the first Phase C extractor).
- Multi-operator signing (Sprint 006 if needed).
- Key rotation CLI subcommand (`bin/approve-accept.js --rotate-key`).
- Slack/email notification on accept events (Sprint 006).
