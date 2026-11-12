'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectChallenge } = require('../../../lib/fetch/challenge_detect');

test('returns challenged=false for a normal rate page with a table', () => {
  const r = detectChallenge({
    html: '<html><body><table><tr><th>Tenure</th><th>Rate</th></tr><tr><td>1y</td><td>6.5%</td></tr></table></body></html>',
    status: 200,
  });
  assert.equal(r.challenged, false);
  assert.equal(r.vendor, null);
  assert.equal(r.signal, null);
});

test('detects cloudflare "Just a moment" challenge', () => {
  const r = detectChallenge({
    html: '<html><body><h1>Just a moment...</h1><div id="cf-spinner"></div></body></html>',
    status: 200,
  });
  assert.equal(r.challenged, true);
  assert.equal(r.vendor, 'cloudflare');
  assert.match(r.signal, /body-match/);
});

test('detects cloudflare cf-chl-bypass marker', () => {
  const r = detectChallenge({
    html: '<html><script src="/cdn-cgi/challenge-platform/h/g/cf-chl-bypass/abc"></script></html>',
    status: 200,
  });
  assert.equal(r.challenged, true);
  assert.equal(r.vendor, 'cloudflare');
});

test('detects akamai "Pardon Our Interruption" challenge', () => {
  const r = detectChallenge({
    html: '<html><body><h1>Pardon Our Interruption</h1><p>Reference ID: 18.abc.123</p></body></html>',
    status: 200,
  });
  assert.equal(r.challenged, true);
  assert.equal(r.vendor, 'akamai');
});

test('detects cloudfront "Request blocked" response', () => {
  const r = detectChallenge({
    html: 'Request blocked. We can\'t connect to the server for this app or website at this time via cloudfront.',
    status: 403,
  });
  assert.equal(r.challenged, true);
  // body match fires before status — cloudfront wins
  assert.equal(r.vendor, 'cloudfront');
});

test('detects imperva incapsula', () => {
  const r = detectChallenge({
    html: '<html><body>Incapsula incident ID: 123-456</body></html>',
    status: 200,
  });
  assert.equal(r.challenged, true);
  assert.equal(r.vendor, 'imperva');
});

test('detects generic Attention Required WAF page', () => {
  const r = detectChallenge({
    html: '<html><body><h1>Attention Required!</h1></body></html>',
    status: 200,
  });
  assert.equal(r.challenged, true);
  assert.equal(r.vendor, 'unknown_waf');
});

test('detects thin-body success (suspiciously small no-table 200)', () => {
  const r = detectChallenge({
    html: '<html><body><script>setTimeout(loadRates, 1000)</script></body></html>',
    status: 200,
  });
  assert.equal(r.challenged, true);
  assert.equal(r.vendor, 'unknown_waf');
  assert.match(r.signal, /thin-body/);
});

test('does NOT flag a normal-sized JS-only page with status 200', () => {
  // 6KB body, no table — but it's bigger than the threshold so we let fetch_html
  // try the wait-for-tables path before deciding it's a challenge.
  const r = detectChallenge({
    html: '<html><body>' + 'x'.repeat(6000) + '<div id="root"></div></body></html>',
    status: 200,
  });
  assert.equal(r.challenged, false);
});

test('flags HTTP 403 even with empty body', () => {
  const r = detectChallenge({ html: '', status: 403 });
  assert.equal(r.challenged, true);
  assert.equal(r.signal, 'http-403');
});

test('flags HTTP 429 rate-limit', () => {
  const r = detectChallenge({ html: '', status: 429 });
  assert.equal(r.challenged, true);
  assert.match(r.signal, /429/);
});

test('does NOT flag HTTP 404 (not a challenge — bank-side page missing)', () => {
  // 404 is the bank's problem, not a WAF. fetch_html records the failure
  // and moves on; jumping to stealth wouldn't help.
  const r = detectChallenge({ html: '<html><body>Page not found</body></html>', status: 404 });
  assert.equal(r.challenged, false);
});

test('does NOT flag HTTP 500', () => {
  const r = detectChallenge({ html: '<html><body>Internal Server Error</body></html>', status: 500 });
  assert.equal(r.challenged, false);
});

test('header server=cloudflare WITH 4xx flags as cloudflare', () => {
  const r = detectChallenge({
    html: '',
    status: 503,
    headers: { server: 'cloudflare' },
  });
  assert.equal(r.challenged, true);
  assert.equal(r.vendor, 'cloudflare');
});

test('header server=cloudflare WITH 200 does NOT flag (just normal CF-fronted bank)', () => {
  const r = detectChallenge({
    html: '<html><body><table><tr><td>1y</td><td>6.5%</td></tr></table></body></html>',
    status: 200,
    headers: { server: 'cloudflare' },
  });
  assert.equal(r.challenged, false);
});

test('honors explicit bodySize override (e.g., for tests with truncated html string)', () => {
  // Body string is short for the test, but the actual response was large.
  const r = detectChallenge({
    html: '<html></html>',
    status: 200,
    bodySize: 100_000,
  });
  // 100KB body without a <table> doesn't trigger thin-body — but no signal pattern matches either.
  assert.equal(r.challenged, false);
});

test('signal ordering: cloudflare beats generic Attention Required', () => {
  // If both match, the more specific (earlier in SIGNAL_PATTERNS) wins.
  const r = detectChallenge({
    html: '<html><body>Just a moment Attention Required! cf-chl-bypass</body></html>',
    status: 200,
  });
  assert.equal(r.vendor, 'cloudflare');
});

test('empty input does not throw — returns a well-formed result', () => {
  // Empty html with default status=200 triggers the thin-body signal (legitimately —
  // a 0-byte 200 IS suspicious). Just assert the function returned a shape.
  const r = detectChallenge({});
  assert.equal(typeof r.challenged, 'boolean');
  assert.ok('vendor' in r);
  assert.ok('signal' in r);
});

test('non-string html is treated as empty without throwing', () => {
  const r = detectChallenge({ html: null, status: 200 });
  // null html → empty body → thin-body signal fires (correct).
  // Important assertion is: no throw, well-formed result.
  assert.equal(typeof r.challenged, 'boolean');
});
