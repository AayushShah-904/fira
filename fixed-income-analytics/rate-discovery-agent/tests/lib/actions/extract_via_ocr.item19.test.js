'use strict';

/**
 * Sprint 011 A2 / item 19 (2026-07-06) — per-table variant classification +
 * footnote capture in `lib/actions/extract_via_ocr.js`.
 *
 * Golden fixture: tests/fixtures/di-axis-fcnr-rfc-2026-06-13.synthetic.json —
 * a SYNTHETIC (no captured AnalyzeResult from the 2026-06-15 Axis session
 * survived) but structurally faithful DI prebuilt-layout result for the Axis
 * fcnr-rfc-deposits-13-june-26.pdf pattern: FCNR(B) (35 slabs, JPY present) +
 * RFC Term (36 slabs, no JPY) + RFC Savings (0 rows) on one page, with
 * section-heading paragraphs and the RBI Jun–Sep 2026 lock-in footnote whose
 * '#' marker rides the 3–5 year FCNR tenure rows.
 *
 * All tests use the `_analyze` stub injection — no network / Azure calls.
 * The extractor writes no files, so no temp dirs are needed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { extractViaOcr, _internals } = require('../../../lib/actions/extract_via_ocr');
const {
  matchHeadingVariant,
  classifyTableVariant,
  collectRegulatoryConstraints,
  detectRfcSignal,
  extractTenureFlagKeys,
  regionOf,
} = _internals;

const FIXTURE_PATH = path.resolve(__dirname, '..', '..', 'fixtures', 'di-axis-fcnr-rfc-2026-06-13.synthetic.json');
// eslint-disable-next-line import/no-dynamic-require
const axisFixture = require(FIXTURE_PATH);

// ── Small builders (mirror extract_via_ocr.test.js helpers) ─────────

function makeCell(rowIndex, columnIndex, content, rowSpan = 1, columnSpan = 1) {
  return { rowIndex, columnIndex, content, rowSpan, columnSpan };
}

function poly(x1, y1, x2, y2) {
  return [x1, y1, x2, y1, x2, y2, x1, y2];
}

function region(y1, y2) {
  return [{ pageNumber: 1, polygon: poly(0.5, y1, 8.0, y2) }];
}

function makeLogCapture() {
  const lines = [];
  return {
    lines,
    logger: {
      info: (m) => lines.push(String(m)),
      warn: (m) => lines.push(String(m)),
      debug: () => {},
    },
  };
}

// A minimal Pattern-B currency table with configurable currency menu + y-band.
function makeCurrencyTable(currencies, y1, y2, rateBase = 4.0) {
  const cols = 1 + currencies.length;
  const cells = [makeCell(0, 0, 'Maturity Period')];
  currencies.forEach((c, i) => cells.push(makeCell(0, 1 + i, c)));
  const tenures = ['1 year < 2 years', '2 years < 3 years'];
  tenures.forEach((t, r) => {
    cells.push(makeCell(1 + r, 0, t));
    currencies.forEach((_, i) => cells.push(makeCell(1 + r, 1 + i, (rateBase + r * 0.1 + i * 0.01).toFixed(2))));
  });
  return {
    rowCount: 1 + tenures.length,
    columnCount: cols,
    cells,
    boundingRegions: region(y1, y2),
  };
}

// ── Golden: Axis-pattern three-section fixture ──────────────────────

test('item19 golden: only the FCNR table ships, classified fcnr', async () => {
  const { lines, logger } = makeLogCapture();
  const out = await extractViaOcr({
    url: 'file:///fixtures/fcnr-rfc-deposits-13-june-26.pdf',
    variant: 'fcnr',
    logger,
    _analyze: async () => axisFixture,
  });
  assert.equal(out.ok, true);
  // Exactly one page survives (the FCNR table); RFC Term dropped, RFC Savings has 0 rows.
  assert.equal(out.pages.length, 1, 'only the FCNR table becomes a page');
  assert.equal(out.pages[0].variant, 'fcnr');
  assert.equal(out.pages[0].slabs.length, 35, '5 tenures × 7 currency cols = 35 FCNR slabs');
  // JPY present in the shipped slabs (FCNR signature currency)
  assert.ok(out.pages[0].slabs.some((s) => s.currency === 'JPY'));
  // No RFC tenure leaked into the FCNR payload
  assert.ok(!out.pages[0].slabs.some((s) => /30 days|46 days|91 days|181 days/.test(s.tenure_text)));
  // RFC Term dropped with the operator-visible log line
  assert.equal(out.dropped_slab_counts.rfc_term, 36);
  assert.equal(out.dropped_slab_counts.rfc_savings, undefined, 'RFC Savings strip yields 0 slabs — nothing to drop');
  assert.ok(
    lines.some((l) => l === '[ocr] dropped 36 rfc_term slabs (not in pack schema)'),
    `expected drop log line, got: ${JSON.stringify(lines)}`,
  );
  // lines from makeLogCapture also include the standard page/table info line — fine.
});

test('item19 golden: RBI lock-in footnote captured as regulatory_constraints', async () => {
  const out = await extractViaOcr({
    url: 'file:///fixtures/fcnr-rfc-deposits-13-june-26.pdf',
    variant: 'fcnr',
    _analyze: async () => axisFixture,
  });
  assert.ok(Array.isArray(out.regulatory_constraints));
  assert.equal(out.regulatory_constraints.length, 1);
  assert.match(out.regulatory_constraints[0], /RBI regulatory guidelines/);
  assert.match(out.regulatory_constraints[0], /mandatory lock-in period of one year/);
  // Section headings / title must NOT be captured as constraints
  assert.ok(!out.regulatory_constraints.some((c) => /^FCNR \(B\) Deposits$/.test(c)));
});

test('item19 golden: #-marked tenures carry regulatory_flag_keys, marker stripped from tenure_text', async () => {
  const out = await extractViaOcr({
    url: 'file:///fixtures/fcnr-rfc-deposits-13-june-26.pdf',
    variant: 'fcnr',
    _analyze: async () => axisFixture,
  });
  const slabs = out.pages[0].slabs;
  const flagged = slabs.filter((s) => Array.isArray(s.regulatory_flag_keys));
  // 3 lock-in tenures (3y<4y, 4y<5y, 5y) × 7 currency cols = 21 flagged slabs
  assert.equal(flagged.length, 21);
  for (const s of flagged) {
    assert.deepEqual(s.regulatory_flag_keys, ['#']);
    assert.ok(!s.tenure_text.includes('#'), `marker must be stripped from tenure_text: "${s.tenure_text}"`);
  }
  // 1y and 2y tenures are unflagged
  const unflagged = slabs.filter((s) => /^(1 year|2 years)/.test(s.tenure_text));
  assert.equal(unflagged.length, 14);
  assert.ok(unflagged.every((s) => s.regulatory_flag_keys === undefined));
});

// ── Negative: single-section FCNR-only document ─────────────────────

test('item19 negative: FCNR-only doc — variant stays fcnr, no drops, no constraints', async () => {
  const { lines, logger } = makeLogCapture();
  const analyzeResult = {
    pages: [{ pageNumber: 1, width: 8.5, height: 11, unit: 'inch' }],
    paragraphs: [
      { content: 'FCNR (B) Deposits — Interest Rates', role: 'sectionHeading', boundingRegions: region(0.5, 0.7) },
    ],
    tables: [makeCurrencyTable(['USD', 'GBP', 'EURO', 'JPY'], 1.0, 3.0)],
  };
  const out = await extractViaOcr({
    url: 'file:///fixtures/fcnr-only.pdf',
    variant: 'fcnr',
    logger,
    _analyze: async () => analyzeResult,
  });
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].variant, 'fcnr');
  assert.equal(out.pages[0].slabs.length, 8, '2 tenures × 4 currencies');
  assert.equal(out.dropped_slab_counts, undefined, 'no spurious rfc drops');
  assert.equal(out.regulatory_constraints, undefined, 'no footnote → field omitted');
  assert.ok(!lines.some((l) => /dropped/.test(l)), 'no drop log lines');
});

test('item19 negative: non-JPY currency menu WITHOUT an RFC signal stays fcnr (heuristic gated)', async () => {
  // A legitimate FCNR-only bank whose menu is USD/GBP/EUR (no JPY) must NOT
  // be demoted to rfc_term when the document shows no RFC section at all.
  const out = await extractViaOcr({
    url: 'file:///fixtures/fcnr-usd-gbp-eur.pdf',
    variant: 'fcnr',
    _analyze: async () => ({
      pages: [{ pageNumber: 1 }],
      paragraphs: [],
      tables: [makeCurrencyTable(['USD', 'GBP', 'EURO'], 1.0, 3.0)],
    }),
  });
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].variant, 'fcnr');
  assert.equal(out.dropped_slab_counts, undefined);
});

test('item19 heuristic: unlabelled doc, differing JPY presence → non-JPY table dropped as rfc_term', async () => {
  // No usable headings (empty paragraphs); two currency tables where JPY
  // presence differs is itself the RFC signal (Axis-pattern, image-only scan).
  const { lines, logger } = makeLogCapture();
  const out = await extractViaOcr({
    url: 'file:///fixtures/unlabelled-fcnr-rfc.pdf',
    variant: 'fcnr',
    logger,
    _analyze: async () => ({
      pages: [{ pageNumber: 1 }],
      paragraphs: [],
      tables: [
        makeCurrencyTable(['USD', 'GBP', 'EURO', 'JPY'], 1.0, 3.0, 4.0),
        makeCurrencyTable(['USD', 'GBP', 'EURO'], 4.0, 6.0, 2.0),
      ],
    }),
  });
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].variant, 'fcnr');
  assert.equal(out.pages[0].slabs.length, 8);
  assert.equal(out.dropped_slab_counts.rfc_term, 6, '2 tenures × 3 currencies dropped');
  assert.ok(lines.some((l) => l === '[ocr] dropped 6 rfc_term slabs (not in pack schema)'));
});

// ── Unit: helpers ───────────────────────────────────────────────────

test('matchHeadingVariant: keyword map (RFC before FCNR)', () => {
  assert.equal(matchHeadingVariant('FCNR (B) Deposits'), 'fcnr');
  assert.equal(matchHeadingVariant('RFC Term Deposits'), 'rfc_term');
  assert.equal(matchHeadingVariant('RFC Savings Deposits'), 'rfc_savings');
  assert.equal(matchHeadingVariant('NRE Fixed Deposits'), 'nre');
  assert.equal(matchHeadingVariant('NRO Fixed Deposits'), 'nro');
  assert.equal(matchHeadingVariant('Domestic Term Deposits'), 'regular');
  assert.equal(matchHeadingVariant('Savings Account'), null);
  assert.equal(matchHeadingVariant(''), null);
});

test('classifyTableVariant: nearest preceding heading wins; earlier sections are fenced off', () => {
  const t0 = makeCurrencyTable(['USD', 'GBP', 'JPY'], 1.4, 3.6);
  const t1 = makeCurrencyTable(['USD', 'GBP'], 4.0, 6.5, 2.0);
  const paragraphs = [
    { content: 'FCNR (B) Deposits', boundingRegions: region(1.0, 1.2) },
    { content: 'RFC Term Deposits', boundingRegions: region(3.7, 3.9) },
  ];
  assert.equal(classifyTableVariant(t0, [t0, t1], paragraphs, 'fcnr', true), 'fcnr');
  // t1's search band starts at t0's bottom — it must NOT see the FCNR heading
  assert.equal(classifyTableVariant(t1, [t0, t1], paragraphs, 'fcnr', true), 'rfc_term');
});

test('classifyTableVariant: no headings, no rfc signal → input variant kept', () => {
  const t = makeCurrencyTable(['USD', 'GBP'], 1.0, 3.0);
  assert.equal(classifyTableVariant(t, [t], [], 'fcnr', false), 'fcnr');
  assert.equal(classifyTableVariant(t, [t], [], 'regular', false), 'regular');
});

test('detectRfcSignal: paragraph mention or differing JPY presence', () => {
  assert.equal(detectRfcSignal([{ content: 'RFC Term Deposits' }], []), true);
  assert.equal(detectRfcSignal([{ content: 'FCNR (B) Deposits' }], []), false);
  const jpy = makeCurrencyTable(['USD', 'JPY'], 1, 3);
  const noJpy = makeCurrencyTable(['USD', 'GBP'], 4, 6);
  assert.equal(detectRfcSignal([], [jpy, noJpy]), true);
  assert.equal(detectRfcSignal([], [jpy]), false);
  assert.equal(detectRfcSignal([], [noJpy, noJpy]), false, 'uniform non-JPY menus are not a signal');
});

test('extractTenureFlagKeys: distinct markers, empty otherwise', () => {
  assert.deepEqual(extractTenureFlagKeys('3 years < 4 years#'), ['#']);
  assert.deepEqual(extractTenureFlagKeys('1 year*'), ['*']);
  assert.deepEqual(extractTenureFlagKeys('5 years#*'), ['#', '*']);
  assert.deepEqual(extractTenureFlagKeys('7 days'), []);
  assert.deepEqual(extractTenureFlagKeys(''), []);
});

test('collectRegulatoryConstraints: keyword match without a marker; page furniture skipped', () => {
  const analyzeResult = {
    tables: [makeCurrencyTable(['USD', 'GBP'], 1.0, 3.0)],
    paragraphs: [
      { content: 'Note: rates are subject to RBI directions.', boundingRegions: region(3.5, 3.7) },
      { content: 'Page 1 of 1', role: 'pageNumber', boundingRegions: region(10.5, 10.7) },
      { content: 'www.example.bank.in', role: 'pageFooter', boundingRegions: region(10.5, 10.7) },
      { content: 'Maturity buckets follow board policy.', boundingRegions: region(4.0, 4.2) },
    ],
  };
  const out = collectRegulatoryConstraints(analyzeResult);
  assert.deepEqual(out, ['Note: rates are subject to RBI directions.']);
});

test('regionOf: y-extent from polygon; null without boundingRegions', () => {
  const r = regionOf({ boundingRegions: [{ pageNumber: 2, polygon: poly(0.5, 1.4, 8.0, 3.6) }] });
  assert.deepEqual(r, { page: 2, top: 1.4, bottom: 3.6 });
  assert.equal(regionOf({}), null);
  assert.equal(regionOf(null), null);
});
