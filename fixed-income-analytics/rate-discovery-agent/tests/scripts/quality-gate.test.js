'use strict';

/**
 * Synthetic tests for scripts/quality-gate.js — covers the classification
 * matrix from sdlc/sprints/sprint-004/design/pack-quality-gate.md.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const crypto = require('node:crypto');
const {
  classifyDelta,
  pass1and2_compare,
  pass3_anomalies,
  applyAccepts,
  summarize,
  verdictFromSummary,
  runGate,
} = require('../../scripts/quality-gate.js');
const {
  signAccept,
  computeFindingHash,
  SIGNED_FORMAT_VERSION,
} = require('../../lib/quality-gate/signed-accepts.js');

// Sprint 005 Phase D2: tests need signed accepts. Generate a test key once per
// process; it's not the real operator key — it can't unlock production accepts.
const TEST_OPERATOR_KEY = crypto.randomBytes(32).toString('hex');

function makeSlab({
  tenure_text = '1 year',
  tenure_min_days = 365,
  tenure_max_days = 365,
  rate_general_pct = 6.5,
  rate_senior_pct = 7.0,
  rate_super_senior_pct = null,
  deposit_range = 'below_3cr',
  currency,
} = {}) {
  const slab = {
    tenure_text, tenure_min_days, tenure_max_days,
    rate_general_pct, rate_senior_pct, rate_super_senior_pct,
    deposit_range,
  };
  if (currency !== undefined) slab.currency = currency;
  return slab;
}

function makeBank({
  bank_code,
  variants = { regular: 5 },
  overrideSlabs = null,
} = {}) {
  const fd = {};
  for (const [variant, count] of Object.entries(variants)) {
    const slabs = overrideSlabs && overrideSlabs[variant]
      ? overrideSlabs[variant]
      : Array.from({ length: count }, () => makeSlab(variant === 'fcnr' || variant === 'gift' ? { currency: 'USD' } : {}));
    fd[variant] = {
      effective_date: '2026-04-01',
      source_url: 'https://example.test/rates',
      scraped_at: '2026-05-14T00:00:00Z',
      extraction_confidence: 'high',
      slabs,
    };
  }
  return {
    bank_code,
    bank_name: bank_code,
    bank_type: 'SUCB',
    status: 'current',
    source: 'latest',
    products: { fd },
  };
}

function makePack({ banks, generated_at = '2026-05-14T00:00:00Z' } = {}) {
  return {
    pack_version: '1.0',
    generated_at,
    enums: {},
    counts: { banks_total: banks.length },
    banks,
  };
}

test('classifyDelta band table', () => {
  assert.equal(classifyDelta(10, 10).class, 'STABLE');         // 0%
  assert.equal(classifyDelta(11, 10).class, 'GAIN');           // +10% > +5% band
  assert.equal(classifyDelta(20, 10).class, 'GAIN');           // +100%
  assert.equal(classifyDelta(7, 10).class, 'REGRESSION');      // -30% ≤ -20%
  assert.equal(classifyDelta(8, 10).class, 'REGRESSION');      // -20% boundary inclusive
  assert.equal(classifyDelta(9, 10).class, 'WARN');            // -10%
  assert.equal(classifyDelta(0, 10).class, 'REGRESSION');      // variant lost
  assert.equal(classifyDelta(5, 0).class, 'NEW_VARIANT');
  assert.equal(classifyDelta(70, 10).class, 'ANOMALY_GAIN');   // +600% ≥ +500%
});

test('Pass 1+2 identical packs → no findings', () => {
  const a = makePack({ banks: [makeBank({ bank_code: 'bank-a' })] });
  const findings = pass1and2_compare({ newPack: a, baselinePack: a, partialSilent: new Set() });
  assert.equal(findings.length, 0);
});

test('Pass 1+2 dropped bank → REGRESSION', () => {
  const baseline = makePack({ banks: [makeBank({ bank_code: 'bank-a' }), makeBank({ bank_code: 'bank-b' })] });
  const newPack = makePack({ banks: [makeBank({ bank_code: 'bank-a' })] });
  const findings = pass1and2_compare({ newPack, baselinePack: baseline, partialSilent: new Set() });
  const drop = findings.find((f) => f.bank_code === 'bank-b' && f.kind === 'bank');
  assert.ok(drop);
  assert.equal(drop.class, 'REGRESSION');
});

test('Pass 1+2 dropped bank flagged partial_silent → INFO', () => {
  const baseline = makePack({ banks: [makeBank({ bank_code: 'bank-a' }), makeBank({ bank_code: 'bank-b' })] });
  const newPack = makePack({ banks: [makeBank({ bank_code: 'bank-a' })] });
  const findings = pass1and2_compare({ newPack, baselinePack: baseline, partialSilent: new Set(['bank-b']) });
  const drop = findings.find((f) => f.bank_code === 'bank-b');
  assert.equal(drop.class, 'INFO');
});

test('Pass 1+2 added bank → GAIN', () => {
  const baseline = makePack({ banks: [makeBank({ bank_code: 'bank-a' })] });
  const newPack = makePack({ banks: [makeBank({ bank_code: 'bank-a' }), makeBank({ bank_code: 'bank-b' })] });
  const findings = pass1and2_compare({ newPack, baselinePack: baseline, partialSilent: new Set() });
  const add = findings.find((f) => f.bank_code === 'bank-b' && f.kind === 'bank');
  assert.ok(add);
  assert.equal(add.class, 'GAIN');
});

test('Pass 1+2 -25% slab on one variant → REGRESSION', () => {
  const baseline = makePack({ banks: [makeBank({ bank_code: 'bank-a', variants: { regular: 20 } })] });
  const newPack = makePack({ banks: [makeBank({ bank_code: 'bank-a', variants: { regular: 15 } })] });
  const findings = pass1and2_compare({ newPack, baselinePack: baseline, partialSilent: new Set() });
  const r = findings.find((f) => f.bank_code === 'bank-a' && f.variant === 'regular');
  assert.ok(r);
  assert.equal(r.class, 'REGRESSION');
});

test('Pass 1+2 -10% slab → WARN, not REGRESSION', () => {
  const baseline = makePack({ banks: [makeBank({ bank_code: 'bank-a', variants: { regular: 20 } })] });
  const newPack = makePack({ banks: [makeBank({ bank_code: 'bank-a', variants: { regular: 18 } })] });
  const findings = pass1and2_compare({ newPack, baselinePack: baseline, partialSilent: new Set() });
  const r = findings.find((f) => f.bank_code === 'bank-a' && f.variant === 'regular');
  assert.equal(r.class, 'WARN');
});

test('Pass 1+2 variant lost (nre disappears) → REGRESSION', () => {
  const baseline = makePack({ banks: [makeBank({ bank_code: 'bank-a', variants: { regular: 10, nre: 8 } })] });
  const newPack = makePack({ banks: [makeBank({ bank_code: 'bank-a', variants: { regular: 10 } })] });
  const findings = pass1and2_compare({ newPack, baselinePack: baseline, partialSilent: new Set() });
  const r = findings.find((f) => f.bank_code === 'bank-a' && f.variant === 'nre');
  assert.ok(r);
  assert.equal(r.class, 'REGRESSION');
});

test('Pass 3 rate_general_pct = 60 → ANOMALY', () => {
  const newPack = makePack({
    banks: [makeBank({
      bank_code: 'bank-a',
      variants: { regular: 0 },
      overrideSlabs: { regular: [makeSlab({ rate_general_pct: 60, rate_senior_pct: 60 })] },
    })],
  });
  const findings = pass3_anomalies({ newPack });
  const r = findings.find((f) => f.check === 'rate_general_out_of_band');
  assert.ok(r);
  assert.equal(r.class, 'ANOMALY');
});

test('Pass 3 senior < general → ANOMALY', () => {
  const newPack = makePack({
    banks: [makeBank({
      bank_code: 'bank-a',
      variants: { regular: 0 },
      overrideSlabs: { regular: [makeSlab({ rate_general_pct: 7.0, rate_senior_pct: 6.5 })] },
    })],
  });
  const findings = pass3_anomalies({ newPack });
  const r = findings.find((f) => f.check === 'senior_below_general');
  assert.ok(r);
});

test('Pass 3 fcnr slab missing currency → ANOMALY', () => {
  const newPack = makePack({
    banks: [makeBank({
      bank_code: 'bank-a',
      variants: { fcnr: 0 },
      overrideSlabs: { fcnr: [{ tenure_text: '1y', tenure_min_days: 365, tenure_max_days: 730, rate_general_pct: 4.0, rate_senior_pct: null, rate_super_senior_pct: null, deposit_range: 'below_3cr' }] },
    })],
  });
  const findings = pass3_anomalies({ newPack });
  const r = findings.find((f) => f.check === 'missing_currency');
  assert.ok(r);
});

test('Pass 3 inverted tenure range → ANOMALY', () => {
  const newPack = makePack({
    banks: [makeBank({
      bank_code: 'bank-a',
      variants: { regular: 0 },
      overrideSlabs: { regular: [makeSlab({ tenure_min_days: 500, tenure_max_days: 300 })] },
    })],
  });
  const findings = pass3_anomalies({ newPack });
  const r = findings.find((f) => f.check === 'inverted_tenure_range');
  assert.ok(r);
});

test('Pass 3 duplicate bank_code → ANOMALY', () => {
  const newPack = makePack({
    banks: [makeBank({ bank_code: 'bank-a' }), makeBank({ bank_code: 'bank-a' })],
  });
  const findings = pass3_anomalies({ newPack });
  const r = findings.find((f) => f.check === 'duplicate_bank_code');
  assert.ok(r);
});

test('applyAccepts masks matching regression when entry is signed (Sprint 005 Phase D2)', () => {
  const finding = { class: 'REGRESSION', bank_code: 'bank-a', variant: 'regular', baseline: 20, actual: 10, delta: -0.5, detail: 'drop' };
  const signedAccept = signAccept({
    bank_code: 'bank-a',
    variant: 'regular',
    finding_hash: computeFindingHash(finding),
    approved_by: 'test-operator',
    approved_at: new Date().toISOString(),
    reason: 'expected per ops',
  }, TEST_OPERATOR_KEY);

  const findings = [finding];
  applyAccepts(findings, {
    accepted_regressions: [signedAccept],
    accepted_anomalies: [],
  }, { operatorKey: TEST_OPERATOR_KEY });

  assert.equal(findings[0].accepted, true);
  assert.equal(findings[0].accept_reason, 'expected per ops');
  const summary = summarize(findings);
  assert.equal(summary.regressions, 1);
  assert.equal(summary.regressions_accepted, 1);
  assert.equal(verdictFromSummary(summary), 'PASS');
});

test('applyAccepts REJECTS unsigned accepts and emits a warning (Sprint 005 Phase D2)', () => {
  const finding = { class: 'REGRESSION', bank_code: 'bank-a', variant: 'regular', baseline: 20, actual: 10, delta: -0.5, detail: 'drop' };
  const acceptWarnings = [];
  applyAccepts([finding], {
    accepted_regressions: [{ bank_code: 'bank-a', variant: 'regular', reason: 'unsigned legacy' }],
    accepted_anomalies: [],
  }, { operatorKey: TEST_OPERATOR_KEY, acceptWarnings });
  assert.equal(finding.accepted, undefined, 'unsigned accept must be rejected');
  assert.ok(acceptWarnings.length > 0, 'a warning must be emitted');
  assert.match(acceptWarnings[0], /signature missing|REJECTED|unsigned/i);
});

test('applyAccepts REJECTS all accepts (signed or not) when operator key is missing — fail-closed', () => {
  const finding = { class: 'REGRESSION', bank_code: 'bank-a', variant: 'regular', baseline: 20, actual: 10, delta: -0.5 };
  const signedAccept = signAccept({
    bank_code: 'bank-a',
    variant: 'regular',
    finding_hash: computeFindingHash(finding),
    approved_by: 'test-operator',
    approved_at: new Date().toISOString(),
    reason: 'would be valid with a key',
  }, TEST_OPERATOR_KEY);
  const acceptWarnings = [];
  applyAccepts([finding], {
    accepted_regressions: [signedAccept],
    accepted_anomalies: [],
  }, { operatorKey: null, acceptWarnings });
  assert.equal(finding.accepted, undefined, 'fail-closed: no accept honored when key is missing');
  assert.ok(acceptWarnings.length > 0);
});

test('verdict BLOCK when unaccepted regression present', () => {
  const findings = [
    { class: 'REGRESSION', bank_code: 'bank-a', variant: 'regular', baseline: 20, actual: 10, delta: -0.5 },
  ];
  const summary = summarize(findings);
  assert.equal(verdictFromSummary(summary), 'BLOCK');
});

test('verdict PASS_WITH_WARNINGS when only warnings', () => {
  const findings = [
    { class: 'WARN', bank_code: 'bank-a', variant: 'regular', baseline: 20, actual: 18, delta: -0.1 },
  ];
  const summary = summarize(findings);
  assert.equal(verdictFromSummary(summary), 'PASS_WITH_WARNINGS');
});

test('runGate end-to-end on identical packs → PASS', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-'));
  const pack = makePack({ banks: [makeBank({ bank_code: 'bank-a' })] });
  const p1 = path.join(tmp, 'new.json');
  const p2 = path.join(tmp, 'baseline.json');
  fs.writeFileSync(p1, JSON.stringify(pack));
  fs.writeFileSync(p2, JSON.stringify(pack));
  const result = runGate({ newPath: p1, baselinePath: p2, acceptsPath: null, outDir: tmp, repoRoot: tmp });
  assert.equal(result.verdict, 'PASS');
  assert.ok(fs.existsSync(path.join(tmp, 'quality-report.md')));
  assert.ok(fs.existsSync(path.join(tmp, 'quality-report.json')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runGate end-to-end BLOCK when bank dropped', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-'));
  const baseline = makePack({ banks: [makeBank({ bank_code: 'a' }), makeBank({ bank_code: 'b' })] });
  const newP = makePack({ banks: [makeBank({ bank_code: 'a' })] });
  const p1 = path.join(tmp, 'new.json');
  const p2 = path.join(tmp, 'baseline.json');
  fs.writeFileSync(p1, JSON.stringify(newP));
  fs.writeFileSync(p2, JSON.stringify(baseline));
  const result = runGate({ newPath: p1, baselinePath: p2, acceptsPath: null, outDir: tmp, repoRoot: tmp });
  assert.equal(result.verdict, 'BLOCK');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runGate end-to-end PASS when accepts file has SIGNED accept for the dropped bank (Sprint 005 Phase D2)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-'));
  const baseline = makePack({ banks: [makeBank({ bank_code: 'a' }), makeBank({ bank_code: 'b' })] });
  const newP = makePack({ banks: [makeBank({ bank_code: 'a' })] });
  const p1 = path.join(tmp, 'new.json');
  const p2 = path.join(tmp, 'baseline.json');
  const aFile = path.join(tmp, 'accepts.json');
  const keyFile = path.join(tmp, 'operator.key');
  fs.writeFileSync(p1, JSON.stringify(newP));
  fs.writeFileSync(p2, JSON.stringify(baseline));
  fs.writeFileSync(keyFile, TEST_OPERATOR_KEY);

  // Dropped-bank finding is a kind=bank class=REGRESSION with the whole-bank totals.
  const droppedFinding = { class: 'REGRESSION', bank_code: 'b', variant: null, baseline: 1, actual: 0 };
  const signed = signAccept({
    bank_code: 'b',
    finding_hash: computeFindingHash(droppedFinding),
    approved_by: 'test-operator',
    approved_at: new Date().toISOString(),
    reason: 'bank closed merged into a',
  }, TEST_OPERATOR_KEY);

  fs.writeFileSync(aFile, JSON.stringify({
    _signed_format_version: SIGNED_FORMAT_VERSION,
    accepted_regressions: [signed],
    accepted_anomalies: [],
  }));

  const prevKeyEnv = process.env.RDA_OPERATOR_KEY_PATH;
  process.env.RDA_OPERATOR_KEY_PATH = keyFile;
  try {
    const result = runGate({ newPath: p1, baselinePath: p2, acceptsPath: aFile, outDir: tmp, repoRoot: tmp });
    assert.equal(result.verdict, 'PASS', `verdict was ${result.verdict}; warnings=${JSON.stringify(result.acceptWarnings)}`);
  } finally {
    if (prevKeyEnv == null) delete process.env.RDA_OPERATOR_KEY_PATH;
    else process.env.RDA_OPERATOR_KEY_PATH = prevKeyEnv;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runGate end-to-end stays BLOCK when accepts file has only UNSIGNED entries (Sprint 005 Phase D2)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-'));
  const baseline = makePack({ banks: [makeBank({ bank_code: 'a' }), makeBank({ bank_code: 'b' })] });
  const newP = makePack({ banks: [makeBank({ bank_code: 'a' })] });
  const p1 = path.join(tmp, 'new.json');
  const p2 = path.join(tmp, 'baseline.json');
  const aFile = path.join(tmp, 'accepts.json');
  const keyFile = path.join(tmp, 'operator.key');
  fs.writeFileSync(p1, JSON.stringify(newP));
  fs.writeFileSync(p2, JSON.stringify(baseline));
  fs.writeFileSync(keyFile, TEST_OPERATOR_KEY);
  fs.writeFileSync(aFile, JSON.stringify({
    accepted_regressions: [{ bank_code: 'b', reason: 'unsigned — would have passed pre-Sprint-005' }],
    accepted_anomalies: [],
  }));
  const prevKeyEnv = process.env.RDA_OPERATOR_KEY_PATH;
  process.env.RDA_OPERATOR_KEY_PATH = keyFile;
  try {
    const result = runGate({ newPath: p1, baselinePath: p2, acceptsPath: aFile, outDir: tmp, repoRoot: tmp });
    assert.equal(result.verdict, 'BLOCK', `unsigned accepts must NOT mask the regression; got ${result.verdict}`);
    assert.ok(result.acceptWarnings.length > 0, 'must surface a warning about the rejected unsigned entry');
  } finally {
    if (prevKeyEnv == null) delete process.env.RDA_OPERATOR_KEY_PATH;
    else process.env.RDA_OPERATOR_KEY_PATH = prevKeyEnv;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
