'use strict';

/**
 * Tests for lib/rates-qc.js — Sprint 011 item 21 (LLM extraction QC).
 *
 * Fixture provenance: tests/fixtures/rates-qc/*.json are VERBATIM copies of
 * output/latest/bank-of-baroda_fcnr_rates.json and
 * output/latest/idfc-first-bank-limited_fcnr_rates.json taken 2026-07-06,
 * while both still exhibited the 2026-06-16 audit defects:
 *   - BoB:  41 slabs (5 duplicates → 36 unique), effective_date "1st July 1995"
 *   - IDFC: 18 slabs (6 duplicates → 12 unique), effective_date "2026-02-26"
 * The originals in output/latest/ are real scraped data — never modify them;
 * the fixtures are frozen copies for regression purposes.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  qcRatesPayload,
  normalizeEffectiveDate,
  slabDedupKey,
} = require('../../lib/rates-qc');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'rates-qc');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
}

const silentLogger = { warn: () => {}, info: () => {} };

// Fixed clock so the stale-year floor (currentYear - 2 = 2024) is stable.
const NOW = new Date('2026-07-06T00:00:00Z');

// ── normalizeEffectiveDate — table-driven ───────────────────────────

const ACCEPT_CASES = [
  // [input, expected ISO]
  ['2026-06-09', '2026-06-09'],            // already ISO
  ['2026-6-9', '2026-06-09'],              // unpadded ISO → canonical
  ['01.07.2025', '2025-07-01'],            // dotted DD.MM.YYYY (Indian convention)
  ['07.02.2026', '2026-02-07'],            // ambiguous D.M vs M.D → day-first
  ['15/08/2025', '2025-08-15'],            // slashed day-first
  ['15-08-2025', '2025-08-15'],            // dashed numeric day-first
  ['01-Jun-2026', '2026-06-01'],           // day-Mon-year
  ['8th June 2026', '2026-06-08'],         // ordinal day + month word
  ['1st July 1995', '1995-07-01'],         // the BoB legalese date (parses fine; Q3 rejects it)
  ['22nd March 2026', '2026-03-22'],
  ['3rd Sept 2025', '2025-09-03'],         // 4-letter month abbrev
  ['June 8, 2026', '2026-06-08'],          // month-first
  ['Jun 8 2026', '2026-06-08'],
  ['w.e.f. 01.07.2025', '2025-07-01'],     // common Indian rate-page prefix
  ['  8th June 2026  ', '2026-06-08'],     // whitespace tolerance
];

const REJECT_CASES = [
  null,
  undefined,
  42,                       // non-string
  '',
  '   ',
  'not a date',
  'Rates are subject to change',
  '31.02.2026',             // impossible day for February
  '13.13.2026',             // month 13 (a true M.D input never mis-parses silently)
  '12.25.2025',             // US-format M.D.YYYY → month 25 invalid → reject, not mis-read
  '2026-13-01',             // ISO shape, invalid month
  '2026-02-30',             // ISO shape, invalid day
  '01.07.25',               // 2-digit year unsupported (ambiguous century)
  '1st Julio 1995',         // unknown month word
  '12345',
];

test('normalizeEffectiveDate: accepts every in-the-wild format', () => {
  for (const [input, expected] of ACCEPT_CASES) {
    assert.equal(normalizeEffectiveDate(input), expected, `input: ${JSON.stringify(input)}`);
  }
});

test('normalizeEffectiveDate: rejects unparseable / impossible inputs with null', () => {
  for (const input of REJECT_CASES) {
    assert.equal(normalizeEffectiveDate(input), null, `input: ${JSON.stringify(input)}`);
  }
});

// ── slabDedupKey ────────────────────────────────────────────────────

test('slabDedupKey: composite of tenure_text|currency|deposit_range|scheme_subtype, null → empty', () => {
  assert.equal(
    slabDedupKey({ tenure_text: '1 Yr < 15 Months', currency: 'USD', rate_general_pct: 4.5 }),
    '1 Yr < 15 Months|USD||',
  );
  assert.equal(
    slabDedupKey({ tenure_text: '1y', currency: 'USD', deposit_range: 'below_3cr', scheme_subtype: 'callable' }),
    '1y|USD|below_3cr|callable',
  );
});

// ── Fixture: bank-of-baroda (real copy, 2026-07-06) ─────────────────

test('BoB FCNR fixture: 41 → 36 slabs after dedup; garbage "1st July 1995" effective_date nulled', () => {
  const fixture = loadFixture('bank-of-baroda_fcnr_rates.json');
  assert.equal(fixture.rate_slabs.length, 41);            // fixture pre-conditions
  assert.equal(fixture.effective_date, '1st July 1995');
  assert.equal(fixture.extraction_method, 'llm_inline_extraction');

  const { payload, changes } = qcRatesPayload(fixture, {
    extractionMethod: 'llm_inline_extraction',
    logger: silentLogger,
    now: NOW,
  });

  assert.equal(payload.rate_slabs.length, 36);
  assert.equal(changes.dupes_removed, 5);
  assert.equal(payload.effective_date, null);
  assert.equal(changes.date_rejected, true);
  assert.equal(changes.date_normalised, false);
  assert.ok(
    payload.warnings.some((w) => /1st July 1995/.test(w) && /legalese/.test(w)),
    'expected a stale-year warning naming the original date',
  );
  // First-wins: the surviving slabs keep their original order/content
  assert.equal(payload.rate_slabs[0].tenure_text, fixture.rate_slabs[0].tenure_text);
});

test('BoB FCNR fixture: input payload is not mutated (pure function)', () => {
  const fixture = loadFixture('bank-of-baroda_fcnr_rates.json');
  const snapshot = JSON.stringify(fixture);
  qcRatesPayload(fixture, { extractionMethod: 'llm_inline_extraction', now: NOW });
  assert.equal(JSON.stringify(fixture), snapshot);
});

// ── Fixture: idfc-first-bank-limited (real copy, 2026-07-06) ────────

test('IDFC FCNR fixture: 18 → 12 slabs after dedup; valid ISO effective_date untouched', () => {
  const fixture = loadFixture('idfc-first-bank-limited_fcnr_rates.json');
  assert.equal(fixture.rate_slabs.length, 18);             // fixture pre-conditions
  assert.equal(fixture.effective_date, '2026-02-26');

  const { payload, changes } = qcRatesPayload(fixture, {
    extractionMethod: 'llm_inline_extraction',
    logger: silentLogger,
    now: NOW,
  });

  assert.equal(payload.rate_slabs.length, 12);
  assert.equal(changes.dupes_removed, 6);
  assert.equal(payload.effective_date, '2026-02-26');      // unchanged
  assert.equal(changes.date_rejected, false);
  assert.equal(changes.date_normalised, false);
  assert.equal(changes.under_extraction_suspected, false);
});

// ── Method gating ───────────────────────────────────────────────────

test('non-LLM method: effective_date normalised to ISO but duplicates are NOT removed', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'automatic_html_static',
    effective_date: '01.07.2025',
    rate_slabs: [
      { tenure_text: '1y', currency: 'USD', rate_general_pct: 5 },
      { tenure_text: '1y', currency: 'USD', rate_general_pct: 5 }, // dup — kept for non-LLM
    ],
  };
  const { payload, changes } = qcRatesPayload(input, { now: NOW });
  assert.equal(payload.effective_date, '2025-07-01');
  assert.equal(changes.date_normalised, true);
  assert.equal(payload.rate_slabs.length, 2);
  assert.equal(changes.dupes_removed, 0);
});

test('non-LLM method: ancient date is normalised, NOT nulled (stale-year rule is LLM-only)', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'automatic_pdf',
    effective_date: '1st July 1995',
    rate_slabs: [{ tenure_text: '1y', currency: 'USD', rate_general_pct: 5 }],
  };
  const { payload, changes } = qcRatesPayload(input, { now: NOW });
  assert.equal(payload.effective_date, '1995-07-01');
  assert.equal(changes.date_normalised, true);
  assert.equal(changes.date_rejected, false);
});

test('LLM stale-year rule exempts dates already in ISO form (scope: "AND no ISO format match")', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'llm_inline_extraction',
    effective_date: '1995-07-01', // old but structurally ISO — kept
    rate_slabs: [{ tenure_text: '1y', currency: 'USD', rate_general_pct: 5 }],
  };
  const { payload, changes } = qcRatesPayload(input, { now: NOW });
  assert.equal(payload.effective_date, '1995-07-01');
  assert.equal(changes.date_rejected, false);
});

test('LLM unparseable effective_date → null + warning', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'llm_inline_extraction',
    effective_date: 'rates revised recently',
    rate_slabs: [{ tenure_text: '1y', currency: 'USD', rate_general_pct: 5 }],
    warnings: ['pre-existing warning'],
  };
  const { payload, changes } = qcRatesPayload(input, { now: NOW });
  assert.equal(payload.effective_date, null);
  assert.equal(changes.date_rejected, true);
  assert.equal(payload.warnings.length, 2);
  assert.equal(payload.warnings[0], 'pre-existing warning'); // appended, not replaced
  assert.match(payload.warnings[1], /not a parseable date/);
});

test('manual_data_entry bypasses QC entirely (dupes + garbage date untouched, no warnings)', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'manual_data_entry',
    effective_date: '1st July 1995',
    rate_slabs: [
      { tenure_text: '1y', currency: 'USD', rate_general_pct: 5 },
      { tenure_text: '1y', currency: 'USD', rate_general_pct: 5 },
    ],
  };
  const { payload, changes, bypassed } = qcRatesPayload(input, { now: NOW });
  assert.equal(bypassed, true);
  assert.equal(payload, input); // same reference — untouched
  assert.equal(payload.effective_date, '1st July 1995');
  assert.equal(payload.rate_slabs.length, 2);
  assert.deepEqual(changes, {
    dupes_removed: 0,
    date_normalised: false,
    date_rejected: false,
    under_extraction_suspected: false,
  });
});

test('other curated methods (manual_image_transcription, pending_ocr) also bypass', () => {
  for (const method of ['manual_image_transcription', 'pending_ocr']) {
    const input = { bank_code: 'x', extraction_method: method, effective_date: '01.07.2025', rate_slabs: [] };
    const { bypassed, payload } = qcRatesPayload(input, { now: NOW });
    assert.equal(bypassed, true, method);
    assert.equal(payload.effective_date, '01.07.2025', method);
  }
});

// ── Under-extraction flag (Q4) ──────────────────────────────────────

test('under-extraction: LLM write with < 50% of prior slab count gets quality_warning', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'llm_inline_extraction',
    rate_slabs: Array.from({ length: 8 }, (_, i) => ({ tenure_text: `t${i}`, currency: 'USD' })),
  };
  const { payload, changes } = qcRatesPayload(input, { priorSlabCount: 20, now: NOW });
  assert.equal(changes.under_extraction_suspected, true);
  assert.ok(payload.warnings.some((w) => /under_extraction_suspected/.test(w) && /8 slab/.test(w) && /20 prior/.test(w)));
});

test('under-extraction: exactly 50% of prior is NOT flagged (strict <)', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'llm_inline_extraction',
    rate_slabs: Array.from({ length: 10 }, (_, i) => ({ tenure_text: `t${i}`, currency: 'USD' })),
  };
  const { changes } = qcRatesPayload(input, { priorSlabCount: 20, now: NOW });
  assert.equal(changes.under_extraction_suspected, false);
});

test('under-extraction: compares POST-dedup count against prior', () => {
  // 12 raw slabs but only 6 unique → 6 < 50% of 20 → flag fires
  const slab = { tenure_text: '1y', currency: 'USD', rate_general_pct: 5 };
  const input = {
    bank_code: 'x',
    extraction_method: 'llm_inline_extraction',
    rate_slabs: [
      ...Array.from({ length: 6 }, (_, i) => ({ ...slab, tenure_text: `t${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ ...slab, tenure_text: `t${i}` })), // exact dupes
    ],
  };
  const { payload, changes } = qcRatesPayload(input, { priorSlabCount: 20, now: NOW });
  assert.equal(payload.rate_slabs.length, 6);
  assert.equal(changes.dupes_removed, 6);
  assert.equal(changes.under_extraction_suspected, true);
});

test('under-extraction: not flagged when priorSlabCount is unknown', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'llm_inline_extraction',
    rate_slabs: [{ tenure_text: '1y', currency: 'USD' }],
  };
  const { changes } = qcRatesPayload(input, { now: NOW });
  assert.equal(changes.under_extraction_suspected, false);
});

test('under-extraction: zero-slab incoming is NOT flagged (safe-write Rule 2 owns that case)', () => {
  const input = { bank_code: 'x', extraction_method: 'llm_inline_extraction', rate_slabs: [] };
  const { changes } = qcRatesPayload(input, { priorSlabCount: 20, now: NOW });
  assert.equal(changes.under_extraction_suspected, false);
});

test('under-extraction: non-LLM methods are not flagged even below 50%', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'automatic_html_static',
    rate_slabs: [{ tenure_text: '1y', currency: 'USD' }],
  };
  const { changes } = qcRatesPayload(input, { priorSlabCount: 20, now: NOW });
  assert.equal(changes.under_extraction_suspected, false);
});

// ── Misc contract ───────────────────────────────────────────────────

test('missing/absent effective_date is left alone (no warning, no change)', () => {
  const input = { bank_code: 'x', extraction_method: 'llm_inline_extraction', rate_slabs: [] };
  const { payload, changes } = qcRatesPayload(input, { now: NOW });
  assert.equal('effective_date' in payload, false);
  assert.equal(changes.date_rejected, false);
  assert.equal(changes.date_normalised, false);
  assert.equal(payload.warnings, undefined); // no empty warnings field invented
});

test('non-object payload passes through untouched', () => {
  const { payload, changes } = qcRatesPayload(null, { now: NOW });
  assert.equal(payload, null);
  assert.equal(changes.dupes_removed, 0);
});

test('dedup is first-wins: retained slab is the earliest occurrence', () => {
  const input = {
    bank_code: 'x',
    extraction_method: 'llm_inline_extraction',
    rate_slabs: [
      { tenure_text: '1y', currency: 'USD', rate_general_pct: 5.0, marker: 'first' },
      { tenure_text: '1y', currency: 'USD', rate_general_pct: 5.5, marker: 'second' },
    ],
  };
  const { payload, changes } = qcRatesPayload(input, { now: NOW });
  assert.equal(changes.dupes_removed, 1);
  assert.equal(payload.rate_slabs.length, 1);
  assert.equal(payload.rate_slabs[0].marker, 'first');
});
