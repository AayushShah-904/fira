'use strict';

/**
 * Tests for scripts/analysis/compare-cohort-runs.js — Sprint 002 #13's
 * lift-measurement helper. Fixture-driven unit tests of the pure
 * comparison + render functions.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { compareRuns, renderMarkdown } = require('../../scripts/analysis/compare-cohort-runs');

const tmpDirs = [];

function makeRunDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-runs-test-'));
  tmpDirs.push(d);
  return d;
}

function writeSummary(dir, slug, failureClass, { attempt2 = false, phaseOutcomes, slabs = 0 } = {}) {
  const filename = attempt2 ? `${slug}_attempt2.summary.json` : `${slug}.summary.json`;
  const data = {
    bank_code: slug,
    failure_class: failureClass,
    phase_outcomes: phaseOutcomes || { website: 'found_committed', rate_page: 'found', extraction: 'succeeded' },
    failure_signals: { slab_count: slabs },
    tool_calls: [],
  };
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

test('compareRuns identifies shared banks and per-side exclusives', () => {
  const baseline = makeRunDir();
  const newDir = makeRunDir();
  writeSummary(baseline, 'bank-a', 'discovery_failed');
  writeSummary(baseline, 'bank-b', 'partial_success');
  writeSummary(baseline, 'bank-only-old', 'success');
  writeSummary(newDir, 'bank-a', 'success');
  writeSummary(newDir, 'bank-b', 'success');
  writeSummary(newDir, 'bank-only-new', 'extraction_failed');

  const r = compareRuns({ baselineDir: baseline, newDir });
  assert.equal(r.baselineCount, 3);
  assert.equal(r.newCount, 3);
  assert.equal(r.sharedCount, 2);
  assert.equal(r.onlyInBaseline.length, 1);
  assert.equal(r.onlyInBaseline[0].slug, 'bank-only-old');
  assert.equal(r.onlyInNew.length, 1);
  assert.equal(r.onlyInNew[0].slug, 'bank-only-new');
});

test('compareRuns prefers attempt2 over base summary when both exist', () => {
  const dir = makeRunDir();
  writeSummary(dir, 'bank-x', 'extraction_failed');                    // attempt 1
  writeSummary(dir, 'bank-x', 'success', { attempt2: true });          // attempt 2 — should win
  const empty = makeRunDir();
  writeSummary(empty, 'bank-x', 'discovery_failed');                    // for delta

  const r = compareRuns({ baselineDir: empty, newDir: dir });
  const t = r.transitions[0];
  assert.equal(t.slug, 'bank-x');
  assert.equal(t.from, 'discovery_failed');
  assert.equal(t.to, 'success', 'attempt2 won over attempt1');
});

test('compareRuns produces a transition matrix counting each from→to pair', () => {
  const baseline = makeRunDir();
  const newDir = makeRunDir();
  writeSummary(baseline, 'a', 'discovery_failed');
  writeSummary(baseline, 'b', 'discovery_failed');
  writeSummary(baseline, 'c', 'discovery_failed');
  writeSummary(newDir, 'a', 'success');
  writeSummary(newDir, 'b', 'success');
  writeSummary(newDir, 'c', 'partial_success');

  const r = compareRuns({ baselineDir: baseline, newDir });
  assert.equal(r.matrix.discovery_failed.success, 2);
  assert.equal(r.matrix.discovery_failed.partial_success, 1);
});

test('compareRuns tier-2 distributions tally correctly', () => {
  const baseline = makeRunDir();
  const newDir = makeRunDir();
  for (let i = 0; i < 5; i++) writeSummary(baseline, `bank-${i}`, 'discovery_failed');
  for (let i = 0; i < 3; i++) writeSummary(newDir, `bank-${i}`, 'success');
  for (let i = 3; i < 5; i++) writeSummary(newDir, `bank-${i}`, 'partial_success');

  const r = compareRuns({ baselineDir: baseline, newDir });
  assert.equal(r.baselineDist.discovery_failed, 5);
  assert.equal(r.newDist.success, 3);
  assert.equal(r.newDist.partial_success, 2);
});

test('compareRuns tolerates summaries missing failure_class (legacy data)', () => {
  // Sprint 001 forensic data predates v2 — no failure_class field.
  const dir = makeRunDir();
  fs.writeFileSync(
    path.join(dir, 'legacy-bank.summary.json'),
    JSON.stringify({ bank_code: 'legacy-bank', tool_calls: [] }),
  );
  const r = compareRuns({ baselineDir: dir, newDir: makeRunDir() });
  assert.equal(r.baselineDist.unclassified, 1);
});

test('renderMarkdown produces a deterministic report shape', () => {
  const baseline = makeRunDir();
  const newDir = makeRunDir();
  writeSummary(baseline, 'b1', 'discovery_failed');
  writeSummary(newDir, 'b1', 'success');

  const r = compareRuns({ baselineDir: baseline, newDir, baselineLabel: 'Old', newLabel: 'New' });
  const md = renderMarkdown(r);

  assert.match(md, /^# Cohort comparison — Old → New/);
  assert.match(md, /Tier-2 distribution/);
  assert.match(md, /Transition matrix/);
  assert.match(md, /improved=1/);
});

test('renderMarkdown reports movement direction (improved / regressed / unchanged)', () => {
  const baseline = makeRunDir();
  const newDir = makeRunDir();
  writeSummary(baseline, 'b-up', 'discovery_failed');                  // improves
  writeSummary(newDir, 'b-up', 'success');
  writeSummary(baseline, 'b-flat', 'success');                          // unchanged
  writeSummary(newDir, 'b-flat', 'success');
  writeSummary(baseline, 'b-down', 'success');                          // regresses
  writeSummary(newDir, 'b-down', 'discovery_failed');

  const r = compareRuns({ baselineDir: baseline, newDir });
  const md = renderMarkdown(r);
  assert.match(md, /unchanged=1, improved=1, regressed=1/);
});
