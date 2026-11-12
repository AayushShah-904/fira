'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertTraceability,
  normalizeForMatch,
  rateCandidates,
} = require('../../lib/extractors/_helpers/_assert_traceability');

test('assertTraceability passes a well-formed slab', () => {
  const slabs = [{
    tenure_text: '1 year',
    tenure_min_days: 365, tenure_max_days: 365,
    rate_general_pct: 6.50, rate_senior_pct: 7.00, rate_super_senior_pct: null,
    source_row_text: '1 year 6.50 7.00',
  }];
  const r = assertTraceability(slabs);
  assert.equal(r.passed, true);
  assert.equal(r.failures.length, 0);
});

test('assertTraceability throws when a slab is missing source_row_text', () => {
  const slabs = [{
    tenure_text: '1 year',
    rate_general_pct: 6.50, rate_senior_pct: 7.00,
    // source_row_text missing
  }];
  assert.throws(() => assertTraceability(slabs), /missing source_row_text/);
});

test('assertTraceability detects tenure not appearing in source_row_text', () => {
  const slabs = [{
    tenure_text: '5 years',  // not in source
    tenure_min_days: 1825, tenure_max_days: 1825,
    rate_general_pct: 6.50, source_row_text: '1 year 6.50',
  }];
  const r = assertTraceability(slabs, { strict: false });
  assert.equal(r.passed, false);
  assert.match(r.failures[0].reason, /tenure_text/);
});

test('assertTraceability detects rate not appearing in source_row_text', () => {
  const slabs = [{
    tenure_text: '1 year',
    rate_general_pct: 9.99,  // not in source
    source_row_text: '1 year 6.50 7.00',
  }];
  const r = assertTraceability(slabs, { strict: false });
  assert.equal(r.passed, false);
  assert.match(r.failures[0].reason, /rate 9.99% .* not found/);
});

test('assertTraceability accepts rate formats with both decimal and trimmed forms', () => {
  // Bank publishes "7%" and the slab stores 7.0 — must still verify
  const slabs = [{
    tenure_text: '3 years',
    rate_general_pct: 7.0,
    source_row_text: '3 years 7% senior 7.5%',
  }];
  const r = assertTraceability(slabs);
  assert.equal(r.passed, true);
});

test('assertTraceability allows tenure_text with parentheticals to match source row', () => {
  // Slab has stripped tenure_text; source row preserves the parenthetical wording
  const slabs = [{
    tenure_text: '7 Days to 45 days',
    rate_general_pct: 3.75,
    source_row_text: '7 Days to 45 days(new slab) 3.75 4.00',
  }];
  const r = assertTraceability(slabs);
  assert.equal(r.passed, true);
});

test('assertTraceability with strict:false collects failures without throwing', () => {
  const slabs = [
    { tenure_text: '1 year', rate_general_pct: 6.5, source_row_text: '1 year 6.5' }, // ok
    { tenure_text: '2 years', rate_general_pct: 9.99, source_row_text: 'completely unrelated' }, // fails
    { tenure_text: '3 years', rate_general_pct: 7.0, source_row_text: '3 years 7' }, // ok
  ];
  const r = assertTraceability(slabs, { strict: false });
  assert.equal(r.passed, false);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].index, 1);
});

test('rateCandidates produces all the printable forms a rate might take in source HTML', () => {
  assert.deepEqual(rateCandidates(6.5).sort(), ['6.5', '6.50'].sort());
  assert.deepEqual(rateCandidates(7).sort(), ['7', '7.0', '7.00'].sort());
  // 6.25 also gets a toFixed(1) rounded form "6.3" — useful when banks round in their HTML.
  assert.deepEqual(rateCandidates(6.25).sort(), ['6.25', '6.3'].sort());
});

test('normalizeForMatch strips punctuation but keeps digits and dots', () => {
  assert.equal(normalizeForMatch('7 Days to 45 days(new slab)'), '7 days to 45 days new slab');
  assert.equal(normalizeForMatch('6.50%'), '6.50%');
  assert.equal(normalizeForMatch('  multiple   spaces  '), 'multiple spaces');
});

test('assertTraceability skips rate verification when requireRateMatch=false', () => {
  // For PDF or vision pipelines where the rate values may be reconstructed from
  // table cell positions and the source_row_text only carries the tenure.
  const slabs = [{
    tenure_text: '1 year',
    rate_general_pct: 9.99,
    source_row_text: '1 year — rate from cell (1,2)',
  }];
  const r = assertTraceability(slabs, { requireRateMatch: false });
  assert.equal(r.passed, true);
});
