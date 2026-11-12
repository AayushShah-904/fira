#!/usr/bin/env node
'use strict';

/**
 * bin/approve-accept.js — the ONLY path to a signed quality-gate accept entry.
 *
 * Sprint 005 Phase D2. Replaces the prior "any process that writes
 * pack/quality-gate-accepts.json can flip BLOCK to PASS" model with an
 * operator-gated, HMAC-signed approval flow. The 2026-05-23 trust incident
 * (sdlc/sprints/sprint-004/implementation/cohort-pm-q2-passV1-2026-05-23.md)
 * is structurally impossible under this design.
 *
 * Design: sdlc/sprints/sprint-005/design/observability-and-gate.md
 *
 * Refuses to run if:
 *   - inside any AI-agent session (CLAUDECODE, CURSOR_*, AI_AGENT pattern, ...)
 *   - inside CI (CI=1, GITHUB_ACTIONS, ...)
 *   - stdin is not a TTY (non-interactive context)
 *   - operator key file is missing
 *
 * Usage:
 *   node bin/approve-accept.js --bank <code> --variant <v> --finding-hash <h> --reason "<text>"
 *   node bin/approve-accept.js --bank <code> --variant <v> --check <name> --finding-hash <h> --reason "<text>"
 *   node bin/approve-accept.js --list
 *   node bin/approve-accept.js --verify
 *
 * Operator key:
 *   Default path: ~/.rate-discovery/operator.key
 *   Override:     RDA_OPERATOR_KEY_PATH=/path/to/key
 *   Format:       32+ bytes of hex (e.g., `openssl rand -hex 32 > ~/.rate-discovery/operator.key`)
 *
 * Exit codes:
 *   0   — success
 *   2   — usage error
 *   3   — operator key missing or invalid
 *   10  — refused (CI detected)
 *   11  — refused (AI agent detected)
 *   12  — refused (no TTY)
 *   20  — verify failed (one or more entries have invalid signatures)
 *   21  — write failed
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { safeWriteArtifact } = require('../lib/safe-write');
const {
  signAccept,
  verifyAccept,
  detectAgentEnvironment,
  detectCiEnvironment,
  SIGNED_FORMAT_VERSION,
  FINDING_HASH_PREFIX,
} = require('../lib/quality-gate/signed-accepts');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ACCEPTS_PATH = path.join(REPO_ROOT, 'pack', 'quality-gate-accepts.json');
const DEFAULT_KEY_PATH = path.join(os.homedir(), '.rate-discovery', 'operator.key');

function fail(code, message) {
  process.stderr.write(`approve-accept: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { bank: null, variant: null, check: null, findingHash: null, reason: null, kind: 'regression', list: false, verify: false, accepts: null, yes: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bank' || a === '-b') out.bank = args[++i];
    else if (a === '--variant' || a === '-v') out.variant = args[++i];
    else if (a === '--check' || a === '-c') { out.check = args[++i]; out.kind = 'anomaly'; }
    else if (a === '--finding-hash' || a === '-f') out.findingHash = args[++i];
    else if (a === '--reason' || a === '-r') out.reason = args[++i];
    else if (a === '--kind' || a === '-k') out.kind = args[++i];
    else if (a === '--list' || a === '-l') out.list = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--accepts') out.accepts = args[++i];
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else fail(2, `unknown argument: ${a}`);
  }
  return out;
}

function printUsage() {
  process.stdout.write(`approve-accept — sign quality-gate accept entries

Usage:
  approve-accept --bank <code> --variant <v> --finding-hash <h> --reason "<text>"
  approve-accept --bank <code> --variant <v> --check <name> --finding-hash <h> --reason "<text>"
  approve-accept --list
  approve-accept --verify

Options:
  --bank, -b           Bank code (matches finding.bank_code)
  --variant, -v        Variant: regular | nre | nro | fcnr | gift
  --check, -c          Anomaly check name (e.g. senior_below_general); switches kind to "anomaly"
  --finding-hash, -f   sha256:... from quality-report.json finding
  --reason, -r         Why this finding is being accepted (will be persisted)
  --kind, -k           regression (default) | anomaly
  --accepts            Path to accepts file (default: pack/quality-gate-accepts.json)
  --list               List currently-accepted entries (no key needed)
  --verify             Verify all entries (exit non-zero on first invalid)
  --help, -h           Show this message

Operator key:
  Default ~/.rate-discovery/operator.key — override with RDA_OPERATOR_KEY_PATH
  Generate with: openssl rand -hex 32 > ~/.rate-discovery/operator.key && chmod 600 ~/.rate-discovery/operator.key
`);
}

function loadOperatorKey() {
  const keyPath = process.env.RDA_OPERATOR_KEY_PATH || DEFAULT_KEY_PATH;
  if (!fs.existsSync(keyPath)) {
    fail(3, `operator key not found at ${keyPath}\n` +
            `  Generate one with: openssl rand -hex 32 > ${keyPath} && chmod 600 ${keyPath}`);
  }
  try {
    return fs.readFileSync(keyPath, 'utf-8');
  } catch (e) {
    fail(3, `failed to read operator key at ${keyPath}: ${e.message}`);
  }
}

function loadAccepts(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      _signed_format_version: SIGNED_FORMAT_VERSION,
      since_pack: null,
      accepted_regressions: [],
      accepted_anomalies: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    fail(21, `failed to read or parse ${filePath}: ${e.message}`);
  }
}

async function promptConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(ans).trim()));
    });
  });
}

async function cmdList(opts) {
  const accepts = loadAccepts(opts.accepts || DEFAULT_ACCEPTS_PATH);
  const regs = accepts.accepted_regressions || [];
  const anos = accepts.accepted_anomalies || [];
  process.stdout.write(`accepts file: ${opts.accepts || DEFAULT_ACCEPTS_PATH}\n`);
  process.stdout.write(`format version: ${accepts._signed_format_version || '(unsigned — legacy)'}\n`);
  process.stdout.write(`accepted_regressions: ${regs.length}\n`);
  for (const e of regs) {
    process.stdout.write(`  - ${e.bank_code} / ${e.variant} — by ${e.approved_by} at ${e.approved_at}\n`);
    process.stdout.write(`    reason: ${e.reason}\n`);
    process.stdout.write(`    signature: ${e.signature ? 'present' : 'MISSING'}\n`);
  }
  process.stdout.write(`accepted_anomalies: ${anos.length}\n`);
  for (const e of anos) {
    process.stdout.write(`  - ${e.bank_code} / ${e.variant} / ${e.check} — by ${e.approved_by} at ${e.approved_at}\n`);
    process.stdout.write(`    reason: ${e.reason}\n`);
    process.stdout.write(`    signature: ${e.signature ? 'present' : 'MISSING'}\n`);
  }
}

function cmdVerify(opts) {
  const accepts = loadAccepts(opts.accepts || DEFAULT_ACCEPTS_PATH);
  const key = loadOperatorKey();
  let invalid = 0;
  let valid = 0;
  for (const list of ['accepted_regressions', 'accepted_anomalies']) {
    for (const e of (accepts[list] || [])) {
      const v = verifyAccept(e, key);
      if (v.valid) { valid++; }
      else {
        invalid++;
        process.stderr.write(`INVALID: ${list}[bank=${e.bank_code}, variant=${e.variant}${e.check ? `, check=${e.check}` : ''}]\n`);
        process.stderr.write(`  reason: ${v.reason}\n`);
      }
    }
  }
  process.stdout.write(`verify: ${valid} valid, ${invalid} invalid\n`);
  if (invalid > 0) process.exit(20);
}

async function cmdSign(opts) {
  if (!opts.bank) fail(2, 'missing --bank');
  if (!opts.variant) fail(2, 'missing --variant');
  // --check is OPTIONAL for anomalies: ANOMALY_GAIN findings carry no check;
  // check-bearing anomalies (e.g. senior_below_general) pass it for precise
  // matching (the gate skips the check filter when an accept has none).
  if (!opts.findingHash) fail(2, 'missing --finding-hash');
  if (!opts.findingHash.startsWith(FINDING_HASH_PREFIX)) {
    fail(2, `--finding-hash must start with "${FINDING_HASH_PREFIX}" (got ${opts.findingHash.slice(0, 30)}...)`);
  }
  if (!opts.reason) fail(2, 'missing --reason');

  const acceptsPath = opts.accepts || DEFAULT_ACCEPTS_PATH;
  const accepts = loadAccepts(acceptsPath);
  if (!accepts._signed_format_version) accepts._signed_format_version = SIGNED_FORMAT_VERSION;

  // Idempotency: if this finding_hash is already signed in the target list,
  // skip (no duplicate, no failure) so a worksheet re-run after an
  // interruption is safe to re-run from the top.
  const list = opts.kind === 'anomaly' ? 'accepted_anomalies' : 'accepted_regressions';
  if (!Array.isArray(accepts[list])) accepts[list] = [];
  if (accepts[list].some((e) => e && e.finding_hash === opts.findingHash)) {
    process.stdout.write(`already accepted (${opts.bank} ${opts.variant}; finding_hash ${opts.findingHash}) — skipping.\n`);
    process.exit(0);
  }

  const key = loadOperatorKey();
  const approvedBy = process.env.USER || process.env.USERNAME || 'operator';
  const entry = {
    bank_code: opts.bank,
    variant: opts.variant,
    finding_hash: opts.findingHash,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    reason: opts.reason,
  };
  if (opts.kind === 'anomaly' && opts.check) entry.check = opts.check;
  const signed = signAccept(entry, key);

  process.stdout.write(`\nAbout to sign and persist this entry:\n`);
  process.stdout.write(`  kind:         ${opts.kind}\n`);
  process.stdout.write(`  bank_code:    ${entry.bank_code}\n`);
  process.stdout.write(`  variant:      ${entry.variant}\n`);
  if (entry.check) process.stdout.write(`  check:        ${entry.check}\n`);
  process.stdout.write(`  finding_hash: ${entry.finding_hash}\n`);
  process.stdout.write(`  approved_by:  ${entry.approved_by}\n`);
  process.stdout.write(`  approved_at:  ${entry.approved_at}\n`);
  process.stdout.write(`  reason:       ${entry.reason}\n`);
  process.stdout.write(`  accepts file: ${acceptsPath}\n`);

  // --yes: operator pre-approved this batch (e.g. after reviewing the
  // accept-review digest); skip the per-entry prompt. The hard guards
  // (agent/CI refusal, TTY requirement, operator-key signature) still apply.
  const confirmed = opts.yes ? true : await promptConfirm('\nConfirm? [y/N] ');
  if (opts.yes) process.stdout.write('  (--yes: auto-confirmed)\n');
  if (!confirmed) {
    process.stdout.write('aborted by operator\n');
    process.exit(0);
  }

  accepts[list].push(signed);

  try {
    safeWriteArtifact({
      path: acceptsPath,
      incoming: JSON.stringify(accepts, null, 2) + '\n',
      kind: 'quality-gate-accepts',
      source: 'operator',
      force: true, // operator-curated file; safeWriteArtifact's curated-data protection doesn't apply to its own accepts list
    });
  } catch (e) {
    fail(21, `failed to write ${acceptsPath}: ${e.message}`);
  }
  process.stdout.write(`\nsigned and persisted to ${acceptsPath}\n`);
}

async function main() {
  const opts = parseArgs(process.argv);

  // Refusal checks happen BEFORE any state read/write so partial side-effects are impossible.
  // Order matters: CI / agent checks fire BEFORE TTY check so the more-informative error
  // message wins (e.g., "you're inside Claude Code" beats "no TTY"). The --verify path
  // shares the agent/CI refusal because reading the operator key from inside an agent is
  // also a leak risk; only --list (which never reads the key) bypasses these checks.
  if (!opts.list) {
    const ci = detectCiEnvironment();
    if (ci.isCI) fail(10, `refusing to run under CI — sign accepts from an operator workstation only. (${ci.reason})`);
    const ag = detectAgentEnvironment();
    if (ag.isAgent) fail(11, `refusing to run inside an AI-agent session. (${ag.reason})\n  ` +
                              `Open a fresh shell outside the agent and re-run.`);
    // --verify is read-only-ish: it reads the operator key, but doesn't mutate anything.
    // The TTY check is for interactive confirmation of NEW signatures, so skip it for --verify.
    if (!opts.verify && !process.stdin.isTTY) fail(12, 'refusing to run without a TTY — sign accepts interactively.');
  }

  if (opts.list) return cmdList(opts);
  if (opts.verify) return cmdVerify(opts);
  return cmdSign(opts);
}

main().catch((e) => fail(1, `unhandled error: ${e.stack || e.message}`));
