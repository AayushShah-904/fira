'use strict';

/**
 * Sprint 011 (2026-07-07) — OCR effective-date capture in
 * `lib/actions/extract_via_ocr.js`.
 *
 * Closes the gap where every OCR-extracted variant shipped
 * `effective_date: null` (the old line-737 hardcode) even though live DI
 * output carries the date in the table title row ("FCNR (B) DEPOSITS
 * Interest Rates | w.e.f. 13th June 2026") and/or a title paragraph.
 *
 * Date PARSING is delegated to normalizeEffectiveDate (lib/rates-qc.js) —
 * these tests cover the phrase scanning, source precedence (table cells →
 * document paragraphs/content), sanity window, and ambiguity resolution.
 *
 * All tests use the `_analyze` stub injection — no network / Azure calls —
 * and `_now` for a deterministic clock where the sanity window matters.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { extractViaOcr, _internals } = require('../../../lib/actions/extract_via_ocr');
const {
  findEffectiveDateCandidates,
  tableEffectiveDateCandidates,
  resolveEffectiveDate,
} = _internals;

const FIXTURE_PATH = path.resolve(__dirname, '..', '..', 'fixtures', 'di-axis-fcnr-rfc-2026-06-13.synthetic.json');
// eslint-disable-next-line import/no-dynamic-require
const axisFixture = require(FIXTURE_PATH);

// Deterministic clock for sanity-window tests: the fixture's w.e.f. date
// (2026-06-13) is in the past, today+7d grace ends 2026-07-14.
const NOW = '2026-07-07T00:00:00Z';

// ── Builders (mirror extract_via_ocr.test.js helpers) ───────────────

function makeCell(rowIndex, columnIndex, content, rowSpan = 1, columnSpan = 1) {
  return { rowIndex, columnIndex, content, rowSpan, columnSpan };
}

function makeTable(rows, cols, cells) {
  return { rowCount: rows, columnCount: cols, cells };
}

// Plain tenure|rate table. `headerDateText` (e.g. "w.e.f. 13th June 2026")
// rides the rate header cell — the common standard-shape carrier ("Rate of
// Interest (% p.a.) w.e.f. …"). The merged-TITLE-row carrier is exercised
// via the Pattern-B golden fixture; the standard path reads grid[0] as the
// header, so a title row there wouldn't extract slabs at all.
function makeRateTable(headerDateText = null) {
  const rateHeader = headerDateText ? `Rate of Interest ${headerDateText}` : 'Rate';
  return makeTable(3, 2, [
    makeCell(0, 0, 'Tenure'),
    makeCell(0, 1, rateHeader),
    makeCell(1, 0, '7 days'),
    makeCell(1, 1, '4.0%'),
    makeCell(2, 0, '1 year'),
    makeCell(2, 1, '6.5%'),
  ]);
}

// ── findEffectiveDateCandidates: phrase × format matrix ──────────────

test('findEffectiveDateCandidates: all supported phrases and date shapes', () => {
  const cases = [
    ['w.e.f. 13th June 2026', '2026-06-13'],
    ['FCNR (B) DEPOSITS Interest Rates | w.e.f. 13th June 2026', '2026-06-13'],
    ['with effect from 01.07.2026', '2026-07-01'],
    ['effective from 13-06-2026', '2026-06-13'],
    ['Effective Date: 2026-06-13', '2026-06-13'],
    ['Effective 13th June 2026', '2026-06-13'],
    ['as on June 13, 2026', '2026-06-13'],
    ['as of 13/06/2026', '2026-06-13'],
  ];
  for (const [text, iso] of cases) {
    const found = findEffectiveDateCandidates(text);
    assert.equal(found.length, 1, `expected 1 candidate in ${JSON.stringify(text)}`);
    assert.equal(found[0].iso, iso, `wrong ISO for ${JSON.stringify(text)}`);
  }
});

test('findEffectiveDateCandidates: no phrase / bare date / empty → no candidates', () => {
  assert.deepEqual(findEffectiveDateCandidates('Interest rates revised quarterly'), []);
  // A date WITHOUT an effective-date phrase must not be picked up (could be
  // anything — print date, tenure boundary, circular number).
  assert.deepEqual(findEffectiveDateCandidates('Circular 42 dated 13.06.2026 refers'), []);
  assert.deepEqual(findEffectiveDateCandidates(''), []);
  assert.deepEqual(findEffectiveDateCandidates(null), []);
});

test('findEffectiveDateCandidates: unparseable date after a phrase kept with iso=null', () => {
  const found = findEffectiveDateCandidates('w.e.f. 32.13.2026');
  assert.equal(found.length, 1);
  assert.equal(found[0].iso, null);
  assert.equal(found[0].raw, '32.13.2026');
});

test('tableEffectiveDateCandidates: reads a merged title row once (not per spanned column)', () => {
  const t = makeTable(2, 3, [
    makeCell(0, 0, 'DOMESTIC DEPOSITS | w.e.f. 13th June 2026', 1, 3),
    makeCell(1, 0, 'Tenure'),
    makeCell(1, 1, 'Rate'),
    makeCell(1, 2, 'Senior'),
  ]);
  const found = tableEffectiveDateCandidates(t);
  assert.equal(found.length, 1, 'columnSpan=3 title must yield ONE candidate, not three');
  assert.equal(found[0].iso, '2026-06-13');
  assert.deepEqual(tableEffectiveDateCandidates(makeRateTable()), []);
});

// ── resolveEffectiveDate: sanity window + ambiguity ─────────────────

test('resolveEffectiveDate: single valid date, no warnings', () => {
  const r = resolveEffectiveDate([{ raw: '13th June 2026', iso: '2026-06-13' }], new Date(NOW));
  assert.deepEqual(r, { date: '2026-06-13', warnings: [] });
});

test('resolveEffectiveDate: duplicates collapse without ambiguity warning', () => {
  const r = resolveEffectiveDate(
    [{ raw: 'a', iso: '2026-06-13' }, { raw: 'b', iso: '2026-06-13' }],
    new Date(NOW),
  );
  assert.deepEqual(r, { date: '2026-06-13', warnings: [] });
});

test('resolveEffectiveDate: multiple distinct dates → most recent ≤ today + warning', () => {
  const r = resolveEffectiveDate(
    [{ raw: 'a', iso: '2026-06-13' }, { raw: 'b', iso: '2026-07-01' }, { raw: 'c', iso: '2026-07-10' }],
    new Date(NOW), // today = 2026-07-07 → 2026-07-10 valid (≤ +7d) but future
  );
  assert.equal(r.date, '2026-07-01');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /ambiguous effective-date candidates/);
  assert.match(r.warnings[0], /using 2026-07-01/);
});

test('resolveEffectiveDate: far-future and pre-2020 dates rejected → null + warning', () => {
  for (const iso of ['2099-06-13', '2019-12-31']) {
    const r = resolveEffectiveDate([{ raw: iso, iso }], new Date(NOW));
    assert.equal(r.date, null, `${iso} must be rejected`);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /outside sanity window/);
    assert.match(r.warnings[0], new RegExp(iso));
  }
});

test('resolveEffectiveDate: only unparseable candidates → null + warning', () => {
  const r = resolveEffectiveDate([{ raw: '32.13.2026', iso: null }], new Date(NOW));
  assert.equal(r.date, null);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not parseable/);
  assert.match(r.warnings[0], /32\.13\.2026/);
});

test('resolveEffectiveDate: no candidates → null, no warnings', () => {
  assert.deepEqual(resolveEffectiveDate([], new Date(NOW)), { date: null, warnings: [] });
});

// ── extractViaOcr integration ───────────────────────────────────────

test('golden fixture: FCNR page gets effective_date 2026-06-13 from the w.e.f. title row', async () => {
  const out = await extractViaOcr({
    url: 'file:///fixtures/fcnr-rfc-deposits-13-june-26.pdf',
    variant: 'fcnr',
    _now: NOW,
    _analyze: async () => axisFixture,
  });
  assert.equal(out.ok, true);
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].effective_date, '2026-06-13');
  assert.deepEqual(out.pages[0].warnings, [], 'unambiguous date → no warnings');
});

test('paragraph fallback: table without a date uses "with effect from 01.07.2026" paragraph', async () => {
  const out = await extractViaOcr({
    url: 'https://example.com/rates.pdf',
    variant: 'regular',
    _now: NOW,
    _analyze: async () => ({
      pages: [{ pageNumber: 1 }],
      paragraphs: [{ content: 'Domestic Term Deposit rates with effect from 01.07.2026' }],
      tables: [makeRateTable()],
    }),
  });
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].effective_date, '2026-07-01');
  assert.deepEqual(out.pages[0].warnings, []);
});

test('date in the table\'s own cells wins over a differing document-level date', async () => {
  const out = await extractViaOcr({
    url: 'https://example.com/rates.pdf',
    variant: 'regular',
    _now: NOW,
    _analyze: async () => ({
      pages: [{ pageNumber: 1 }],
      paragraphs: [{ content: 'Archive of rates as on 01.01.2026' }],
      tables: [makeRateTable('w.e.f. 13th June 2026')],
    }),
  });
  assert.equal(out.pages[0].effective_date, '2026-06-13', 'nearest source (table cells) wins');
  assert.deepEqual(out.pages[0].warnings, []);
});

test('no date anywhere → effective_date null, no warnings (genuinely absent, not fabricated)', async () => {
  const out = await extractViaOcr({
    url: 'https://example.com/rates.jpg',
    variant: 'regular',
    _now: NOW,
    _analyze: async () => ({
      pages: [{ pageNumber: 1 }],
      paragraphs: [{ content: 'Term Deposit Interest Rates' }],
      tables: [makeRateTable()],
    }),
  });
  assert.equal(out.pages[0].effective_date, null);
  assert.deepEqual(out.pages[0].warnings, []);
});

test('far-future date in the table → null + sanity-window warning', async () => {
  const out = await extractViaOcr({
    url: 'https://example.com/rates.pdf',
    variant: 'regular',
    _now: NOW,
    _analyze: async () => ({
      pages: [{ pageNumber: 1 }],
      paragraphs: [],
      tables: [makeRateTable('w.e.f. 13th June 2099')],
    }),
  });
  assert.equal(out.pages[0].effective_date, null);
  assert.equal(out.pages[0].warnings.length, 1);
  assert.match(out.pages[0].warnings[0], /outside sanity window/);
});

test('garbage date after phrase → null + not-parseable warning', async () => {
  const out = await extractViaOcr({
    url: 'https://example.com/rates.pdf',
    variant: 'regular',
    _now: NOW,
    _analyze: async () => ({
      pages: [{ pageNumber: 1 }],
      paragraphs: [],
      tables: [makeRateTable('w.e.f. 32.13.2026')],
    }),
  });
  assert.equal(out.pages[0].effective_date, null);
  assert.equal(out.pages[0].warnings.length, 1);
  assert.match(out.pages[0].warnings[0], /not parseable/);
});
