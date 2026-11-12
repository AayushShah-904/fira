'use strict';

/**
 * Tests for tier-router's selectDiscoveryAction (skip detection) and
 * registry-skip's writeSkipOutputs (synthetic output).
 *
 * Sprint 002 #5 — L6 codification.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { selectDiscoveryAction, TERMINAL_DISCOVERY_STATUSES, CURATED_EXTRACTION_METHODS } = require('../../lib/tier-router');
const { writeSkipOutputs } = require('../../lib/registry-skip');
const { classifyResult } = require('../../lib/failure-classifier');

const tmpDirs = [];

function makeProject(domains) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-test-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'bank-domains.json'), JSON.stringify(domains, null, 2));
  return dir;
}

function makeRunDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-rundir-'));
  tmpDirs.push(d);
  return d;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

test('TERMINAL_DISCOVERY_STATUSES enum is stable and includes the three terminal classifications', () => {
  assert.ok(TERMINAL_DISCOVERY_STATUSES.has('no_website_known'));
  assert.ok(TERMINAL_DISCOVERY_STATUSES.has('website_known_no_rate_page'));
  assert.ok(TERMINAL_DISCOVERY_STATUSES.has('pending_vision'));
});

test('CURATED_EXTRACTION_METHODS enum includes the manual paths', () => {
  assert.ok(CURATED_EXTRACTION_METHODS.has('manual_image_transcription'));
  assert.ok(CURATED_EXTRACTION_METHODS.has('manual_transcription_from_rendered_text'));
  assert.ok(CURATED_EXTRACTION_METHODS.has('manual_data_entry'));
  assert.ok(CURATED_EXTRACTION_METHODS.has('pending_vision'));
});

test('selectDiscoveryAction skips when extraction_method is curated, even without discovery_status', () => {
  const projectRoot = makeProject({
    'bank-curated': {
      domain: 'bank.in',
      rate_pages: { fd: '/rates' },
      extraction_method: 'manual_image_transcription',
      scraper_type: 'manual',
    },
  });
  const r = selectDiscoveryAction({ mode: 'discover', bankCode: 'bank-curated', projectRoot });
  assert.equal(r.skip, true);
  assert.match(r.reason, /extraction_method=manual_image_transcription/);
});

test('selectDiscoveryAction skips when extraction_method=pending_vision', () => {
  const projectRoot = makeProject({
    'bank-pending': {
      domain: 'bank.in',
      rate_pages: { fd: '/rates.pdf' },
      extraction_method: 'pending_vision',
      scraper_type: 'pdf',
    },
  });
  const r = selectDiscoveryAction({ mode: 'discover', bankCode: 'bank-pending', projectRoot });
  assert.equal(r.skip, true);
  assert.match(r.reason, /pending_vision/);
});

test('selectDiscoveryAction does NOT skip on a regular automatic extraction_method', () => {
  const projectRoot = makeProject({
    'bank-auto': {
      domain: 'bank.in',
      rate_pages: { fd: '/rates' },
      extraction_method: 'automatic_html',
      scraper_type: 'html_static',
    },
  });
  const r = selectDiscoveryAction({ mode: 'discover', bankCode: 'bank-auto', projectRoot });
  assert.notEqual(r.skip, true);
});

test('selectDiscoveryAction returns skip for no_website_known', () => {
  const projectRoot = makeProject({
    'bank-x': { discovery_status: 'no_website_known', confidence: 'high', notes: 'No web presence.' },
  });
  const r = selectDiscoveryAction({ mode: 'discover', bankCode: 'bank-x', projectRoot });
  assert.equal(r.skip, true);
  assert.equal(r.discovery_status, 'no_website_known');
  assert.equal(r.registryEntry.confidence, 'high');
});

test('selectDiscoveryAction returns skip for website_known_no_rate_page', () => {
  const projectRoot = makeProject({
    'bank-y': {
      discovery_status: 'website_known_no_rate_page',
      domain: 'example.bank.in',
      rate_pages: { fd: null },
      notes: 'Coming Soon page',
    },
  });
  const r = selectDiscoveryAction({ mode: 'discover', bankCode: 'bank-y', projectRoot });
  assert.equal(r.skip, true);
  assert.equal(r.discovery_status, 'website_known_no_rate_page');
});

test('selectDiscoveryAction does NOT skip in rates-only mode', () => {
  const projectRoot = makeProject({
    'bank-x': { discovery_status: 'no_website_known' },
  });
  const r = selectDiscoveryAction({ mode: 'rates-only', bankCode: 'bank-x', projectRoot });
  assert.notEqual(r.skip, true);
  assert.ok(typeof r.tier === 'number');
});

test('selectDiscoveryAction does NOT skip in expand-nri mode', () => {
  const projectRoot = makeProject({
    'bank-x': { discovery_status: 'no_website_known' },
  });
  const r = selectDiscoveryAction({ mode: 'expand-nri', bankCode: 'bank-x', projectRoot });
  assert.notEqual(r.skip, true);
});

test('selectDiscoveryAction falls through normally for banks without discovery_status', () => {
  const projectRoot = makeProject({
    'bank-z': { domain: 'real-bank.in', scraper_type: 'html_static' },
  });
  const r = selectDiscoveryAction({ mode: 'discover', bankCode: 'bank-z', projectRoot });
  assert.notEqual(r.skip, true);
  assert.equal(r.tier, 1);
});

test('selectDiscoveryAction does NOT skip on unrecognized discovery_status', () => {
  const projectRoot = makeProject({
    'bank-w': { discovery_status: 'pending_review' },
  });
  const r = selectDiscoveryAction({ mode: 'discover', bankCode: 'bank-w', projectRoot });
  assert.notEqual(r.skip, true);
});

test('writeSkipOutputs no_website_known writes rates + summary but no config', () => {
  const runDir = makeRunDir();
  const out = writeSkipOutputs({
    runDir,
    bankCode: 'bank-a',
    bankName: 'Bank A',
    bankType: 'DCCB',
    category: 'District Central Co-operative Bank',
    runLabel: 'r1',
    registryEntry: { discovery_status: 'no_website_known', confidence: 'high', notes: 'No web presence.' },
    discoveryStatus: 'no_website_known',
  });
  assert.equal(out.wroteConfig, false);
  assert.equal(out.wroteRates, true);
  assert.ok(!fs.existsSync(out.configPath));
  assert.ok(fs.existsSync(out.ratesPath));
  assert.ok(fs.existsSync(out.summaryPath));
});

test('writeSkipOutputs website_known_no_rate_page writes config + rates + summary', () => {
  const runDir = makeRunDir();
  const out = writeSkipOutputs({
    runDir,
    bankCode: 'bank-b',
    bankName: 'Bank B',
    bankType: 'DCCB',
    category: 'District Central Co-operative Bank',
    runLabel: 'r1',
    registryEntry: {
      discovery_status: 'website_known_no_rate_page',
      domain: 'bankb.bank.in',
      rate_pages: { fd: null },
      notes: 'Rate page shows Coming Soon.',
      confidence: 'high',
    },
    discoveryStatus: 'website_known_no_rate_page',
  });
  assert.equal(out.wroteConfig, true);
  const config = JSON.parse(fs.readFileSync(out.configPath, 'utf-8'));
  assert.equal(config.website, 'https://bankb.bank.in');
  assert.equal(config.scraper_type, 'manual');
  assert.equal(config.rate_page_urls.fd, null);
  assert.equal(config.discovery_metadata.discovery_method, 'registry_skip');
});

test('writeSkipOutputs synthetic summary marks discovery_method', () => {
  const runDir = makeRunDir();
  const out = writeSkipOutputs({
    runDir,
    bankCode: 'bank-c',
    bankName: 'Bank C',
    runLabel: 'r1',
    registryEntry: { discovery_status: 'no_website_known' },
    discoveryStatus: 'no_website_known',
  });
  const summary = JSON.parse(fs.readFileSync(out.summaryPath, 'utf-8'));
  assert.equal(summary.discovery_method, 'registry_skip');
  assert.equal(summary.discovery_status, 'no_website_known');
  assert.equal(summary.tool_call_count, 0);
  assert.equal(summary.total_cost_usd, 0);
});

test('Classifier sees writeSkipOutputs no_website_known as discovery_failed', () => {
  const runDir = makeRunDir();
  writeSkipOutputs({
    runDir,
    bankCode: 'bank-d',
    bankName: 'Bank D',
    runLabel: 'r1',
    registryEntry: { discovery_status: 'no_website_known' },
    discoveryStatus: 'no_website_known',
  });
  const r = classifyResult({
    agentResult: { success: true },
    runDir,
    bankCode: 'bank-d',
    domainWasKnown: false,
    initialTier: 1,
    retryAttempted: false,
  });
  assert.equal(r.failure_class, 'discovery_failed');
  assert.equal(r.phase_outcomes.website, 'no_candidates');
});

test('writeSkipOutputs preserves operator-curated rates artifact and routes incoming to .pending.json', () => {
  const runDir = makeRunDir();
  const bankCode = 'bank-curated-rates';
  const ratesPath = path.join(runDir, `${bankCode}_rates.json`);

  // Pre-existing curated artifact (operator-transcribed from a JPG rate card).
  const curatedRates = {
    bank_code: bankCode,
    bank_name: 'Bank Curated',
    product_type: 'FD',
    variant: 'regular',
    effective_date: '2026-04-01',
    extraction_method: 'manual_image_transcription',
    extraction_confidence: 'high',
    rate_slabs: [
      { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 7.25, rate_senior_pct: 7.75, rate_super_senior_pct: null, deposit_range: 'below_3cr' },
    ],
    special_schemes: [],
    warnings: [],
    errors: [],
  };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(ratesPath, JSON.stringify(curatedRates, null, 2) + '\n');

  // Skip-gate writer fires (e.g., registry says discovery_status=no_website_known).
  writeSkipOutputs({
    runDir,
    bankCode,
    bankName: 'Bank Curated',
    runLabel: 'r1',
    registryEntry: { discovery_status: 'no_website_known' },
    discoveryStatus: 'no_website_known',
  });

  // Existing curated artifact must survive unchanged.
  const onDisk = JSON.parse(fs.readFileSync(ratesPath, 'utf-8'));
  assert.equal(onDisk.extraction_method, 'manual_image_transcription');
  assert.equal(onDisk.rate_slabs.length, 1);
  assert.equal(onDisk.rate_slabs[0].rate_general_pct, 7.25);

  // Incoming skip-gate payload must land at the pending sidecar.
  const pendingPath = ratesPath + '.pending.json';
  assert.ok(fs.existsSync(pendingPath), 'expected pending sidecar to exist');
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  assert.equal(pending.extraction_method, 'registry_skip');
  assert.equal(pending.rate_slabs.length, 0);
});

test('Classifier sees writeSkipOutputs website_known_no_rate_page as partial_success', () => {
  const runDir = makeRunDir();
  writeSkipOutputs({
    runDir,
    bankCode: 'bank-e',
    bankName: 'Bank E',
    runLabel: 'r1',
    registryEntry: {
      discovery_status: 'website_known_no_rate_page',
      domain: 'banke.bank.in',
      rate_pages: { fd: null },
      notes: 'Rate page Coming Soon.',
    },
    discoveryStatus: 'website_known_no_rate_page',
  });
  const r = classifyResult({
    agentResult: { success: true },
    runDir,
    bankCode: 'bank-e',
    domainWasKnown: true,
    initialTier: 1,
    retryAttempted: false,
  });
  assert.equal(r.failure_class, 'partial_success');
  assert.equal(r.phase_outcomes.website, 'found_committed');
  assert.equal(r.phase_outcomes.rate_page, 'not_found');
});
