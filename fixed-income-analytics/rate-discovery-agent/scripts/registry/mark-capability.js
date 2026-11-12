#!/usr/bin/env node

/**
 * Sprint 010 Phase 2 — operator CLI for manual cloud_capability overrides.
 *
 * Usage:
 *   node scripts/registry/mark-capability.js <bank-code> <capable|incapable> "<reason>"
 *
 * Examples:
 *   node scripts/registry/mark-capability.js axis-bank-limited incapable "partial_silent confirmed in 9zulerb"
 *   node scripts/registry/mark-capability.js icici-bank-limited capable "local-probe succeeded 2026-06-08"
 *
 * Writes via safeWriteArtifact with source='operator' (already in
 * VALID_SOURCES). The mark goes in as a single high-confidence
 * observation, so it dominates any prior medium-confidence verdicts
 * from the auto-update path.
 *
 * Exit codes:
 *   0  success
 *   1  invalid args / IO error
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeWriteArtifact } = require('../../lib/safe-write');
const { mergeCapabilityIntoRegistry } = require('../../lib/cloud-capability/registry-updater');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DOMAINS = path.join(PROJECT_ROOT, 'data', 'bank-domains.json');

function usage() {
  console.error('Usage: node scripts/registry/mark-capability.js <bank-code> <capable|incapable> "<reason>"');
  process.exit(1);
}

function main() {
  const [, , bankCode, verdict, ...reasonParts] = process.argv;
  if (!bankCode || !verdict || reasonParts.length === 0) usage();
  if (verdict !== 'capable' && verdict !== 'incapable') {
    console.error(`error: verdict must be 'capable' or 'incapable' (got: ${verdict})`);
    usage();
  }
  const reason = reasonParts.join(' ').trim();
  if (!reason) {
    console.error('error: reason must be non-empty');
    usage();
  }

  if (!fs.existsSync(DOMAINS)) {
    console.error(`error: registry not found at ${DOMAINS}`);
    process.exit(1);
  }
  const domains = JSON.parse(fs.readFileSync(DOMAINS, 'utf-8'));
  const now = new Date().toISOString();
  const prior = (domains[bankCode] && domains[bankCode].cloud_capability) || null;

  const capable = verdict === 'capable';
  const priorSignals = (prior && prior.signals) || { partial_silent: 0, zero_slab: 0, crash: 0 };
  const capability = {
    capable,
    confidence: 'high',     // operator marks are always high confidence
    reason: `manual_operator:${reason}`,
    first_observed: prior && prior.first_observed ? prior.first_observed : now,
    last_observed: now,
    observation_count: (prior && prior.observation_count ? prior.observation_count : 0) + 1,
    last_run_id: 'operator-cli',
    last_execution_name: 'operator-cli',
    signals: { ...priorSignals }, // operator override doesn't increment a specific signal counter
  };

  const next = mergeCapabilityIntoRegistry(domains, bankCode, capability);
  safeWriteArtifact({
    path: DOMAINS,
    incoming: next,
    kind: 'registry-file',
    source: 'operator',
  });

  console.log(`marked ${bankCode} as ${verdict} (high confidence).`);
  console.log(`  reason: ${reason}`);
  console.log(`  observation_count now: ${capability.observation_count}`);
  console.log(`  first_observed:        ${capability.first_observed}`);
}

if (require.main === module) main();

module.exports = { main };
