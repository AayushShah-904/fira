#!/usr/bin/env node
'use strict';
//
// Propose an RBI repo-rate macro value for the Phase-7 detector (ADR-017).
//
// Records a RESEARCHED value (from the RBI site or a tier-2 agent) into
// data/macro-rates.proposed.json for operator review. It NEVER writes the
// approved data/macro-rates.json and NEVER sets approved_by — activation is the
// operator's call via bin/approve-macro-rate.js (no-fake-approvals discipline).
//
// Usage:
//   node scripts/macro/propose-repo-rate.js --repo 6.5 --effective 2026-04-09 \
//        --source https://website.rbi.org.in/...   [--note "..."]

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const APPROVED = path.join(REPO, 'data', 'macro-rates.json');
const PROPOSED = path.join(REPO, 'data', 'macro-rates.proposed.json');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

function main() {
  const repo = Number(arg('--repo'));
  const effective = arg('--effective');
  const source = arg('--source');
  const note = arg('--note');
  if (!Number.isFinite(repo) || !source) {
    console.error('Usage: propose-repo-rate.js --repo <pct> --effective <YYYY-MM-DD> --source <rbi-url> [--note "..."]');
    console.error('The value must come from RBI-site / tier-2 research — this script only records a PROPOSAL.');
    process.exit(2);
  }
  // inherit the spreads map from the existing approved skeleton (don't reinvent)
  let spreads = { default: { low: 2.0, high: 2.5 } };
  try { spreads = JSON.parse(fs.readFileSync(APPROVED, 'utf-8')).spreads_by_bank_type || spreads; } catch { /* skeleton missing */ }

  const proposal = {
    _comment: 'PROPOSAL ONLY — not active. Operator promotes via bin/approve-macro-rate.js. The agent never sets approved_by.',
    repo_rate: repo,
    effective_date: effective || null,
    source_url: source,
    approved_by: null,
    approved_at: null,
    proposed_by: 'tier-2-research',
    proposed_at: new Date().toISOString(),
    note: note || null,
    spreads_by_bank_type: spreads,
  };
  // safe-write-exempt: macro-rate proposal metadata (operator-reviewed), not a per-bank canonical artifact.
  fs.writeFileSync(PROPOSED, JSON.stringify(proposal, null, 2));
  console.log(`Wrote proposal: ${path.relative(REPO, PROPOSED)}`);
  console.log(`  repo_rate=${repo}% effective=${effective || '(none)'} source=${source}`);
  console.log('NEXT: operator reviews, then runs  node bin/approve-macro-rate.js --yes  to activate the repo anchor.');
}

if (require.main === module) main();
