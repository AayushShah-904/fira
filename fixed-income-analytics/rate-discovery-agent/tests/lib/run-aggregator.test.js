'use strict';

/**
 * Tests for lib/run-aggregator.js — fixture-based.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRunAnalysis } = require('../../lib/run-aggregator');

const tmpDirs = [];

function makeRunDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-test-'));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

function writeSummary(dir, slug, failureClass, opts = {}) {
  const file = opts.attempt2 ? `${slug}_attempt2.summary.json` : `${slug}.summary.json`;
  const summary = {
    bank_code: slug,
    bank_name: opts.name || slug,
    failure_class: failureClass,
    phase_outcomes: opts.phase_outcomes || null,
    total_cost_usd: opts.cost ?? 0.05,
    tool_calls: [],
  };
  fs.writeFileSync(path.join(dir, file), JSON.stringify(summary));
}

test('empty run dir produces empty analysis', () => {
  const dir = makeRunDir();
  const a = buildRunAnalysis({ runDir: dir, runLabel: 'r1' });
  assert.equal(a.totals.dispatched, 0);
  assert.equal(a.totals.succeeded, 0);
  assert.equal(a.totals.partial_success, 0);
  assert.equal(a.cost_usd_total, 0);
});

test('counts and exemplars per failure_class (Option A enum)', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'a-bank', 'success');
  writeSummary(dir, 'b-bank', 'success');
  writeSummary(dir, 'c-bank', 'discovery_failed');
  writeSummary(dir, 'd-bank', 'discovery_failed');
  writeSummary(dir, 'e-bank', 'partial_success');
  const a = buildRunAnalysis({ runDir: dir, runLabel: 'r1' });
  assert.equal(a.by_failure_class.success.count, 2);
  assert.deepEqual(a.by_failure_class.success.exemplars, ['a-bank', 'b-bank']);
  assert.equal(a.by_failure_class.discovery_failed.count, 2);
  assert.equal(a.by_failure_class.partial_success.count, 1);
  assert.equal(a.totals.dispatched, 5);
  assert.equal(a.totals.succeeded, 2);
  assert.equal(a.totals.partial_success, 1);
  assert.equal(a.totals.failed, 2);
});

test('attempt2 summary supersedes attempt1 for the same bank', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'x-bank', 'discovery_failed');
  writeSummary(dir, 'x-bank', 'success', { attempt2: true });
  const a = buildRunAnalysis({ runDir: dir, runLabel: 'r1' });
  assert.equal(a.by_failure_class.success.count, 1);
  assert.equal(a.by_failure_class.discovery_failed.count, 0);
});

test('exemplars cap at 5 per class', () => {
  const dir = makeRunDir();
  for (let i = 0; i < 8; i++) writeSummary(dir, `bank-${i}`, 'discovery_failed');
  const a = buildRunAnalysis({ runDir: dir, runLabel: 'r1' });
  assert.equal(a.by_failure_class.discovery_failed.count, 8);
  assert.equal(a.by_failure_class.discovery_failed.exemplars.length, 5);
});

test('bankCodes filter restricts analysis', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'old-bank-from-prior-run', 'success');
  writeSummary(dir, 'this-run-a', 'success');
  writeSummary(dir, 'this-run-b', 'discovery_failed');
  const a = buildRunAnalysis({
    runDir: dir,
    runLabel: 'r1',
    bankCodes: ['this-run-a', 'this-run-b'],
  });
  assert.equal(a.totals.dispatched, 2);
  assert.equal(a.by_failure_class.success.count, 1);
  assert.equal(a.by_failure_class.discovery_failed.count, 1);
});

test('cost is summed and rounded', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'a', 'success', { cost: 0.123456 });
  writeSummary(dir, 'b', 'success', { cost: 0.234567 });
  const a = buildRunAnalysis({ runDir: dir, runLabel: 'r1' });
  assert.equal(a.cost_usd_total, 0.358);
});

test('duration_ms computed from started_at and ended_at', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'a', 'success');
  const a = buildRunAnalysis({
    runDir: dir,
    runLabel: 'r1',
    startedAt: '2026-05-10T12:00:00.000Z',
    endedAt: '2026-05-10T12:30:00.000Z',
  });
  assert.equal(a.duration_ms, 30 * 60 * 1000);
});

test('reads pending-changes file and counts unresolved + surfaced this run', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'a', 'success');
  const pendingFile = path.join(dir, 'pending.json');
  fs.writeFileSync(pendingFile, JSON.stringify({
    entries: [
      { bank_code: 'a', field: 'domain', cached_value: 'old.in', proposed_value: 'new.in', proposed_run_id: 'r1', proposed_confidence: 'high', status: 'pending' },
      { bank_code: 'b', field: 'domain', cached_value: 'x', proposed_value: 'y', proposed_run_id: 'r0', proposed_confidence: 'medium', status: 'pending' },
      { bank_code: 'c', field: 'domain', cached_value: 'p', proposed_value: 'q', proposed_run_id: 'r0', status: 'accepted' },
    ],
  }));
  const a = buildRunAnalysis({
    runDir: dir,
    runLabel: 'r1',
    pendingChangesFile: pendingFile,
  });
  assert.equal(a.registry_conflicts_unresolved_total, 2);
  assert.equal(a.registry_conflicts_surfaced.length, 1);
  assert.equal(a.registry_conflicts_surfaced[0].bank_code, 'a');
});

test('skips files starting with underscore', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'a-bank', 'success');
  fs.writeFileSync(path.join(dir, '_run_analysis.json'), '{}');
  const a = buildRunAnalysis({ runDir: dir, runLabel: 'r1' });
  assert.equal(a.totals.dispatched, 1);
});

test('aggregates phase_outcomes independently across banks', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'a', 'success', {
    phase_outcomes: { website: 'found_committed', rate_page: 'found', extraction: 'succeeded' },
  });
  writeSummary(dir, 'b', 'partial_success', {
    phase_outcomes: { website: 'found_committed', rate_page: 'not_found', extraction: 'not_attempted' },
  });
  writeSummary(dir, 'c', 'discovery_failed', {
    phase_outcomes: { website: 'candidates_all_failed', rate_page: 'not_attempted', extraction: 'not_attempted' },
  });
  const a = buildRunAnalysis({ runDir: dir, runLabel: 'r1' });
  assert.equal(a.by_phase_outcome.website.found_committed, 2);
  assert.equal(a.by_phase_outcome.website.candidates_all_failed, 1);
  assert.equal(a.by_phase_outcome.rate_page.found, 1);
  assert.equal(a.by_phase_outcome.rate_page.not_found, 1);
  assert.equal(a.by_phase_outcome.rate_page.not_attempted, 1);
  assert.equal(a.by_phase_outcome.extraction.succeeded, 1);
  assert.equal(a.by_phase_outcome.extraction.not_attempted, 2);
});

test('summaries without phase_outcomes are tolerated (legacy data)', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'a', 'success'); // no phase_outcomes
  const a = buildRunAnalysis({ runDir: dir, runLabel: 'r1' });
  assert.equal(a.totals.dispatched, 1);
  assert.equal(a.by_phase_outcome.website.found_committed, 0);
});
