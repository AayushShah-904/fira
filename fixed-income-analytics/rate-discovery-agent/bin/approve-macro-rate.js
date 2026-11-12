#!/usr/bin/env node
'use strict';
//
// Operator-only: promote data/macro-rates.proposed.json -> data/macro-rates.json,
// stamping approved_by/approved_at. This is the ONLY path that activates the
// Phase-7 repo anchor (ADR-017). Agent-immune by intent: it requires the
// operator key to be present (proof of operator identity) and an explicit --yes.
//
// Usage (operator, in a real shell):
//   node bin/approve-macro-rate.js --yes [--by <name>]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const APPROVED = path.join(REPO, 'data', 'macro-rates.json');
const PROPOSED = path.join(REPO, 'data', 'macro-rates.proposed.json');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

function main() {
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to approve without --yes. This activates the macro repo anchor used by the quality gate.');
    process.exit(2);
  }
  const keyPath = process.env.RDA_OPERATOR_KEY_PATH || path.join(os.homedir(), '.rate-discovery', 'operator.key');
  if (!fs.existsSync(keyPath)) {
    console.error(`Operator key not found at ${keyPath}. This command is operator-only (proof of identity). Aborting.`);
    process.exit(3);
  }
  let proposal;
  try { proposal = JSON.parse(fs.readFileSync(PROPOSED, 'utf-8')); } catch {
    console.error(`No proposal at ${PROPOSED}. Run scripts/macro/propose-repo-rate.js first.`); process.exit(2);
  }
  if (!Number.isFinite(Number(proposal.repo_rate)) || !proposal.source_url) {
    console.error('Proposal missing repo_rate or source_url. Aborting.'); process.exit(2);
  }
  const by = arg('--by') || process.env.USER || process.env.USERNAME || 'operator';
  const approved = {
    repo_rate: Number(proposal.repo_rate),
    effective_date: proposal.effective_date || null,
    source_url: proposal.source_url,
    approved_by: by,
    approved_at: new Date().toISOString(),
    spreads_by_bank_type: proposal.spreads_by_bank_type,
  };
  // safe-write-exempt: macro-rate approved metadata (operator-run promotion), not a per-bank canonical artifact.
  fs.writeFileSync(APPROVED, JSON.stringify(approved, null, 2));
  console.log(`Approved macro rate: repo=${approved.repo_rate}% (eff ${approved.effective_date}) by ${by}. Repo anchor is now ACTIVE.`);
}

if (require.main === module) main();
