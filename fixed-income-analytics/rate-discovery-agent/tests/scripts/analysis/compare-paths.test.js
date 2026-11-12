'use strict';

/**
 * Tests for scripts/analysis/compare-paths.js pure functions.
 * The harness's live-spawn and report-rendering paths are exercised end-to-end
 * by the script's own smoke run; here we just check the diff/aggregate logic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _compareVariantRates,
  _bpsDiff,
  _aggregate,
  _inferSlug,
  _parseBanks,
} = require('../../../scripts/analysis/compare-paths');

test('bpsDiff: 0 when both null, 0 when equal, rounded bps otherwise', () => {
  assert.equal(_bpsDiff(null, null), 0);
  assert.equal(_bpsDiff(6.5, 6.5), 0);
  assert.equal(_bpsDiff(6.50, 6.51), 1);
  assert.equal(_bpsDiff(6.50, 6.60), 10);
  assert.equal(_bpsDiff(6.5, null), 9999);
});

test('compareVariantRates: matching slabs report zero diff', () => {
  const slabs = [
    { tenure_text: '1 year', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.5, rate_senior_pct: 7.0 },
  ];
  const out = _compareVariantRates({ rate_slabs: slabs }, { rate_slabs: slabs });
  assert.equal(out.llm_slabs, 1);
  assert.equal(out.orch_slabs, 1);
  assert.equal(out.slab_diffs.length, 0);
});

test('compareVariantRates: 6 bps drift on general rate is flagged', () => {
  const llmSlabs = [{ tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.50, rate_senior_pct: null }];
  const orchSlabs = [{ tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.56, rate_senior_pct: null }];
  const out = _compareVariantRates({ rate_slabs: llmSlabs }, { rate_slabs: orchSlabs });
  assert.equal(out.slab_diffs.length, 1);
  assert.equal(out.slab_diffs[0].kind, 'rate_drift');
  assert.equal(out.slab_diffs[0].general_bps, 6);
});

test('compareVariantRates: 5 bps drift is within tolerance (not flagged)', () => {
  const llmSlabs = [{ tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.50, rate_senior_pct: null }];
  const orchSlabs = [{ tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.55, rate_senior_pct: null }];
  const out = _compareVariantRates({ rate_slabs: llmSlabs }, { rate_slabs: orchSlabs });
  assert.equal(out.slab_diffs.length, 0);
});

test('compareVariantRates: orch missing a slab the LLM had', () => {
  const llmSlabs = [
    { tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 6.5, rate_senior_pct: null },
    { tenure_text: '2y', tenure_min_days: 730, tenure_max_days: 730, rate_general_pct: 7.0, rate_senior_pct: null },
  ];
  const orchSlabs = [llmSlabs[0]];
  const out = _compareVariantRates({ rate_slabs: llmSlabs }, { rate_slabs: orchSlabs });
  assert.equal(out.slab_diffs.length, 1);
  assert.equal(out.slab_diffs[0].kind, 'orch_missing');
  assert.equal(out.slab_diffs[0].tenure, '2y');
});

test('compareVariantRates: per-currency slab keying (GIFT/FCNR)', () => {
  // Same tenure, different currency → distinct slabs
  const llmSlabs = [
    { tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 5.25, currency: 'USD' },
    { tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 4.10, currency: 'EUR' },
  ];
  const orchSlabs = [
    { tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 5.25, currency: 'USD' },
    { tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 365, rate_general_pct: 4.10, currency: 'EUR' },
  ];
  const out = _compareVariantRates({ rate_slabs: llmSlabs }, { rate_slabs: orchSlabs });
  assert.equal(out.slab_diffs.length, 0, 'matching per-currency slabs should not produce diffs');
});

test('aggregate: sums slabs, counts banks, detects drift and missing', () => {
  const rows = [
    {
      slug: 'a', llm_present: true, orch_present: true,
      variants: { regular: { llm_slabs: 2, orch_slabs: 2, slab_diffs: [] } },
      summary: { llm: { input_tokens: 100, output_tokens: 50, wall_clock_ms: 1000 }, orch: { input_tokens: 10, output_tokens: 5, wall_clock_ms: 200 } },
    },
    {
      slug: 'b', llm_present: true, orch_present: true,
      variants: { regular: { llm_slabs: 3, orch_slabs: 2, slab_diffs: [{ kind: 'orch_missing' }] } },
      summary: { llm: null, orch: null },
    },
    {
      slug: 'c', llm_present: true, orch_present: true,
      variants: { regular: { llm_slabs: 1, orch_slabs: 1, slab_diffs: [{ kind: 'rate_drift' }] } },
      summary: { llm: null, orch: null },
    },
    {
      slug: 'd', llm_present: false, orch_present: true,
      variants: {},
      summary: { llm: null, orch: null },
    },
  ];
  const t = _aggregate(rows);
  assert.equal(t.banks_with_llm, 3);
  assert.equal(t.banks_with_orch, 4);
  assert.equal(t.banks_both, 3);
  assert.equal(t.slabs_llm, 6);
  assert.equal(t.slabs_orch, 5);
  assert.equal(t.banks_with_drift, 1);
  assert.equal(t.banks_with_missing, 1);
  assert.equal(t.tokens_llm, 100);
  assert.equal(t.tokens_orch, 10);
  assert.equal(t.mean_wall_llm, 1000);
  assert.equal(t.mean_wall_orch, 200);
});

test('inferSlug: derives bank_code from config filename', () => {
  assert.equal(_inferSlug(['state-bank-of-india_config.json', 'state-bank-of-india_rates.json']), 'state-bank-of-india');
});
test('inferSlug: derives from variant rates file when config absent', () => {
  assert.equal(_inferSlug(['hdfc-bank-ibu_gift_rates.json']), 'hdfc-bank-ibu');
});
test('inferSlug: returns null when no anchoring filename is present', () => {
  assert.equal(_inferSlug(['random.log']), null);
});

test('parseBanks: splits Name:Type:State tuples and maps type to category', () => {
  const out = _parseBanks('State Bank of India:PSB:Maharashtra,HDFC Bank Limited:PVB:,Some IBU:IBU:Gujarat');
  assert.equal(out.length, 3);
  assert.equal(out[0].name, 'State Bank of India');
  assert.equal(out[0].bank_type, 'PSB');
  assert.equal(out[0].category, 'Public Sector Bank');
  assert.equal(out[0].state, 'Maharashtra');
  assert.equal(out[1].state, '');
  assert.equal(out[2].category, 'IFSC Banking Unit (IFSCA)');
});
