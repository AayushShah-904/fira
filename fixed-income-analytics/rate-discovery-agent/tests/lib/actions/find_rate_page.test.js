'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findRatePage,
  _extractAnchors,
  _rankAnchors,
  _absoluteUrl,
  NO_NRI_BANK_TYPES,
  PRODUCT_PATTERNS,
} = require('../../../lib/actions/find_rate_page');

test('NRI products on a cooperative bank → not_applicable', async () => {
  const r = await findRatePage({
    domain: 'https://anycoop.bank.in',
    product: 'fd_nre',
    mode: 'discover',
    hints: { bank_type: 'SUCB' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error_class, 'not_applicable');
});

test('fd_gift is a valid product (IBU banks) — not gated by NRI eligibility', async () => {
  // fd_gift uses CLAUDE.md Step 2c (GIFT City IBU discovery). Not in
  // NRI_PRODUCTS, so the cooperative gate does not fire on it. The fetch
  // will fail on the fake URL, but the error_class must be "fetch_failed",
  // not "not_applicable" — proves fd_gift made it past validation.
  const r = await findRatePage({
    domain: 'https://nonexistent-ibu-test.invalid',
    product: 'fd_gift',
    mode: 'discover',
    hints: { bank_type: 'IBU' },
  });
  if (r.ok === false) {
    assert.notEqual(r.error_class, 'not_applicable');
  }
});

test('_rankAnchors: fd_gift matches "GIFT City" / "IFSC Banking Unit" anchors', () => {
  const anchors = [
    { href: '/about', text: 'About Us' },
    { href: '/gift-ifsc', text: 'GIFT City IFSC Deposits' },
    { href: '/ibu', text: 'IFSC Banking Unit' },
    { href: '/personal/fd', text: 'Domestic FD Rates' },
  ];
  const ranked = _rankAnchors(anchors, 'fd_gift');
  assert.ok(ranked.length > 0, 'should match at least one anchor');
  // The top-ranked anchor should mention GIFT or IFSC banking unit
  assert.match(ranked[0].text, /gift|ifsc\s*banking\s*unit/i);
});

test('NRI products on a PSB → not gated by eligibility (would proceed)', async () => {
  // This test doesn't make a real network call — we just verify the gate
  // does NOT fire for PSB. The subsequent fetch will fail because the URL
  // is fake, but the error_class will be "fetch_failed", not "not_applicable".
  const r = await findRatePage({
    domain: 'https://nonexistent-sbi-test.invalid',
    product: 'fd_nre',
    mode: 'discover',
    hints: { bank_type: 'PSB' },
  });
  // Either ok:true or ok:false with a non-eligibility reason
  if (r.ok === false) {
    assert.notEqual(r.error_class, 'not_applicable');
  }
});

test('throws on invalid product', async () => {
  await assert.rejects(
    findRatePage({ domain: 'https://x', product: 'savings_plus', mode: 'discover' }),
    /input.product must be one of/,
  );
});

test('throws on invalid mode', async () => {
  await assert.rejects(
    findRatePage({ domain: 'https://x', product: 'fd', mode: 'bogus' }),
    /input.mode must be one of/,
  );
});

test('_extractAnchors: parses href + text from <a> tags', () => {
  const html = `
    <div>
      <a href="/rates">Interest Rates</a>
      <a href="https://example.com/fd">Fixed Deposit</a>
      <a href="/nre">NRE Deposits</a>
    </div>
  `;
  const anchors = _extractAnchors(html);
  assert.equal(anchors.length, 3);
  assert.equal(anchors[0].href, '/rates');
  assert.equal(anchors[0].text, 'Interest Rates');
  assert.equal(anchors[2].text, 'NRE Deposits');
});

test('_rankAnchors: FD product prefers "Fixed Deposit" link over "Interest Rates"', () => {
  const anchors = [
    { href: '/rates', text: 'Interest Rates' },
    { href: '/fd', text: 'Fixed Deposit' },
  ];
  const ranked = _rankAnchors(anchors, 'fd');
  assert.equal(ranked[0].text, 'Fixed Deposit');
  assert.ok(ranked[0].score > ranked[1].score);
});

test('_rankAnchors: fd_nre matches "NRE Deposits"', () => {
  const anchors = [
    { href: '/savings', text: 'Savings Account' },
    { href: '/nre', text: 'NRE Deposits' },
  ];
  const ranked = _rankAnchors(anchors, 'fd_nre');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].text, 'NRE Deposits');
});

test('_rankAnchors: fd_fcnr matches "FCNR-B" anchor', () => {
  const anchors = [
    { href: '/fcnr-b', text: 'FCNR-B Deposits' },
  ];
  const ranked = _rankAnchors(anchors, 'fd_fcnr');
  assert.equal(ranked.length, 1);
});

test('_absoluteUrl: resolves relative href', () => {
  assert.equal(_absoluteUrl('https://test.in', '/rates'), 'https://test.in/rates');
});

test('_absoluteUrl: absolute href passes through', () => {
  assert.equal(_absoluteUrl('https://test.in', 'https://other.com/x'), 'https://other.com/x');
});

test('NO_NRI_BANK_TYPES contains expected categories', () => {
  for (const t of ['SUCB', 'NSUCB', 'SSCB', 'NSSCB', 'DCCB', 'RRB', 'PB', 'LAB']) {
    assert.ok(NO_NRI_BANK_TYPES.has(t), `${t} should be in NO_NRI_BANK_TYPES`);
  }
  assert.equal(NO_NRI_BANK_TYPES.has('PSB'), false);
  assert.equal(NO_NRI_BANK_TYPES.has('PVB'), false);
});
