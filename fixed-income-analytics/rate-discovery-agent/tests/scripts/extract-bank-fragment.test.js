'use strict';

/**
 * Tests for scripts/utils/extract-bank-fragment.js — Sprint 004 Track B / B2.
 *
 * Verifies the per-bank registry-fragment extraction used by uploadOneBank
 * to push a minimal slice of bank-domains.json after each completed bank.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractBankFragment } = require('../../scripts/utils/extract-bank-fragment');

const tmpDirs = [];

function makeDomainsFile(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-fragment-'));
  tmpDirs.push(root);
  const p = path.join(root, 'bank-domains.json');
  fs.writeFileSync(p, content);
  return p;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

test('extractBankFragment: returns null when domainsFile is missing', () => {
  assert.equal(extractBankFragment('/nonexistent/path.json', 'foo'), null);
});

test('extractBankFragment: returns null when bank is not in registry', () => {
  const p = makeDomainsFile(JSON.stringify({ 'state-bank-of-india': { domain: 'sbi.bank.in' } }));
  assert.equal(extractBankFragment(p, 'ghost-bank'), null);
});

test('extractBankFragment: returns null on empty args', () => {
  assert.equal(extractBankFragment(null, 'foo'), null);
  assert.equal(extractBankFragment('/some/path', null), null);
  assert.equal(extractBankFragment('/some/path', ''), null);
});

test('extractBankFragment: extracts entry + adds provenance _meta', () => {
  const entry = {
    domain: 'hdfc.bank.in',
    rate_pages: { fd: '/fd', fd_nre: '/nre', fd_nro: '/nro', fd_fcnr: '/fcnr' },
    scraper_type: 'html_js',
    notes: 'CloudFront WAF, needs Playwright',
  };
  const raw = JSON.stringify({ 'hdfc-bank-limited': entry, 'other-bank': { domain: 'other.bank.in' } }, null, 2);
  const p = makeDomainsFile(raw);

  const fragment = extractBankFragment(p, 'hdfc-bank-limited');
  assert.ok(fragment);
  assert.equal(fragment._meta.bank_code, 'hdfc-bank-limited');
  assert.equal(fragment._meta.source, 'bank-domains.json');
  assert.match(fragment._meta.extracted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // sha256 of the raw file content
  const expectedSha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  assert.equal(fragment._meta.source_sha, expectedSha);

  // Bank entry fields preserved verbatim
  assert.equal(fragment.domain, 'hdfc.bank.in');
  assert.equal(fragment.scraper_type, 'html_js');
  assert.deepEqual(fragment.rate_pages, entry.rate_pages);
  assert.equal(fragment.notes, entry.notes);
});

test('extractBankFragment: throws on invalid JSON in domainsFile', () => {
  const p = makeDomainsFile('{ this is: not valid json');
  assert.throws(() => extractBankFragment(p, 'foo'), /not valid JSON/);
});

test('extractBankFragment: returns null for non-object entry (defensive)', () => {
  const p = makeDomainsFile(JSON.stringify({ 'weird-bank': 'just a string, not an object' }));
  assert.equal(extractBankFragment(p, 'weird-bank'), null);
});

test('extractBankFragment: sha256 changes when source content changes', () => {
  const p1 = makeDomainsFile(JSON.stringify({ 'x': { domain: 'x.bank.in', v: 1 } }));
  const p2 = makeDomainsFile(JSON.stringify({ 'x': { domain: 'x.bank.in', v: 2 } }));
  const f1 = extractBankFragment(p1, 'x');
  const f2 = extractBankFragment(p2, 'x');
  assert.notEqual(f1._meta.source_sha, f2._meta.source_sha);
});
