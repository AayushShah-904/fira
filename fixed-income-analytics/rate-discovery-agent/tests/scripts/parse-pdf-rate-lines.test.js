'use strict';

/**
 * Tests for scripts/utils/parse-pdf-rate-lines.js — M2.3 (sprint-004
 * 2026-05-21). The legacy 3-column regex parser (parseRateLines) keeps
 * its existing behaviour; the new column-aware parser
 * (parseRateLinesWithHint) emits one slab per (tenure × column) when a
 * per-page hint declares the column layout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRateLines,
  parseRateLinesWithHint,
  normalizeTenureText,
} = require('../../scripts/utils/parse-pdf-rate-lines.js');

// ── Legacy parser (no regression) ───────────────────────────────────

// Historical limitation (discovered during M2.3, see helper module note):
// the legacy RATE_LINE_PATTERN regex's `\s*` after the first rate capture
// consumes tabs, so the optional senior/super-senior groups are never
// reached on any tab-separated input. Production PDFs have only ever
// populated rate_general_pct via this path. M2.3 parseRateLinesWithHint
// is the path that captures multi-column rates correctly. Pinning the
// legacy behaviour here so a future regex tweak that "fixes" the latent
// bug doesn't silently change pack contents without a thought.
test('parseRateLines: legacy regex captures rate_general_pct only (latent limitation)', () => {
  const lines = ['7 days to 14 days\t\t3.00\t\t3.50\t\t4.00'];
  const { slabs } = parseRateLines(lines);
  assert.equal(slabs.length, 1);
  assert.equal(slabs[0].rate_general_pct, 3.0);
  assert.equal(slabs[0].rate_senior_pct, null,
    'pre-existing limitation: \\s* after first rate consumes the tab, so this capture never fires');
  assert.equal(slabs[0].rate_super_senior_pct, null);
});

test('parseRateLines: single-rate line', () => {
  const lines = ['1 year to 2 years\t\t6.50'];
  const { slabs } = parseRateLines(lines);
  assert.equal(slabs.length, 1);
  assert.equal(slabs[0].rate_general_pct, 6.5);
  assert.equal(slabs[0].rate_senior_pct, null);
});

test('parseRateLines: skips header-like lines', () => {
  const lines = ['Tenor\t\tGeneral\t\tSenior', '7 days to 14 days\t\t3.00\t\t3.50'];
  const { slabs } = parseRateLines(lines);
  assert.equal(slabs.length, 1);
});

// ── M2.3 column-aware parser ────────────────────────────────────────

const AXIS_PAGE_1_HINT = {
  page: 1,
  columns: [
    { age_tier: 'general', deposit_range: 'below_3cr' },
    { age_tier: 'general', deposit_range: '3cr_to_5cr' },
    { age_tier: 'senior',  deposit_range: 'below_3cr' },
    { age_tier: 'senior',  deposit_range: '3cr_to_5cr' },
  ],
};

test('parseRateLinesWithHint: 4-column line emits 4 slabs per tenure', () => {
  // Axis-shaped line: tenure followed by 4 rate values
  const lines = ['1 year to 2 years\t6.25\t6.25\t6.75\t6.75'];
  const { slabs } = parseRateLinesWithHint(lines, AXIS_PAGE_1_HINT);
  assert.equal(slabs.length, 4);

  // General < 3cr
  assert.equal(slabs[0].rate_general_pct, 6.25);
  assert.equal(slabs[0].rate_senior_pct, null);
  assert.equal(slabs[0].deposit_range, 'below_3cr');

  // General 3-5cr
  assert.equal(slabs[1].rate_general_pct, 6.25);
  assert.equal(slabs[1].deposit_range, '3cr_to_5cr');

  // Senior < 3cr
  assert.equal(slabs[2].rate_general_pct, null);
  assert.equal(slabs[2].rate_senior_pct, 6.75);
  assert.equal(slabs[2].deposit_range, 'below_3cr');

  // Senior 3-5cr
  assert.equal(slabs[3].rate_senior_pct, 6.75);
  assert.equal(slabs[3].deposit_range, '3cr_to_5cr');
});

test('parseRateLinesWithHint: 7-column bulk-tier line (Axis page 2 shape)', () => {
  const hint = {
    page: 2,
    columns: [
      { age_tier: 'general', deposit_range: '5cr_to_25cr' },
      { age_tier: 'general', deposit_range: '25cr_to_50cr' },
      { age_tier: 'general', deposit_range: '50cr_to_100cr' },
      { age_tier: 'general', deposit_range: '100cr_to_200cr' },
      { age_tier: 'general', deposit_range: '200cr_to_500cr' },
      { age_tier: 'general', deposit_range: '500cr_to_1000cr' },
      { age_tier: 'general', deposit_range: 'above_1000cr' },
    ],
  };
  const lines = ['1 year to 2 years\t7.00\t7.10\t7.15\t7.20\t7.25\t7.30\t7.35'];
  const { slabs } = parseRateLinesWithHint(lines, hint);
  assert.equal(slabs.length, 7);
  const ranges = slabs.map((s) => s.deposit_range);
  assert.deepEqual(ranges, [
    '5cr_to_25cr', '25cr_to_50cr', '50cr_to_100cr',
    '100cr_to_200cr', '200cr_to_500cr', '500cr_to_1000cr', 'above_1000cr',
  ]);
  assert.equal(slabs[0].rate_general_pct, 7.0);
  assert.equal(slabs[6].rate_general_pct, 7.35);
});

test('parseRateLinesWithHint: tenure with internal numbers (e.g. "7 14 days") still picks last N values', () => {
  // "7-14 Days" extracted by pdfjs often comes through as "7 14 days" with the
  // hyphen lost between the two numbers. The hint parser must skip those as
  // tenure-numbers and take the LAST `columns.length` numerics as the rates.
  const lines = ['7 - 14 Days\t3.00\t3.00\t3.50\t3.50'];
  const { slabs } = parseRateLinesWithHint(lines, AXIS_PAGE_1_HINT);
  assert.equal(slabs.length, 4);
  // First rate is the third numeric token (after 7 and 14); ensure tenure_text
  // doesn't accidentally include the first rate value.
  assert.ok(/\d+\s*[-–]?\s*14/.test(slabs[0].tenure_text), `tenure_text was: ${slabs[0].tenure_text}`);
  assert.equal(slabs[0].rate_general_pct, 3.0);
});

test('parseRateLinesWithHint: empty columns array falls back to legacy parser', () => {
  const lines = ['7 days to 14 days\t3.00\t3.50\t4.00'];
  const { slabs, warnings } = parseRateLinesWithHint(lines, { page: 1, columns: [] });
  assert.equal(slabs.length, 1);
  assert.ok(warnings.some((w) => /falling back/i.test(w)));
});

test('parseRateLinesWithHint: line with fewer numbers than columns is skipped', () => {
  // 4 columns expected but the row has only 2 rate values (truncated row)
  const lines = ['1 year\t6.25\t6.50'];
  const { slabs } = parseRateLinesWithHint(lines, AXIS_PAGE_1_HINT);
  assert.equal(slabs.length, 0);
});

test('parseRateLinesWithHint: skips header rows and lines without tenure cue', () => {
  const lines = [
    'Tenor\tGeneral\tSenior\tSuper',
    'Some heading not a rate row',
    '1 year to 2 years\t6.25\t6.25\t6.75\t6.75',
  ];
  const { slabs } = parseRateLinesWithHint(lines, AXIS_PAGE_1_HINT);
  assert.equal(slabs.length, 4); // only the valid tenure row × 4 columns
});

test('parseRateLinesWithHint: super_senior age tier populates rate_super_senior_pct', () => {
  const hint = {
    page: 1,
    columns: [
      { age_tier: 'general', deposit_range: 'below_3cr' },
      { age_tier: 'senior', deposit_range: 'below_3cr' },
      { age_tier: 'super_senior', deposit_range: 'below_3cr' },
    ],
  };
  const lines = ['1 year to 2 years\t6.00\t6.50\t6.75'];
  const { slabs } = parseRateLinesWithHint(lines, hint);
  assert.equal(slabs.length, 3);
  assert.equal(slabs[0].rate_general_pct, 6.0);
  assert.equal(slabs[1].rate_senior_pct, 6.5);
  assert.equal(slabs[2].rate_super_senior_pct, 6.75);
});

test('parseRateLinesWithHint: each slab carries the column deposit_range', () => {
  const lines = ['1 year to 2 years\t6.25\t6.25\t6.75\t6.75'];
  const { slabs } = parseRateLinesWithHint(lines, AXIS_PAGE_1_HINT);
  assert.equal(slabs[0].deposit_range, 'below_3cr');
  assert.equal(slabs[1].deposit_range, '3cr_to_5cr');
  assert.equal(slabs[2].deposit_range, 'below_3cr');
  assert.equal(slabs[3].deposit_range, '3cr_to_5cr');
});

// ── Sanity: normalizeTenureText behaviour unchanged ─────────────────

test('normalizeTenureText: ">=1096 Days" → "1096 days and above"', () => {
  assert.equal(normalizeTenureText('>=1096 Days'), '1096 days and above');
});

test('normalizeTenureText: "7-10 Days" → "7 days to 10 days"', () => {
  assert.equal(normalizeTenureText('7-10 Days'), '7 days to 10 days');
});
