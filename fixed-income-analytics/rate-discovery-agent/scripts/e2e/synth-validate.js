#!/usr/bin/env node
'use strict';

/**
 * Sprint 009 Phase 6 — synthetic E2E validation harness.
 *
 * Exercises the full Phase 4 (split) + Phase 5 (merge) chain against
 * fixture data, in a tmp project root, with no cloud / AOAI calls.
 *
 * Purpose: prove the plumbing works end-to-end on every commit, without
 * the cost / time / blast-radius of a real 500-bank cohort. The real
 * 500-bank validation is operator-driven; see
 * container-mgmt/doc/runbook-split-cohort-500bank.md.
 *
 * Assertions exit codes:
 *   0   all asserts passed
 *   1   at least one assertion failed (details on stderr)
 *   2   harness setup failed (tmp dir, fixtures)
 *
 * Usage:
 *   node scripts/e2e/synth-validate.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const { splitCohort } = require('../../lib/cohort/splitter');
const { runMerger } = require('../../lib/merge/run-merger');
const { isFresh } = require('../../lib/cloud-block/registry-updater');

const NOW = new Date('2026-06-04T12:00:00Z').toISOString();

function fresh(daysAgo) {
  return new Date(Date.parse(NOW) - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function setupTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-validate-'));
  fs.mkdirSync(path.join(root, 'output', 'latest'), { recursive: true });
  fs.mkdirSync(path.join(root, 'output', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'cohorts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'peer-runs'), { recursive: true });
  return root;
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // safe-write-exempt: synthetic E2E fixture writes into a tmp project root (os.tmpdir), not the real output/latest/ or data/. Per ADR-012's "tests / fixtures legitimately use fs.writeFileSync" carve-out.
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
}

function slabs(n, base = 7.0) {
  return Array.from({ length: n }, (_, i) => ({
    tenure_text: `slab-${i}`,
    tenure_min_days: i + 1,
    tenure_max_days: i + 10,
    rate_general_pct: +(base + i * 0.05).toFixed(2),
  }));
}

function ratesArtifact({ bankCode, slabCount, extraction_method = 'llm_inline_extraction', extraction_confidence = 'medium', variant = 'regular', baseRate = 7.0 }) {
  return {
    bank_code: bankCode,
    product_type: 'FD',
    variant,
    source_url: `https://${bankCode}.in/fd`,
    extraction_method,
    extraction_confidence,
    scraped_at: '2026-06-04T10:00:00Z',
    effective_date: '2026-06-04',
    rate_slabs: slabs(slabCount, baseRate),
    warnings: [],
  };
}

function stage(name) {
  console.log(`\n── ${name} ──────────────────────────`);
}

function passCheck(label) { console.log(`  ✓ ${label}`); }
function failCheck(label, err) {
  console.error(`  ✗ ${label}\n    ${err.message || err}`);
  process.exitCode = 1;
}

// ── Fixture build ──────────────────────────────────────────────────────

function buildFixtures(root) {
  // 6 banks total:
  //  - 3 clean (route to cloud — no block, no entry, stale block)
  //  - 3 blocked (route to local — high confidence, medium confidence)
  const domains = {
    'clean-1': { domain: 'clean1.in' },
    'clean-2-stale': { domain: 'clean2.in', cloud_block_status: { blocked: true, last_observed: fresh(90), confidence: 'high' } },
    'clean-3-low': { domain: 'clean3.in', cloud_block_status: { blocked: true, last_observed: fresh(1), confidence: 'low' } },
    'blocked-1': { domain: 'b1.in', cloud_block_status: { blocked: true, last_observed: fresh(1), confidence: 'high' } },
    'blocked-2': { domain: 'b2.in', cloud_block_status: { blocked: true, last_observed: fresh(2), confidence: 'medium' } },
    'blocked-3': { domain: 'b3.in', cloud_block_status: { blocked: true, last_observed: fresh(1), confidence: 'high' } },
  };
  writeJson(path.join(root, 'data', 'bank-domains.json'), domains);

  const cohort = Object.keys(domains).map((bc) => ({ bank_code: bc, category: '', state: '' }));
  writeJson(path.join(root, 'data', 'cohorts', 'synth-6.json'), cohort);

  return { domains, cohort };
}

// ── Stages ─────────────────────────────────────────────────────────────

function stageSplit(root, { domains, cohort }) {
  stage('Stage 1: Splitter');
  const result = splitCohort({ entries: cohort, domains, now: Date.parse(NOW) });

  try {
    assert.strictEqual(result.cloud.length, 3, `cloud cohort size; got cloud=${result.cloud.map(e => e.bank_code).join(',')}`);
    passCheck('cloud cohort has 3 banks (clean-1, clean-2-stale, clean-3-low)');
  } catch (err) { failCheck('cloud cohort size', err); }

  try {
    assert.strictEqual(result.local.length, 3, `local cohort size; got local=${result.local.map(e => e.bank_code).join(',')}`);
    passCheck('local cohort has 3 banks (blocked-1, blocked-2, blocked-3)');
  } catch (err) { failCheck('local cohort size', err); }

  // Persist the sub-cohorts + beacon so a real merge-runs CLI could consume them.
  writeJson(path.join(root, 'data', 'cohorts', 'synth-6-cloud.json'), result.cloud);
  writeJson(path.join(root, 'data', 'cohorts', 'synth-6-local.json'), result.local);
  writeJson(path.join(root, 'data', 'peer-runs', 'synth-6.json'), {
    cohort: 'synth-6', split_at: NOW,
    cloud_cohort: 'synth-6-cloud', local_cohort: 'synth-6-local',
    cloud_run_label: 'cloud-synth-2026', local_run_label: 'local-synth-2026',
  });

  return { cloudCohort: result.cloud, localCohort: result.local };
}

function stageSimulateRuns(root, { cloudCohort, localCohort }) {
  stage('Stage 2: Simulate cloud + local runs');
  const cloudDir = path.join(root, 'output', 'runs', 'cloud-synth-2026');
  const localDir = path.join(root, 'output', 'runs', 'local-synth-2026');

  // Cloud-side: write rates for every cloud-cohort bank with varying slab counts.
  //   clean-1: 20 slabs (will be the only side; cloud-only)
  //   clean-2-stale: 18 slabs (cloud-only)
  //   clean-3-low: 22 slabs (cloud-only)
  writeJson(path.join(cloudDir, 'clean-1_rates.json'), ratesArtifact({ bankCode: 'clean-1', slabCount: 20 }));
  writeJson(path.join(cloudDir, 'clean-2-stale_rates.json'), ratesArtifact({ bankCode: 'clean-2-stale', slabCount: 18 }));
  writeJson(path.join(cloudDir, 'clean-3-low_rates.json'), ratesArtifact({ bankCode: 'clean-3-low', slabCount: 22 }));

  // Local-side: write rates for every local-cohort bank.
  //   blocked-1: 15 slabs, manual_image_transcription (curated)
  //   blocked-2: 12 slabs, llm
  //   blocked-3: 5 slabs, llm
  writeJson(path.join(localDir, 'blocked-1_rates.json'), ratesArtifact({ bankCode: 'blocked-1', slabCount: 15, extraction_method: 'manual_image_transcription', extraction_confidence: 'high' }));
  writeJson(path.join(localDir, 'blocked-2_rates.json'), ratesArtifact({ bankCode: 'blocked-2', slabCount: 12 }));
  writeJson(path.join(localDir, 'blocked-3_rates.json'), ratesArtifact({ bankCode: 'blocked-3', slabCount: 5 }));

  // To exercise the richer-set-wins rule + the curated-protection rule,
  // also write OVERLAPPING data for clean-1 on the LOCAL side — simulating
  // a case where the operator re-ran cohort and the same bank landed in both.
  // Local has 30 slabs (richer), so the merge should pick local's.
  writeJson(path.join(localDir, 'clean-1_rates.json'), ratesArtifact({ bankCode: 'clean-1', slabCount: 30, baseRate: 7.5 }));

  // Curated-protection scenario: plant an existing operator-curated artifact at
  // output/latest/ that should NOT be clobbered by the merge.
  writeJson(path.join(root, 'output', 'latest', 'blocked-1_rates.json'), {
    bank_code: 'blocked-1',
    product_type: 'FD',
    variant: 'regular',
    extraction_method: 'manual_image_transcription', // curated → ADR-012 protects
    rate_slabs: slabs(15, 7.5),
    warnings: ['operator-curated; merger must not clobber'],
  });

  passCheck('cloud-side artifacts written: 3 + 1-overlap');
  passCheck('local-side artifacts written: 3');
  passCheck('curated existing artifact planted at output/latest/blocked-1_rates.json');

  return { cloudCohort, localCohort, cloudRunLabel: 'cloud-synth-2026', localRunLabel: 'local-synth-2026' };
}

function stageMerge(root, { cloudCohort, localCohort, cloudRunLabel, localRunLabel }) {
  stage('Stage 3: Merge');
  const { banks, summary } = runMerger({
    cloudCohort, localCohort, cloudRunLabel, localRunLabel, projectRoot: root,
  });

  try {
    assert.strictEqual(summary.total_banks, 6);
    passCheck(`merger walked all 6 banks (cloud+local union)`);
  } catch (err) { failCheck('total_banks', err); }

  try {
    // 5 should write cleanly + 1 should defer (blocked-1 has curated planted)
    assert.strictEqual(summary.files_deferred_to_pending, 1, 'curated blocked-1 should defer');
    passCheck(`exactly 1 file deferred to .pending (curated blocked-1 protected)`);
  } catch (err) { failCheck('files_deferred_to_pending', err); }

  try {
    assert.strictEqual(summary.files_written, 5, 'remaining 5 should write');
    passCheck(`5 files written (3 cloud-only + 1 local-only + 1 both-sides for clean-1)`);
  } catch (err) { failCheck('files_written', err); }

  return { banks, summary };
}

function stageAssertions(root) {
  stage('Stage 4: Anti-regression assertions');

  // Assertion A: richer-set-wins on the overlapping clean-1 bank.
  //   Cloud had 20, local had 30 → merged should have 30.
  try {
    const merged = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', 'clean-1_rates.json'), 'utf-8'));
    assert.strictEqual(merged.rate_slabs.length, 30, 'local richer-set should win');
    passCheck(`A: clean-1 merged file has 30 slabs (local richer-set wins; not clobbered with cloud's 20)`);
  } catch (err) { failCheck('A: richer-set-wins on clean-1', err); }

  // Assertion B: provenance source_runs[] on the overlapping bank lists both.
  try {
    const merged = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', 'clean-1_rates.json'), 'utf-8'));
    assert.ok(Array.isArray(merged.source_runs), 'source_runs is array');
    assert.strictEqual(merged.source_runs.length, 2, 'both sides contributed');
    const sources = new Set(merged.source_runs.map((r) => r.source));
    assert.ok(sources.has('cloud'));
    assert.ok(sources.has('local'));
    passCheck(`B: clean-1 source_runs lists both cloud + local`);
  } catch (err) { failCheck('B: provenance on overlapping bank', err); }

  // Assertion C: curated protection — blocked-1 NOT overwritten, .pending exists.
  try {
    const curated = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', 'blocked-1_rates.json'), 'utf-8'));
    assert.strictEqual(curated.extraction_method, 'manual_image_transcription', 'curated method preserved');
    assert.ok(curated.warnings && curated.warnings.some((w) => /operator-curated/.test(w)), 'curated warning preserved');
    assert.ok(fs.existsSync(path.join(root, 'output', 'latest', 'blocked-1_rates.json.pending.json')), '.pending sidecar exists');
    passCheck(`C: blocked-1 curated artifact NOT clobbered; merger incoming routed to .pending`);
  } catch (err) { failCheck('C: ADR-012 curated protection', err); }

  // Assertion D: cloud-only banks have cloud-only provenance.
  try {
    for (const bc of ['clean-2-stale', 'clean-3-low']) {
      const merged = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', `${bc}_rates.json`), 'utf-8'));
      assert.strictEqual(merged.source_runs.length, 1, `${bc} single-source`);
      assert.strictEqual(merged.source_runs[0].source, 'cloud');
    }
    passCheck(`D: cloud-only banks (clean-2-stale, clean-3-low) carry cloud-only provenance`);
  } catch (err) { failCheck('D: cloud-only provenance', err); }

  // Assertion E: local-only banks have local-only provenance.
  try {
    for (const bc of ['blocked-2', 'blocked-3']) {
      const merged = JSON.parse(fs.readFileSync(path.join(root, 'output', 'latest', `${bc}_rates.json`), 'utf-8'));
      assert.strictEqual(merged.source_runs.length, 1, `${bc} single-source`);
      assert.strictEqual(merged.source_runs[0].source, 'local');
    }
    passCheck(`E: local-only banks (blocked-2, blocked-3) carry local-only provenance`);
  } catch (err) { failCheck('E: local-only provenance', err); }

  // Assertion F: total slab count meets expected.
  //   clean-1=30 (local richer) + clean-2-stale=18 (cloud) + clean-3-low=22 (cloud)
  //   + blocked-1=15 (curated preserved at 15) + blocked-2=12 (local) + blocked-3=5 (local)
  //   = 30 + 18 + 22 + 15 + 12 + 5 = 102
  try {
    let total = 0;
    for (const bc of ['clean-1', 'clean-2-stale', 'clean-3-low', 'blocked-1', 'blocked-2', 'blocked-3']) {
      const f = path.join(root, 'output', 'latest', `${bc}_rates.json`);
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
      total += Array.isArray(j.rate_slabs) ? j.rate_slabs.length : 0;
    }
    assert.strictEqual(total, 102, `total slab count across 6 merged files`);
    passCheck(`F: total slab count = 102 (matches expected from richer-set + curated-protection rules)`);
  } catch (err) { failCheck('F: total slab count', err); }
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  console.log('Sprint 009 Phase 6 — synthetic E2E validation');
  console.log('Exercises Phase 4 (split) + Phase 5 (merge) against fixture data.');
  console.log('No cloud / AOAI calls. Tmp dir; cleaned up implicitly when process exits.\n');

  let root;
  try {
    root = setupTmpRoot();
    console.log(`Tmp root: ${root}`);
  } catch (err) {
    console.error(`setup failed: ${err.message}`);
    process.exit(2);
  }

  try {
    const fixtures = buildFixtures(root);
    const split = stageSplit(root, fixtures);
    const runs = stageSimulateRuns(root, split);
    stageMerge(root, runs);
    stageAssertions(root);

    console.log('\n──────────────────────────────────────────────────────────────');
    if (process.exitCode === 1) {
      console.error('FAIL — at least one assertion failed (details above).');
      process.exit(1);
    }
    console.log('PASS — all assertions passed.');
    console.log('──────────────────────────────────────────────────────────────');
    process.exit(0);
  } catch (err) {
    console.error(`harness threw: ${err.stack || err.message}`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { setupTmpRoot, buildFixtures, ratesArtifact, slabs };
