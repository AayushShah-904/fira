'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findWebsite,
  _bankInVariants,
  _rankCandidates,
  _isAggregator,
  AGGREGATOR_DOMAINS,
} = require('../../../lib/actions/find_website');

test('throws on missing bank_name', async () => {
  await assert.rejects(
    findWebsite({ bank_type: 'PSB' }),
    /bank_name is required/,
  );
});

// Sprint 010 A2 (2026-06-09): missing bank_type no longer throws — it falls
// back to the 'UNKNOWN' sentinel so a registry-less bare-invocation discovery
// run still completes. Verifies the behaviour change is intentional, not a
// silent regression.
test('Sprint 010 A2: missing bank_type does NOT throw (uses UNKNOWN sentinel)', async () => {
  // We don't run the full network step; just verify the input validation
  // tolerates a missing bank_type. The function returns its own result shape
  // even on no-network failure (candidates_considered + null website).
  const r = await findWebsite({ bank_name: 'Nonexistent Bank Co-op Ltd', hints: {} });
  assert.ok(r, 'findWebsite should return a result, not throw, when bank_type is missing');
  assert.ok(Array.isArray(r.candidates_considered), 'result should include candidates_considered');
});

test('_bankInVariants: full slug + abbreviation produced', () => {
  const v = _bankInVariants('state-bank-of-india', 'State Bank of India');
  assert.ok(v.includes('https://state-bank-of-india.bank.in'));
  // Acronym attempt: "sbi" (filtering "Bank" / "of" / "the")
  assert.ok(v.some((u) => u === 'https://sbi.bank.in'));
});

test('_bankInVariants: -bank-limited suffix stripped', () => {
  const v = _bankInVariants('hdfc-bank-limited', 'HDFC Bank Limited');
  assert.ok(v.includes('https://hdfc-bank-limited.bank.in'));
  assert.ok(v.includes('https://hdfc.bank.in'));
});

test('_isAggregator: known aggregator hosts rejected', () => {
  for (const host of ['bankbazaar.com', 'paisabazaar.com', 'cleartax.in', 'groww.in', 'wikipedia.org']) {
    assert.ok(_isAggregator(host), `${host} should be aggregator`);
  }
});

test('_isAggregator: actual bank hosts NOT flagged', () => {
  for (const host of ['sbi.co.in', 'hdfc.bank.in', 'icicibank.com', 'pnb.bank.in']) {
    assert.equal(_isAggregator(host), false, `${host} should NOT be aggregator`);
  }
});

test('_isAggregator: aggregator subdomains rejected', () => {
  assert.equal(_isAggregator('m.bankbazaar.com'), true);
});

test('_rankCandidates: .bank.in beats .com', () => {
  const results = [
    { url: 'https://hdfcbank.com', snippet: '' },
    { url: 'https://hdfc.bank.in', snippet: '' },
  ];
  const ranked = _rankCandidates(results, 'HDFC Bank Limited', 'hdfc-bank-limited');
  assert.equal(ranked[0].host, 'hdfc.bank.in');
});

test('_rankCandidates: aggregator filtered out', () => {
  const results = [
    { url: 'https://bankbazaar.com/hdfc', snippet: '' },
    { url: 'https://hdfc.bank.in', snippet: '' },
  ];
  const ranked = _rankCandidates(results, 'HDFC Bank Limited', 'hdfc-bank-limited');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].host, 'hdfc.bank.in');
});

test('_rankCandidates: dedupe by host, keep highest score', () => {
  const results = [
    { url: 'https://hdfc.bank.in/about', snippet: '' },
    { url: 'https://hdfc.bank.in', snippet: '' },
    { url: 'https://hdfc.bank.in/contact', snippet: '' },
  ];
  const ranked = _rankCandidates(results, 'HDFC Bank Limited', 'hdfc-bank-limited');
  assert.equal(ranked.length, 1);
});

test('_rankCandidates: hostname matching slug gets bonus', () => {
  const a = _rankCandidates([{ url: 'https://random.com' }], 'Test Bank', 'test-bank');
  const b = _rankCandidates([{ url: 'https://test-bank.com' }], 'Test Bank', 'test-bank');
  // Both .com (TLD score 60), but b matches the slug
  assert.ok(b[0].score > a[0].score);
});

test('AGGREGATOR_DOMAINS includes the canonical Indian aggregators', () => {
  assert.ok(AGGREGATOR_DOMAINS.has('bankbazaar.com'));
  assert.ok(AGGREGATOR_DOMAINS.has('paisabazaar.com'));
  assert.ok(AGGREGATOR_DOMAINS.has('rbi.org.in'));  // regulator, not a bank
});

test('findWebsite returns candidates_considered metadata even on failure', async () => {
  // Use a clearly-bogus bank name. The action will fail (no .bank.in match,
  // no web-search configured in test env). But it should still surface
  // candidates_considered so the orchestrator can diagnose.
  const r = await findWebsite({
    bank_name: 'Nonexistent Test Bank Zzz',
    bank_type: 'PSB',
  });
  // Test env unlikely to find anything, but the contract is candidates_considered always present.
  assert.ok('candidates_considered' in r);
});
