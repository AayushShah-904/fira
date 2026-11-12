'use strict';

/**
 * Tests for the foreign_currency_not_inr discovery_status skip
 * (Sprint 009 Phase 9.4, 2026-06-05).
 *
 * AB Bank PLC's bank-domains entry sets discovery_status: foreign_currency_not_inr
 * because abbl.com publishes BDT FD rates, not INR. Pre-9.4 the cohort
 * processed it anyway, wasting LLM budget and adding a fake failure to
 * the totals. Post-9.4 the tier-router skips at discovery time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { selectDiscoveryAction } = require('../../lib/tier-router');

function makeTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-fcn-'));
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  return tmp;
}

function writeRegistry(projectRoot, entries) {
  const file = path.join(projectRoot, 'data', 'bank-domains.json');
  // safe-write-exempt: temp fixture for unit test (ADR-012 tests-use-fs carve-out).
  fs.writeFileSync(file, JSON.stringify(entries));
}

test('foreign_currency_not_inr discovery_status triggers tier-router skip', () => {
  const root = makeTmpProject();
  writeRegistry(root, {
    'ab-bank-plc': {
      domain: 'abbl.com',
      discovery_status: 'foreign_currency_not_inr',
      notes: 'AB Bank PLC is Bangladeshi; abbl.com publishes BDT rates, not INR.',
    },
  });
  const action = selectDiscoveryAction({
    mode: 'discover',
    bankCode: 'ab-bank-plc',
    bankType: 'FB',
    isIBU: false,
    projectRoot: root,
  });
  assert.equal(action.skip, true, 'must skip a foreign_currency_not_inr bank');
  assert.match(action.reason, /foreign_currency_not_inr/);
  assert.equal(action.discovery_status, 'foreign_currency_not_inr');
});

test('regression guard: no_website_known still triggers skip (existing behavior)', () => {
  const root = makeTmpProject();
  writeRegistry(root, {
    'fake-bank': { domain: null, discovery_status: 'no_website_known' },
  });
  const action = selectDiscoveryAction({
    mode: 'discover',
    bankCode: 'fake-bank',
    bankType: 'SUCB',
    isIBU: false,
    projectRoot: root,
  });
  assert.equal(action.skip, true);
});

test('regression guard: ordinary bank (no discovery_status) does not skip', () => {
  const root = makeTmpProject();
  writeRegistry(root, {
    'fake-bank': { domain: 'fake.bank.in', scraper_type: 'html_static' },
  });
  const action = selectDiscoveryAction({
    mode: 'discover',
    bankCode: 'fake-bank',
    bankType: 'PSB',
    isIBU: false,
    projectRoot: root,
  });
  assert.notEqual(action.skip, true,
    'ordinary banks without discovery_status must continue through normal discovery');
});
