'use strict';

/**
 * Tests for lib/actions/commit_to_registry.js — Sprint 003 #1b (A7).
 *
 * Coverage:
 *   - Happy path: writes a new entry; wrote:true.
 *   - No-change: same content → wrote:false, reason:"no_change".
 *   - Skipped: no website / manual scraper_type → wrote:false, reason populated.
 *   - Full-URL pass-through for rate_pages (agent's natural emission).
 *   - Relative-path rate_pages reconstructed with domain.
 *   - Input contract violations throw.
 *   - Slug discipline (non-canonical input.bank_code rejected).
 *   - Synthetic-config helper smoke-tests.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { commitToRegistry, buildSyntheticConfig } = require('../../../lib/actions/commit_to_registry');

const tmpDirs = [];
function makeDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-registry-test-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

const silentLogger = { warn: () => {}, info: () => {}, debug: () => {} };

function emptyDomainsFile() {
  const d = makeDir();
  const f = path.join(d, 'bank-domains.json');
  fs.writeFileSync(f, '{}\n');
  return f;
}

// ── Happy path ─────────────────────────────────────────────────────────

test('happy path: new entry → wrote:true with rate_pages stripped to paths', async () => {
  const f = emptyDomainsFile();
  const result = await commitToRegistry({
    bank_code: 'state-bank-of-india',
    updates: {
      domain: 'https://sbi.co.in',
      scraper_type: 'html_static',
      rate_pages: {
        fd: 'https://sbi.co.in/web/interest-rates/deposit-rates/retail-domestic-term-deposits',
        fd_nre: 'https://sbi.co.in/web/interest-rates/deposit-rates/nre-term-deposits',
      },
      confidence: 'high',
      discovery_metadata: { discovered_at: '2026-05-16T00:00:00Z', discovery_method: 'web_search' },
    },
    domains_file: f,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
  assert.equal(result.deferred_to_pending, false);

  const entry = JSON.parse(fs.readFileSync(f, 'utf-8'))['state-bank-of-india'];
  assert.equal(entry.domain, 'sbi.co.in');
  assert.equal(entry.scraper_type, 'html_static');
  // rate_pages stored as relative paths
  assert.equal(entry.rate_pages.fd, '/web/interest-rates/deposit-rates/retail-domestic-term-deposits');
  assert.equal(entry.rate_pages.fd_nre, '/web/interest-rates/deposit-rates/nre-term-deposits');
});

test('happy path: relative rate_pages reconstructed with domain', async () => {
  const f = emptyDomainsFile();
  const result = await commitToRegistry({
    bank_code: 'test-bank',
    updates: {
      domain: 'testbank.in',  // no scheme
      scraper_type: 'html_static',
      rate_pages: { fd: '/rates/fd' },  // relative
    },
    domains_file: f,
    logger: silentLogger,
  });
  assert.equal(result.wrote, true);
  const entry = JSON.parse(fs.readFileSync(f, 'utf-8'))['test-bank'];
  assert.equal(entry.domain, 'testbank.in');
  assert.equal(entry.rate_pages.fd, '/rates/fd');
});

// ── No-change short-circuit ────────────────────────────────────────────

test('no-change: second identical call → wrote:false, reason:"no_change"', async () => {
  const f = emptyDomainsFile();
  const updates = {
    domain: 'https://test.in',
    scraper_type: 'html_static',
    rate_pages: { fd: 'https://test.in/rates' },
  };
  const first = await commitToRegistry({ bank_code: 'test-bank', updates, domains_file: f, logger: silentLogger });
  assert.equal(first.wrote, true);
  const second = await commitToRegistry({ bank_code: 'test-bank', updates, domains_file: f, logger: silentLogger });
  assert.equal(second.wrote, false);
  assert.equal(second.reason, 'no_change');
});

// ── Skipped (no merge) ─────────────────────────────────────────────────

test('skip: no website → wrote:false, reason populated', async () => {
  const f = emptyDomainsFile();
  const result = await commitToRegistry({
    bank_code: 'test-bank',
    updates: { scraper_type: 'html_static' }, // no domain
    domains_file: f,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.wrote, false);
  assert.match(result.reason, /no website|manual|domain/i);
  // File untouched (still {})
  assert.equal(fs.readFileSync(f, 'utf-8').trim(), '{}');
});

test('skip: manual scraper_type → wrote:false, reason populated', async () => {
  const f = emptyDomainsFile();
  const result = await commitToRegistry({
    bank_code: 'test-bank',
    updates: { domain: 'https://test.in', scraper_type: 'manual' },
    domains_file: f,
    logger: silentLogger,
  });
  assert.equal(result.wrote, false);
  assert.match(result.reason, /manual/);
});

// ── Existing-non-null-wins merge (updateDomainEntry semantics) ─────────

test('existing non-null fields preserved when merging', async () => {
  const f = emptyDomainsFile();
  // Seed an entry with a curated note + domain
  fs.writeFileSync(f, JSON.stringify({
    'test-bank': {
      domain: 'curated-test.in',
      scraper_type: 'html_static',
      rate_pages: { fd: '/curated/path' },
      notes: 'operator curated 2024-01-01',
    },
  }, null, 2) + '\n');

  // Agent tries to "discover" a different domain — should not overwrite
  const result = await commitToRegistry({
    bank_code: 'test-bank',
    updates: {
      domain: 'https://discovered-test.in',
      scraper_type: 'html_js',
      rate_pages: { fd_nre: 'https://discovered-test.in/nre' },
    },
    domains_file: f,
    logger: silentLogger,
  });
  // wrote may be true (fd_nre was added) but curated fields preserved
  const entry = JSON.parse(fs.readFileSync(f, 'utf-8'))['test-bank'];
  assert.equal(entry.domain, 'curated-test.in', 'curated domain preserved');
  assert.equal(entry.scraper_type, 'html_static', 'curated scraper_type preserved');
  assert.equal(entry.rate_pages.fd, '/curated/path', 'curated rate_pages.fd preserved');
  assert.equal(entry.notes, 'operator curated 2024-01-01', 'notes preserved');
});

// ── Input contract violations ──────────────────────────────────────────

test('throws on missing bank_code', async () => {
  await assert.rejects(
    commitToRegistry({ updates: {}, domains_file: 'x' }),
    /bank_code is required/,
  );
});

test('throws on non-canonical bank_code', async () => {
  await assert.rejects(
    commitToRegistry({ bank_code: 'State Bank of India', updates: {}, domains_file: 'x' }),
    /not canonical/,
  );
});

test('throws on missing updates', async () => {
  await assert.rejects(
    commitToRegistry({ bank_code: 'test-bank', domains_file: 'x' }),
    /updates must be an object/,
  );
});

test('throws on missing domains_file', async () => {
  await assert.rejects(
    commitToRegistry({ bank_code: 'test-bank', updates: {} }),
    /domains_file is required/,
  );
});

test('throws on invalid confidence', async () => {
  await assert.rejects(
    commitToRegistry({ bank_code: 'test-bank', updates: { confidence: 'extreme' }, domains_file: 'x' }),
    /confidence must be one of/,
  );
});

// ── buildSyntheticConfig smoke tests ───────────────────────────────────

test('buildSyntheticConfig: prefixes https:// when domain is bare', () => {
  const c = buildSyntheticConfig({ domain: 'abbl.com' });
  assert.equal(c.website, 'https://abbl.com');
});

test('buildSyntheticConfig: keeps explicit scheme', () => {
  const c = buildSyntheticConfig({ domain: 'http://legacy.in' });
  assert.equal(c.website, 'http://legacy.in');
});

test('buildSyntheticConfig: maps explicit null in rate_pages (negative result)', () => {
  const c = buildSyntheticConfig({ domain: 'test.in', rate_pages: { fd_fcnr: null } });
  assert.equal(c.rate_page_urls.fd_fcnr, null);
});

test('buildSyntheticConfig: confidence folded into discovery_metadata', () => {
  const c = buildSyntheticConfig({
    confidence: 'high',
    discovery_metadata: { discovered_at: 'x', discovery_method: 'y' },
  });
  assert.equal(c.discovery_metadata.confidence, 'high');
  assert.equal(c.discovery_metadata.discovered_at, 'x');
});
