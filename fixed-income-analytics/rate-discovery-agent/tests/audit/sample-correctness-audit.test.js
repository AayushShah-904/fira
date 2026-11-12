'use strict';

// Sprint 008, Phase 2 — sampling correctness audit (pure functions).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mulberry32, wilson, slugAndVariant, classifyExtraction,
  pickFocusSlabs, stratify, sampleStrata, parseJudgeResponse, summarize, stripJsonEnvelope,
} = require('../../scripts/audit/sample-correctness-audit.js');

test('mulberry32 is deterministic for a seed', () => {
  const a = mulberry32(42); const b = mulberry32(42);
  assert.equal(a(), b());
  assert.equal(a(), b());
});

test('wilson interval brackets the point estimate and clamps to [0,1]', () => {
  const w = wilson(2, 20);
  assert.ok(Math.abs(w.p - 0.1) < 1e-9);
  assert.ok(w.lo >= 0 && w.lo < w.p && w.hi > w.p && w.hi <= 1);
  const zero = wilson(0, 0);
  assert.deepEqual([zero.p, zero.lo, zero.hi], [0, 0, 0]);
  const all = wilson(10, 10);
  assert.ok(all.hi <= 1 && all.lo > 0);
});

test('slugAndVariant splits variant suffixes', () => {
  assert.deepEqual(slugAndVariant('hdfc-bank_rates.json'), { slug: 'hdfc-bank', variant: 'regular' });
  assert.deepEqual(slugAndVariant('hdfc-bank_fcnr_rates.json'), { slug: 'hdfc-bank', variant: 'fcnr' });
  assert.deepEqual(slugAndVariant('sbi_nre_rates.json'), { slug: 'sbi', variant: 'nre' });
});

test('classifyExtraction: template / tier2 / static', () => {
  assert.equal(classifyExtraction({ template: {} }, {}), 'template');
  assert.equal(classifyExtraction({ tier2: {} }, {}), 'tier2');
  assert.equal(classifyExtraction({ extraction_method: 'manual_pdf_transcription' }, {}), 'tier2');
  assert.equal(classifyExtraction({}, { discovery_metadata: { run_method: 'tier-2' } }), 'tier2');
  assert.equal(classifyExtraction({}, {}), 'static');
});

test('pickFocusSlabs covers key tenures and is bounded', () => {
  const slabs = [];
  for (let i = 0; i < 20; i++) slabs.push({ tenure_text: `t${i}`, tenure_min_days: i * 100 + 1, tenure_max_days: i * 100 + 100, rate_general_pct: 5 + i * 0.1 });
  const rand = mulberry32(7);
  const focus = pickFocusSlabs(slabs, rand, 6);
  assert.ok(focus.length <= 6 && focus.length >= 4);
  // indices ascending
  const idxs = focus.map((f) => f.index);
  assert.deepEqual(idxs, [...idxs].sort((a, b) => a - b));
});

test('stratify + sampleStrata: stratified, seeded, deterministic, capped at n', () => {
  const units = [];
  for (let i = 0; i < 50; i++) units.push({ slug: `b${i}`, variant: 'regular', bank_type: i % 2 ? 'PSB' : 'SUCB', extraction_class: i % 3 ? 'template' : 'tier2' });
  const strata = stratify(units);
  assert.ok(strata.size >= 3);
  const a = sampleStrata(strata, { n: 3, seed: 99 }).sample;
  const b = sampleStrata(strata, { n: 3, seed: 99 }).sample;
  assert.deepEqual(a.map((u) => u.slug), b.map((u) => u.slug), 'same seed → same sample');
  // each stratum capped at 3
  const counts = {};
  for (const u of a) counts[u.stratum] = (counts[u.stratum] || 0) + 1;
  for (const v of Object.values(counts)) assert.ok(v <= 3);
});

test('stripJsonEnvelope strips fences and prose', () => {
  assert.match(stripJsonEnvelope('```json\n{"a":1}\n```'), /^\{"a":1\}$/);
  assert.match(stripJsonEnvelope('Here you go: {"a":1}'), /^\{"a":1\}/);
});

test('parseJudgeResponse maps verdicts onto focus order', () => {
  const focus = [
    { slab: { tenure_text: '1y', rate_general_pct: 7.0 } },
    { slab: { tenure_text: '2y', rate_general_pct: 7.1 } },
  ];
  const out = parseJudgeResponse('{"verdicts":[{"i":0,"verdict":"CONFIRM"},{"i":1,"verdict":"CONTRADICT","actual":6.5}]}', focus);
  assert.equal(out[0].verdict, 'CONFIRM');
  assert.equal(out[1].verdict, 'CONTRADICT');
  assert.equal(out[1].actual, 6.5);
});

test('parseJudgeResponse: bad JSON => null', () => {
  assert.equal(parseJudgeResponse('not json', [{ slab: {} }]), null);
});

test('summarize computes per-stratum error rate with NOT_FOUND excluded', () => {
  const records = [
    { stratum: 'PSB | template', post_hoc: false, slabs: [{ verdict: 'CONFIRM' }, { verdict: 'CONFIRM' }, { verdict: 'CONTRADICT' }] },
    { stratum: 'PSB | template', post_hoc: false, slabs: [{ verdict: 'CONFIRM' }, { verdict: 'NOT_FOUND' }] },
    { stratum: 'SUCB | static', post_hoc: true, slabs: [{ verdict: 'CONTRADICT' }, { verdict: 'CONTRADICT' }] },
  ];
  const s = summarize(records);
  const psb = s.strata.find((x) => x.stratum === 'PSB | template');
  assert.equal(psb.confirm, 3);
  assert.equal(psb.contradict, 1);
  assert.equal(psb.not_found, 1);
  assert.ok(Math.abs(psb.error_rate - 0.25) < 1e-9); // 1 contradict / 4 decided
  const sucb = s.strata.find((x) => x.stratum === 'SUCB | static');
  assert.equal(sucb.error_rate, 1); // 2/2
  assert.equal(sucb.contradict_posthoc, 2);
  assert.equal(s.overall.decided, 6);
});
