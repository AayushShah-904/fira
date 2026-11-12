'use strict';

/**
 * Tests for lib/failure-classifier.js — covers each branch of the two-tier
 * decision (phase_outcomes triple → failure_class rollup) against fixture
 * summary/config/rates JSON.
 *
 * Uses os.tmpdir() per test (never touches output/latest/).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyResult,
  FAILURE_CLASSES,
  WEBSITE_OUTCOMES,
  RATE_PAGE_OUTCOMES,
  EXTRACTION_OUTCOMES,
} = require('../../lib/failure-classifier');

const tmpDirs = [];

function makeRunDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcls-test-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

function writeFixture(runDir, slug, { config, rates, summary, attempt2Summary } = {}) {
  if (config) fs.writeFileSync(path.join(runDir, `${slug}_config.json`), JSON.stringify(config));
  if (rates) fs.writeFileSync(path.join(runDir, `${slug}_rates.json`), JSON.stringify(rates));
  if (summary) fs.writeFileSync(path.join(runDir, `${slug}.summary.json`), JSON.stringify(summary));
  if (attempt2Summary) fs.writeFileSync(path.join(runDir, `${slug}_attempt2.summary.json`), JSON.stringify(attempt2Summary));
}

const SUCCESS_AGENT = { success: true, finalText: 'done' };
const FAILED_AGENT = { success: false, finalText: 'rate limit' };

function callClassify(runDir, bank, opts = {}) {
  return classifyResult({
    agentResult: opts.agentResult || SUCCESS_AGENT,
    runDir,
    bankCode: bank,
    domainWasKnown: !!opts.domainWasKnown,
    initialTier: opts.initialTier || 1,
    retryAttempted: !!opts.retryAttempted,
  });
}

test('exports stable enums', () => {
  assert.ok(FAILURE_CLASSES.includes('success'));
  assert.ok(FAILURE_CLASSES.includes('partial_success'));
  assert.ok(FAILURE_CLASSES.includes('partial_silent'));  // Sprint 4 Track A 2026-05-20
  assert.ok(FAILURE_CLASSES.includes('discovery_failed'));
  assert.ok(FAILURE_CLASSES.includes('extraction_failed'));
  assert.ok(WEBSITE_OUTCOMES.includes('found_committed'));
  assert.ok(WEBSITE_OUTCOMES.includes('reachable_uncommitted'));
  assert.ok(RATE_PAGE_OUTCOMES.includes('found'));
  assert.ok(EXTRACTION_OUTCOMES.includes('succeeded'));
});

// ─── Sprint 4 Track A 2026-05-20: partial_silent (drift after MAX_ATTEMPTS) ───

function writeSilentMarker(runDir, slug, payload = {}) {
  const file = path.join(runDir, `${slug}.partial_silent.json`);
  fs.writeFileSync(file, JSON.stringify({
    bank_code: slug,
    reason: 'slab drift on regular: 19 < 0.8 * 84 (floor)',
    detected_at: new Date().toISOString(),
    attempts: 3,
    ...payload,
  }));
}

test('partial_silent: drift marker + successful extraction → partial_silent (not success)', () => {
  const runDir = makeRunDir();
  // Extraction technically succeeded (≥1 slab, high confidence) but the
  // run-discovery loop wrote a partial_silent marker because per-variant
  // counts stayed below the operator floor across all retries.
  writeFixture(runDir, 'pnb', {
    config: { website: 'https://pnb.bank.in', scraper_type: 'html_static', rate_page_urls: { fd: '/rates' } },
    rates: { rate_slabs: Array.from({ length: 19 }, () => ({})), extraction_confidence: 'high' },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  writeSilentMarker(runDir, 'pnb');
  const r = callClassify(runDir, 'pnb', { domainWasKnown: true });
  assert.equal(r.phase_outcomes.extraction, 'succeeded');
  assert.equal(r.failure_class, 'partial_silent');
  assert.equal(r.failure_signals.slab_drift_detected, true);
  assert.match(r.failure_signals.slab_drift_reason, /slab drift on regular/);
});

test('partial_silent: no marker present → ordinary success classification', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'pnb', {
    config: { website: 'https://pnb.bank.in', scraper_type: 'html_static', rate_page_urls: { fd: '/rates' } },
    rates: { rate_slabs: Array.from({ length: 84 }, () => ({})), extraction_confidence: 'high' },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  // No partial_silent.json marker → falls through to 'success'.
  const r = callClassify(runDir, 'pnb', { domainWasKnown: true });
  assert.equal(r.failure_class, 'success');
  assert.equal(r.failure_signals.slab_drift_detected, false);
});

test('partial_silent: marker + extraction_failed (0 slabs) → extraction_failed (not partial_silent)', () => {
  // Edge case: drift marker exists but somehow extraction is 0 slabs. The
  // partial_silent class only applies when extraction technically succeeded
  // — the failed-extraction class takes precedence.
  const runDir = makeRunDir();
  writeFixture(runDir, 'pnb', {
    config: { website: 'https://pnb.bank.in', scraper_type: 'html_static', rate_page_urls: { fd: '/rates' } },
    rates: { rate_slabs: [], extraction_confidence: 'none' },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  writeSilentMarker(runDir, 'pnb');
  const r = callClassify(runDir, 'pnb', { domainWasKnown: true });
  assert.equal(r.failure_class, 'extraction_failed');
});

test('partial_silent: classifier reads the marker but does not require it', () => {
  // Stale marker recovery: run-discovery clears the marker before classifyResult
  // runs when drift passes. The classifier sees no marker, returns 'success'.
  // This test simulates that "previously had marker, just cleared" state.
  const runDir = makeRunDir();
  writeFixture(runDir, 'pnb', {
    config: { website: 'https://pnb.bank.in', scraper_type: 'html_static', rate_page_urls: { fd: '/rates' } },
    rates: { rate_slabs: Array.from({ length: 84 }, () => ({})), extraction_confidence: 'high' },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  // No marker file → straightforward success.
  const r = callClassify(runDir, 'pnb', { domainWasKnown: true });
  assert.equal(r.failure_class, 'success');
  assert.equal(r.failure_signals.slab_drift_detected, false);
});

test('agent runtime failure → agent_error regardless of phase outcomes', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: { website: 'https://x.com', scraper_type: 'html_static', rate_page_urls: { fd: '/r' } },
    rates: { rate_slabs: [{}], extraction_confidence: 'high' },
    summary: { tool_calls: [] },
  });
  const r = callClassify(runDir, 'bank-x', { agentResult: FAILED_AGENT });
  assert.equal(r.failure_class, 'agent_error');
});

test('no config + no fetch attempts → discovery_failed (website=no_candidates)', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', { summary: { tool_calls: [] } });
  const r = callClassify(runDir, 'bank-x');
  assert.equal(r.phase_outcomes.website, 'no_candidates');
  assert.equal(r.phase_outcomes.rate_page, 'not_attempted');
  assert.equal(r.phase_outcomes.extraction, 'not_attempted');
  assert.equal(r.failure_class, 'discovery_failed');
});

test('no config + fetch errors only → discovery_failed (website=candidates_all_failed)', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    summary: {
      tool_calls: [
        { name: 'fetch_url', is_error: true },
        { name: 'fetch_url', is_error: true },
      ],
    },
  });
  const r = callClassify(runDir, 'bank-x');
  assert.equal(r.phase_outcomes.website, 'candidates_all_failed');
  assert.equal(r.failure_class, 'discovery_failed');
  assert.equal(r.failure_signals.fetch_error_count, 2);
});

test('no config + at least one successful fetch → partial_success (reachable_uncommitted)', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    summary: {
      tool_calls: [
        { name: 'fetch_url', is_error: false },
        { name: 'fetch_url', is_error: true },
      ],
    },
  });
  const r = callClassify(runDir, 'bank-x');
  assert.equal(r.phase_outcomes.website, 'reachable_uncommitted');
  assert.equal(r.failure_class, 'partial_success');
  assert.equal(r.failure_signals.fetch_ok_count, 1);
  assert.equal(r.failure_signals.fetch_error_count, 1);
});

test('config with website but no rate URL → partial_success (rate_page=not_found)', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: { website: 'https://x.com', scraper_type: 'html_static', rate_page_urls: { fd: null } },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x', { domainWasKnown: true });
  assert.equal(r.phase_outcomes.website, 'found_committed');
  assert.equal(r.phase_outcomes.rate_page, 'not_found');
  assert.equal(r.failure_class, 'partial_success');
});

test('config + rate URL + 0 slabs → extraction_failed', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: { website: 'https://x.com', scraper_type: 'html_static', rate_page_urls: { fd: '/rates' } },
    rates: { rate_slabs: [], extraction_confidence: 'none' },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x');
  assert.equal(r.phase_outcomes.extraction, 'failed');
  assert.equal(r.failure_class, 'extraction_failed');
});

test('config + rate URL + slabs + medium confidence → success', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: { website: 'https://x.com', scraper_type: 'html_static', rate_page_urls: { fd: '/r' } },
    rates: { rate_slabs: [{ tenure_text: '1y' }], extraction_confidence: 'medium' },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x');
  assert.equal(r.phase_outcomes.extraction, 'succeeded');
  assert.equal(r.failure_class, 'success');
});

test('config + slabs + low confidence → success (extraction marked succeeded_low_confidence)', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: { website: 'https://x.com', scraper_type: 'html_static', rate_page_urls: { fd: '/r' } },
    rates: { rate_slabs: [{ tenure_text: '1y' }], extraction_confidence: 'low' },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x');
  assert.equal(r.phase_outcomes.extraction, 'succeeded_low_confidence');
  assert.equal(r.failure_class, 'success');
});

test('manual scraper + "no FD" notes → no_rates_expected', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: {
      website: 'https://x.com',
      scraper_type: 'manual',
      notes: 'Payments bank does not offer fixed deposits.',
      rate_page_urls: { fd: null },
    },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x', { domainWasKnown: true });
  assert.equal(r.failure_class, 'no_rates_expected');
});

test('L14 — "No FD rates published" does NOT trigger no_rates_expected', () => {
  // The bank offers FDs but doesn't publish rates online (e.g., "Coming Soon"
  // on the rate page, or rates only available at branches). This should
  // route to partial_success, not no_rates_expected.
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: {
      website: 'https://x.com',
      scraper_type: 'manual',
      notes: 'No FD rates are published online. Branch inquiry required.',
      rate_page_urls: { fd: null },
    },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x', { domainWasKnown: true });
  assert.notEqual(r.failure_class, 'no_rates_expected');
  assert.equal(r.failure_class, 'partial_success');
});

test('L14 — "No FD slab details available" does NOT trigger no_rates_expected', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: {
      website: 'https://x.com',
      scraper_type: 'manual',
      notes: 'Deposit rates published as scanned image, not machine-readable. No FD slab details available in HTML or PDF.',
      rate_page_urls: { fd: null },
    },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x', { domainWasKnown: true });
  assert.notEqual(r.failure_class, 'no_rates_expected');
});

test('L14 — explicit "does not offer fixed deposit" still triggers no_rates_expected', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: {
      website: 'https://x.com',
      scraper_type: 'manual',
      notes: 'This institution does not offer fixed deposit accounts.',
      rate_page_urls: { fd: null },
    },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x', { domainWasKnown: true });
  assert.equal(r.failure_class, 'no_rates_expected');
});

test('L14 — Payments Bank category still triggers no_rates_expected', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: {
      website: 'https://x.com',
      scraper_type: 'manual',
      notes: 'This is a Payments Bank; per RBI regulation, no term deposit products are offered.',
      rate_page_urls: { fd: null },
    },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x', { domainWasKnown: true });
  assert.equal(r.failure_class, 'no_rates_expected');
});

test('L14 — "no deposit product" triggers no_rates_expected', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: {
      website: 'https://x.com',
      scraper_type: 'manual',
      notes: 'No deposit product is offered by this entity.',
      rate_page_urls: { fd: null },
    },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x', { domainWasKnown: true });
  assert.equal(r.failure_class, 'no_rates_expected');
});

test('manual scraper without no-rates notes + no rate URL → partial_success', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: {
      website: 'https://x.com',
      scraper_type: 'manual',
      notes: 'Could not locate rate page after multiple attempts.',
      rate_page_urls: { fd: null },
    },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x', { domainWasKnown: true });
  assert.equal(r.phase_outcomes.website, 'found_committed');
  assert.equal(r.phase_outcomes.rate_page, 'not_found');
  assert.equal(r.failure_class, 'partial_success');
});

test('classifier reads attempt2 summary when retryAttempted', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    summary: { tool_calls: [] },
    attempt2Summary: {
      tool_calls: [
        { name: 'fetch_url', is_error: true },
        { name: 'fetch_url', is_error: true },
        { name: 'fetch_url', is_error: true },
      ],
    },
  });
  const r = callClassify(runDir, 'bank-x', { retryAttempted: true });
  assert.equal(r.phase_outcomes.website, 'candidates_all_failed');
  assert.equal(r.failure_class, 'discovery_failed');
  assert.equal(r.failure_signals.fetch_error_count, 3);
});

test('phase_outcomes is always populated even on agent_error', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', { summary: { tool_calls: [] } });
  const r = callClassify(runDir, 'bank-x', { agentResult: FAILED_AGENT });
  assert.equal(r.failure_class, 'agent_error');
  assert.ok(r.phase_outcomes);
  assert.ok(WEBSITE_OUTCOMES.includes(r.phase_outcomes.website));
});

test('config exists but website field missing → reachable_uncommitted (treated as if no commit)', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: { scraper_type: 'manual', rate_page_urls: { fd: null } },
    summary: { tool_calls: [{ name: 'fetch_url', is_error: false }] },
  });
  const r = callClassify(runDir, 'bank-x');
  assert.equal(r.phase_outcomes.website, 'reachable_uncommitted');
  assert.equal(r.failure_class, 'partial_success');
});

test('signals capture fetch counts and slab count for debugging', () => {
  const runDir = makeRunDir();
  writeFixture(runDir, 'bank-x', {
    config: { website: 'https://x.com', scraper_type: 'html_static', rate_page_urls: { fd: '/r' } },
    rates: { rate_slabs: [{}, {}, {}], extraction_confidence: 'high' },
    summary: {
      tool_calls: [
        { name: 'fetch_url', is_error: false },
        { name: 'fetch_url', is_error: true },
      ],
    },
  });
  const r = callClassify(runDir, 'bank-x');
  assert.equal(r.failure_signals.slab_count, 3);
  assert.equal(r.failure_signals.fetch_ok_count, 1);
  assert.equal(r.failure_signals.fetch_error_count, 1);
  assert.equal(r.failure_signals.website_url, 'https://x.com');
  assert.equal(r.failure_signals.rate_url_fd, '/r');
});
