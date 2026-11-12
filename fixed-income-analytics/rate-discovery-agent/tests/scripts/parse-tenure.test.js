'use strict';

/**
 * Tests for scripts/utils/parse-tenure.js — covers the patterns observed
 * across the 200-bank top tier. See
 * sdlc/sprints/sprint-003/implementation/tenure-parse-and-dedup-fix-2026-05-18.md
 * for the catalogue of phrasings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTenure } = require('../../scripts/utils/parse-tenure');

const POSITIVE = [
  // [input, expected min, expected max, comment]
  ['7 days to 14 days',        7,    14,   'canonical range'],
  ['7 - 14 days',              7,    14,   'hyphen range, unit shared at end (HDFC)'],
  ['7-14 days',                7,    14,   'hyphen range no spaces'],
  ['7 – 14 days',         7,    14,   'en-dash range'],
  ['7 — 14 days',         7,    14,   'em-dash range'],
  ['46 days to less than 1 year', 46, 364, '"less than" upper bound qualifier'],
  ['1 year to less than 2 years', 365, 729, 'mixed unit range with less than'],
  ['21 months to 2 years',     630,  730,  'mixed-unit range'],
  ['1 Yr',                     365,  365,  'abbreviated single (AU SFB)'],
  ['6 Mos',                    180,  180,  'months abbreviated'],
  ['888 D',                    888,  888,  'days abbreviated as D'],
  ['above 5 years',            1826, 3650, '"above N units" (no upper bound)'],
  ['1 year and above',         365,  3650, '"N units and above"'],
  ['5 years and above',        1825, 3650, '"N years and above"'],
  ['444 days',                 444,  444,  'special tenure single value'],
  // A3 (slab-quality-anomalies-2026-05-18) — HDFC family
  ['9 months 1 day to < 1 Year', 271, 364, 'multi-unit left + strict-less upper (HDFC)'],
  ['1 Year to < 15 months',    365,  449,  'cross-unit range with strict-less upper'],
  ['90 days <= 6 months',      90,   180,  '"<=" inclusive upper bound'],
  ['6 months 1 day <=9 months', 181, 270,  '"<=" with no surrounding spaces'],
  ['2 Years 1 day to < 2 Year 11 Months', 731, 1059, 'multi-unit both sides + strict-less'],
  ['2 Years 11 Months (35 months)', 1060, 1060, 'parenthetical commentary stripped'],
  ['2 Years 11 Months 1 day <= 3 Year', 1061, 1095, 'three-token left compound'],
  ['4 Year 7 Months (55 months)', 1670, 1670, 'parenthetical stripped, compound months'],
  ['4 Year 7 Months 1 day <=5 Years', 1671, 1825, '"<=" with multi-unit left'],
  ['15 months to < 18 months', 450,  539,  'months range with strict-less upper'],
  ['444 Days (AMRIT VRISHTI)', 444,  444,  'parenthetical name stripped'],
  // Sprint 4 A15-support — bare ">= N units" / "> N units" forms (Equitas FCNR)
  ['>= 12 month',              360,  3650, 'bare ">= N" inclusive lower bound (Equitas FCNR)'],
  ['>=12 month',               360,  3650, 'bare ">=" no space'],
  ['> 18 months',              541,  3650, 'bare ">" exclusive lower bound'],
  ['>18 months',               541,  3650, 'bare ">" no space'],
  ['>= 1 year',                365,  3650, 'bare ">= N years"'],
  ['> 5 years',                1826, 3650, 'bare ">" with years'],
];

for (const [input, minDays, maxDays, comment] of POSITIVE) {
  test(`parseTenure: "${input}" → ${minDays}..${maxDays}  (${comment})`, () => {
    const result = parseTenure(input);
    assert.ok(result, `expected non-null for "${input}"`);
    assert.equal(result.minDays, minDays);
    assert.equal(result.maxDays, maxDays);
  });
}

const NEGATIVE = [
  ['not a tenure',           'unrecognised'],
  ['',                       'empty'],
  ['Up to Rs.5.00 lacs',     'deposit-amount tier, not a tenure (caught by non_fd_filter)'],
  ['Premature withdrawal',   'penalty rule, not a tenure'],
];

for (const [input, comment] of NEGATIVE) {
  test(`parseTenure: "${input}" → null  (${comment})`, () => {
    assert.equal(parseTenure(input), null);
  });
}

// "5 m" / "15M" — bare "m" now treated as months (Sprint 7, 2026-05-24).
// The previous behavior left bare "m" unparsed because of theoretical
// confusion with minutes; in practice the parser is only invoked on cells
// the LLM has mapped as `tenure_text`, so minutes-collision risk is zero.
// Required for BoB bulk cells "Above 1Y to 15M" / "Above 15M to 2Y".
test('parseTenure: bare "m" now resolves as months (BoB bulk cells)', () => {
  assert.deepEqual(parseTenure('5 m'),   { minDays: 150, maxDays: 150 });
  assert.deepEqual(parseTenure('15M'),   { minDays: 450, maxDays: 450 });
});

test('parseTenure: BoB-style ranges with "upto" and Y/M aliases', () => {
  assert.deepEqual(parseTenure('Above 1Y to 15M'),               { minDays: 366,  maxDays: 450 });
  assert.deepEqual(parseTenure('Above 5Y and upto 10Y'),         { minDays: 1826, maxDays: 3650 });
  assert.deepEqual(parseTenure('Above 400 days and upto 500 days'), { minDays: 401, maxDays: 500 });
  assert.deepEqual(parseTenure('Above 15M to 2Y'),               { minDays: 451,  maxDays: 730 });
});
