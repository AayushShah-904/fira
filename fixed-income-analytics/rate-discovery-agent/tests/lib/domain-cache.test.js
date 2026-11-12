'use strict';

/**
 * Tests for lib/domain-cache.js — focused on the operator-curated-field
 * preservation behavior added in Sprint 002 #5 after Phase B revealed that
 * the agent's updateDomainEntry was clobbering operator-curated metadata
 * (extraction_method, rate_pdfs, last_discovered_at, etc.).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { updateDomainEntry } = require('../../lib/domain-cache');

const tmpDirs = [];

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-cache-test-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

test('preserves operator-curated extraction_method on a fresh agent run', async () => {
  const projectRoot = makeProject();
  const domainsFile = path.join(projectRoot, 'data', 'bank-domains.json');

  // Operator-curated entry — has extraction_method, rate_pdfs, confidence
  fs.writeFileSync(domainsFile, JSON.stringify({
    'bank-x': {
      domain: 'bankx.bank.in',
      rate_pages: { fd: '/rates' },
      scraper_type: 'html_static',
      extraction_method: 'manual_image_transcription',
      confidence: 'high',
      last_discovered_at: '2026-05-12T00:00:00Z',
      rate_pdfs: [{ url: 'https://bankx.bank.in/rate.jpg', kind: 'rate_card_scanned_image' }],
      notes: 'Operator curated 2026-05-12.',
    },
  }, null, 2));

  await updateDomainEntry({
    bankCode: 'bank-x',
    config: {
      website: 'https://bankx.bank.in',
      scraper_type: 'html_static',
      rate_page_urls: { fd: 'https://bankx.bank.in/rates' },
    },
    domainsFile,
  });

  const after = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'))['bank-x'];
  assert.equal(after.extraction_method, 'manual_image_transcription', 'extraction_method preserved');
  assert.equal(after.confidence, 'high', 'confidence preserved');
  assert.equal(after.last_discovered_at, '2026-05-12T00:00:00Z', 'last_discovered_at preserved');
  assert.ok(Array.isArray(after.rate_pdfs), 'rate_pdfs preserved');
  assert.equal(after.rate_pdfs.length, 1);
  assert.equal(after.notes, 'Operator curated 2026-05-12.', 'notes preserved');
});

test('preserves discovery_status on operator-classified entries', async () => {
  const projectRoot = makeProject();
  const domainsFile = path.join(projectRoot, 'data', 'bank-domains.json');

  fs.writeFileSync(domainsFile, JSON.stringify({
    'bank-y': {
      domain: 'banky.bank.in',
      discovery_status: 'website_known_no_rate_page',
      scraper_type: 'manual',
      notes: 'Coming Soon on rate page.',
    },
  }, null, 2));

  // Note: this should never actually fire because the skip-gate would
  // short-circuit before discovery runs — but if anyone manually calls
  // updateDomainEntry, the field should still survive.
  await updateDomainEntry({
    bankCode: 'bank-y',
    config: {
      website: 'https://banky.bank.in',
      scraper_type: 'manual',
      rate_page_urls: {},
    },
    domainsFile,
  });

  const after = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'))['bank-y'];
  assert.equal(after.discovery_status, 'website_known_no_rate_page');
});

test('still merges new rate_pages into existing entries (non-null wins)', async () => {
  const projectRoot = makeProject();
  const domainsFile = path.join(projectRoot, 'data', 'bank-domains.json');

  fs.writeFileSync(domainsFile, JSON.stringify({
    'bank-z': {
      domain: 'bankz.bank.in',
      rate_pages: { fd: '/rates', fd_nre: null },
      scraper_type: 'html_static',
      notes: 'Original.',
    },
  }, null, 2));

  await updateDomainEntry({
    bankCode: 'bank-z',
    config: {
      website: 'https://bankz.bank.in',
      scraper_type: 'html_static',
      rate_page_urls: { fd: 'https://bankz.bank.in/rates', fd_nre: 'https://bankz.bank.in/nre-rates' },
    },
    domainsFile,
  });

  const after = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'))['bank-z'];
  assert.equal(after.rate_pages.fd, '/rates', 'existing fd preserved');
  assert.equal(after.rate_pages.fd_nre, '/nre-rates', 'new fd_nre filled in (was null)');
  assert.equal(after.notes, 'Original.', 'notes preserved');
});

test('routes registry write through safe-write atomically (no leftover .tmp files)', async () => {
  const projectRoot = makeProject();
  const dataDir = path.join(projectRoot, 'data');
  const domainsFile = path.join(dataDir, 'bank-domains.json');

  // Operator-curated entry — exercises the merge invariant alongside the atomic-write check
  fs.writeFileSync(domainsFile, JSON.stringify({
    'bank-atomic': {
      domain: 'bankatomic.bank.in',
      rate_pages: { fd: '/rates' },
      scraper_type: 'html_static',
      extraction_method: 'manual_image_transcription',
      confidence: 'high',
      notes: 'Operator curated.',
    },
  }, null, 2));

  await updateDomainEntry({
    bankCode: 'bank-atomic',
    config: {
      website: 'https://bankatomic.bank.in',
      scraper_type: 'html_static',
      rate_page_urls: { fd: 'https://bankatomic.bank.in/rates', fd_nre: 'https://bankatomic.bank.in/nre' },
    },
    domainsFile,
  });

  // Atomicity: no temp files should be left in the data directory
  const leftoverTmps = fs.readdirSync(dataDir).filter((f) => f.includes('.tmp.'));
  assert.deepEqual(leftoverTmps, [], 'no .tmp.* files left after safe-write rename');

  // Curated-field survival (re-verifies the spread-existing-first merge)
  const after = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'))['bank-atomic'];
  assert.equal(after.extraction_method, 'manual_image_transcription', 'extraction_method preserved through safe-write');
  assert.equal(after.confidence, 'high', 'confidence preserved through safe-write');
  assert.equal(after.notes, 'Operator curated.', 'notes preserved through safe-write');
  assert.equal(after.rate_pages.fd_nre, '/nre', 'new rate page filled in (merge worked)');
});

test('no-op when scraper_type is manual (no overwrite at all)', async () => {
  const projectRoot = makeProject();
  const domainsFile = path.join(projectRoot, 'data', 'bank-domains.json');
  fs.writeFileSync(domainsFile, JSON.stringify({
    'bank-w': { extraction_method: 'manual_image_transcription', notes: 'unchanged' },
  }, null, 2));

  await updateDomainEntry({
    bankCode: 'bank-w',
    config: { website: 'https://bankw.bank.in', scraper_type: 'manual', rate_page_urls: {} },
    domainsFile,
  });

  const after = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'))['bank-w'];
  assert.equal(after.extraction_method, 'manual_image_transcription');
  assert.equal(after.notes, 'unchanged');
});
