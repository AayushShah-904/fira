'use strict';

/**
 * Tests for lib/run-report-renderer.js — pure-function snapshot tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderRunReport } = require('../../lib/run-report-renderer');

function emptyByClass() {
  return {
    success: { count: 0, exemplars: [] },
    partial_success: { count: 0, exemplars: [] },
    extraction_failed: { count: 0, exemplars: [] },
    discovery_failed: { count: 0, exemplars: [] },
    no_rates_expected: { count: 0, exemplars: [] },
    agent_error: { count: 0, exemplars: [] },
    unclassified: { count: 0, exemplars: [] },
  };
}

function emptyPhaseTotals() {
  return {
    website: { found_committed: 0, reachable_uncommitted: 0, candidates_all_failed: 0, no_candidates: 0 },
    rate_page: { found: 0, not_found: 0, not_attempted: 0 },
    extraction: { succeeded: 0, succeeded_low_confidence: 0, failed: 0, not_attempted: 0 },
  };
}

test('renders header, headline, breakdown, phase outcomes, and conflicts', () => {
  const byClass = emptyByClass();
  byClass.success = { count: 17, exemplars: ['a-bank', 'b-bank'] };
  byClass.partial_success = { count: 74, exemplars: ['c-bank'] };
  byClass.discovery_failed = { count: 214, exemplars: ['d-bank'] };

  const byPhase = emptyPhaseTotals();
  byPhase.website.found_committed = 17;
  byPhase.website.reachable_uncommitted = 74;
  byPhase.website.candidates_all_failed = 212;
  byPhase.website.no_candidates = 2;
  byPhase.rate_page.found = 17;
  byPhase.rate_page.not_attempted = 290;
  byPhase.extraction.succeeded = 17;
  byPhase.extraction.not_attempted = 288;

  const md = renderRunReport({
    run_label: '20260510T1230_dccb',
    started_at: '2026-05-10T12:30:00.000Z',
    ended_at: '2026-05-10T15:55:00.000Z',
    duration_ms: 12300000,
    category: 'DCCB',
    totals: {
      dispatched: 305,
      completed: 305,
      succeeded: 17,
      partial_success: 74,
      no_rates_expected: 0,
      failed: 214,
    },
    by_failure_class: byClass,
    by_phase_outcome: byPhase,
    registry_conflicts_surfaced: [],
    registry_conflicts_unresolved_total: 0,
    cost_usd_total: 17.42,
  });

  assert.match(md, /^# Run report — 20260510T1230_dccb/);
  assert.match(md, /\*\*Category:\*\* DCCB/);
  assert.match(md, /17 succeeded \/ 74 partial \/ 214 failed \/ 305 dispatched/);
  assert.match(md, /\| `success` \| 17 \|/);
  assert.match(md, /\| `partial_success` \| 74 \|/);
  assert.match(md, /\| `discovery_failed` \| 214 \|/);
  assert.match(md, /## Phase outcomes/);
  assert.match(md, /\*\*website:\*\*.*found_committed=17.*reachable_uncommitted=74.*candidates_all_failed=212/);
  assert.match(md, /\*\*rate_page:\*\*.*found=17.*not_found=0.*not_attempted=290/);
  assert.match(md, /\*\*extraction:\*\*.*succeeded=17/);
  assert.match(md, /## Registry conflicts surfaced this run\n\n_None\._/);
  assert.match(md, /_No outstanding pending changes\._/);
  assert.match(md, /\*\*Duration:\*\* 3h 25m/);
  assert.match(md, /\*\*Cost:\*\* \$17\.42/);
});

test('omits zero-count rows from breakdown', () => {
  const byClass = emptyByClass();
  byClass.success = { count: 5, exemplars: ['a'] };

  const md = renderRunReport({
    run_label: 'r',
    ended_at: '2026-05-10T00:00:00.000Z',
    totals: { dispatched: 5, succeeded: 5, partial_success: 0, failed: 0 },
    by_failure_class: byClass,
    by_phase_outcome: emptyPhaseTotals(),
  });

  assert.match(md, /\| `success` \| 5 \|/);
  assert.doesNotMatch(md, /\| `agent_error` \|/);
  assert.doesNotMatch(md, /\| `discovery_failed` \|/);
});

test('renders surfaced conflicts as a table', () => {
  const md = renderRunReport({
    run_label: 'r',
    ended_at: '2026-05-10T00:00:00.000Z',
    totals: { dispatched: 1, succeeded: 1, partial_success: 0, failed: 0 },
    by_failure_class: emptyByClass(),
    by_phase_outcome: emptyPhaseTotals(),
    registry_conflicts_surfaced: [
      {
        bank_code: 'sample-bank',
        field: 'domain',
        cached_value: 'old.example',
        proposed_value: 'new.example',
        proposed_confidence: 'high',
      },
    ],
    registry_conflicts_unresolved_total: 1,
  });

  assert.match(md, /\| `sample-bank` \| `domain` \| `old\.example` \| `new\.example` \| high \|/);
  assert.match(md, /\*\*1\*\* pending changes remain unresolved/);
});

test('renders null cached_value as `null`', () => {
  const md = renderRunReport({
    run_label: 'r',
    ended_at: '2026-05-10T00:00:00.000Z',
    totals: { dispatched: 1, succeeded: 0, partial_success: 0, failed: 1 },
    by_failure_class: emptyByClass(),
    by_phase_outcome: emptyPhaseTotals(),
    registry_conflicts_surfaced: [
      { bank_code: 'b', field: 'rate_pages.fd_nre', cached_value: null, proposed_value: '/nre' },
    ],
    registry_conflicts_unresolved_total: 1,
  });

  assert.match(md, /\| `b` \| `rate_pages\.fd_nre` \| `null` \| `\/nre` \| — \|/);
});

test('handles unrecognized failure_class with a label', () => {
  const byClass = emptyByClass();
  byClass.brand_new_class = { count: 3, exemplars: ['x'] };

  const md = renderRunReport({
    run_label: 'r',
    ended_at: '2026-05-10T00:00:00.000Z',
    totals: { dispatched: 3, succeeded: 0, partial_success: 0, failed: 3 },
    by_failure_class: byClass,
    by_phase_outcome: emptyPhaseTotals(),
  });

  assert.match(md, /`brand_new_class` \(unrecognized\)/);
});

test('renders without phase outcomes section when by_phase_outcome absent', () => {
  const md = renderRunReport({
    run_label: 'r',
    ended_at: '2026-05-10T00:00:00.000Z',
    totals: { dispatched: 1, succeeded: 1, partial_success: 0, failed: 0 },
    by_failure_class: emptyByClass(),
  });
  assert.doesNotMatch(md, /## Phase outcomes/);
});
