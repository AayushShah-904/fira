'use strict';

/**
 * Tests for `lib/actions/_cheerio_section_context.js`.
 * Orch-1 (sprint-004 2026-05-21).
 *
 * Covers both the DOM walker (`captureSectionContext`) and the pure
 * parser (`interpretSectionContext`). Heading-token parsing and note-rule
 * extraction get exhaustive cases for the patterns documented in the
 * design (`sdlc/sprints/sprint-004/design/orch1-multi-table-extraction.md`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const {
  captureSectionContext,
  interpretSectionContext,
} = require('../../../lib/actions/_cheerio_section_context');

// ────────────────────────────────────────────────────────────────────
// captureSectionContext — DOM walking
// ────────────────────────────────────────────────────────────────────

test('captureSectionContext: HDFC-shape (heading + WEF + note + table)', () => {
  const html = `
    <div>
      <h2>Domestic / NRO / NRE FIXED DEPOSIT RATE</h2>
      <p>Effective from 21st May 2026</p>
      <p>*Note: Senior Citizen rates do not apply to NRIs | The minimum tenor for NRE Deposit is 1 year</p>
      <table id="rates">
        <tr><th>Tenor</th><th>General</th></tr>
        <tr><td>1y</td><td>6.50%</td></tr>
      </table>
    </div>
  `;
  const $ = cheerio.load(html);
  const ctx = captureSectionContext($, $('#rates'));
  assert.ok(ctx.section_heading);
  assert.match(ctx.section_heading, /domestic.*nro.*nre/i);
  assert.ok(ctx.effective_date_text);
  assert.match(ctx.effective_date_text, /effective from/i);
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0], /senior.*do not apply.*minimum tenor.*1 year/i);
});

test('captureSectionContext: no heading, no notes → all null/empty', () => {
  const html = `
    <div>
      <p>Some unrelated text.</p>
      <table id="t">
        <tr><th>Tenor</th><th>Rate</th></tr>
        <tr><td>1y</td><td>6.5%</td></tr>
      </table>
    </div>
  `;
  const $ = cheerio.load(html);
  const ctx = captureSectionContext($, $('#t'));
  assert.equal(ctx.section_heading, null);
  assert.equal(ctx.effective_date_text, null);
  assert.deepEqual(ctx.notes, []);
});

test('captureSectionContext: closest heading wins when multiple precede', () => {
  const html = `
    <div>
      <h1>Some Page Title</h1>
      <p>... unrelated content ...</p>
      <h3>Domestic Fixed Deposit Rates</h3>
      <table id="t"><tr><td>x</td></tr></table>
    </div>
  `;
  const $ = cheerio.load(html);
  const ctx = captureSectionContext($, $('#t'));
  assert.match(ctx.section_heading, /domestic.*fixed deposit/i);
  // The page-title h1 is further away and should not displace the closer h3.
  assert.ok(!/some page title/i.test(ctx.section_heading));
});

test('captureSectionContext: multiple notes collected in order', () => {
  const html = `
    <div>
      <h2>NRE Fixed Deposit</h2>
      <p>Effective from 1 May 2026</p>
      <p>*Note: senior rates do not apply to NRE</p>
      <p>**Minimum tenor for NRE is 1 year</p>
      <table id="t"><tr><td>x</td></tr></table>
    </div>
  `;
  const $ = cheerio.load(html);
  const ctx = captureSectionContext($, $('#t'));
  assert.equal(ctx.notes.length, 2);
  // Document order preserved
  assert.match(ctx.notes[0], /senior.*do not apply/i);
  assert.match(ctx.notes[1], /minimum tenor/i);
});

test('captureSectionContext: walks up to parent to find heading', () => {
  // Heading is a sibling of a parent ancestor, not direct sibling of table
  const html = `
    <section>
      <h2>Domestic FD Rates</h2>
      <div>
        <div>
          <table id="t"><tr><td>x</td></tr></table>
        </div>
      </div>
    </section>
  `;
  const $ = cheerio.load(html);
  const ctx = captureSectionContext($, $('#t'));
  assert.match(ctx.section_heading, /domestic.*fd/i);
});

test('captureSectionContext: note-body-only line (no "*Note:" prefix) still captured if it contains a rule pattern', () => {
  const html = `
    <div>
      <h2>NRO Fixed Deposit</h2>
      <p>Senior Citizen rates do not apply to NRIs.</p>
      <table id="t"><tr><td>x</td></tr></table>
    </div>
  `;
  const $ = cheerio.load(html);
  const ctx = captureSectionContext($, $('#t'));
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0], /senior.*do not apply/i);
});

// ────────────────────────────────────────────────────────────────────
// interpretSectionContext.fulfills_variants — heading parsing
// ────────────────────────────────────────────────────────────────────

test('interpret: "Domestic / NRO / NRE FIXED DEPOSIT RATE" → [regular, nro, nre]', () => {
  const r = interpretSectionContext({ section_heading: 'Domestic / NRO / NRE FIXED DEPOSIT RATE' });
  assert.deepEqual(r.fulfills_variants.sort(), ['nre', 'nro', 'regular']);
});

test('interpret: "NRE / NRO FCNR" → [nre, nro, fcnr]', () => {
  const r = interpretSectionContext({ section_heading: 'NRE / NRO FCNR' });
  assert.deepEqual(r.fulfills_variants.sort(), ['fcnr', 'nre', 'nro']);
});

test('interpret: "Domestic Fixed Deposits" only → [regular]', () => {
  const r = interpretSectionContext({ section_heading: 'Domestic Fixed Deposits' });
  assert.deepEqual(r.fulfills_variants, ['regular']);
});

test('interpret: null heading → [regular] (safe default)', () => {
  const r = interpretSectionContext({ section_heading: null });
  assert.deepEqual(r.fulfills_variants, ['regular']);
});

test('interpret: unrecognised heading → [regular] (safe default)', () => {
  const r = interpretSectionContext({ section_heading: 'Cumulative & Quarterly Compounding Notes' });
  assert.deepEqual(r.fulfills_variants, ['regular']);
});

test('interpret: heading with "FCNR-B" recognised', () => {
  const r = interpretSectionContext({ section_heading: 'FCNR-B Deposits' });
  assert.deepEqual(r.fulfills_variants, ['fcnr']);
});

test('interpret: heading with "Resident" → [regular]', () => {
  const r = interpretSectionContext({ section_heading: 'Resident Term Deposits' });
  assert.deepEqual(r.fulfills_variants, ['regular']);
});

// ────────────────────────────────────────────────────────────────────
// interpretSectionContext.senior_excluded_for
// ────────────────────────────────────────────────────────────────────

test('interpret: "Senior Citizen rates do not apply to NRIs" → senior excluded for nre+nro+fcnr', () => {
  const r = interpretSectionContext({
    section_heading: 'Domestic / NRO / NRE FIXED DEPOSIT RATE',
    notes: ['*Note: Senior Citizen rates do not apply to NRIs'],
  });
  assert.deepEqual(r.senior_excluded_for.sort(), ['fcnr', 'nre', 'nro']);
});

test('interpret: "senior rates don\'t apply to NRE" → senior excluded for nre only', () => {
  const r = interpretSectionContext({
    section_heading: 'NRE Deposits',
    notes: ["senior rates don't apply to NRE"],
  });
  assert.deepEqual(r.senior_excluded_for, ['nre']);
});

test('interpret: "No senior premium on FCNR" → senior excluded for fcnr', () => {
  const r = interpretSectionContext({
    section_heading: 'FCNR Deposits',
    notes: ['No senior premium on FCNR'],
  });
  assert.deepEqual(r.senior_excluded_for, ['fcnr']);
});

test('interpret: "senior rates do not apply to NRE / NRO" → senior excluded for nre+nro', () => {
  const r = interpretSectionContext({
    section_heading: 'NRE NRO',
    notes: ['Senior rates do not apply to NRE / NRO.'],
  });
  assert.deepEqual(r.senior_excluded_for.sort(), ['nre', 'nro']);
});

// ────────────────────────────────────────────────────────────────────
// interpretSectionContext.min_tenor_days_by_variant
// ────────────────────────────────────────────────────────────────────

test('interpret: "minimum tenor for NRE Deposit is 1 year" → { nre: 365 }', () => {
  const r = interpretSectionContext({
    section_heading: 'NRE',
    notes: ['The minimum tenor for NRE Deposit is 1 year'],
  });
  assert.deepEqual(r.min_tenor_days_by_variant, { nre: 365 });
});

test('interpret: "min tenor for NRO is 7 days" → { nro: 7 }', () => {
  const r = interpretSectionContext({
    section_heading: 'NRO',
    notes: ['min tenor for NRO is 7 days'],
  });
  assert.deepEqual(r.min_tenor_days_by_variant, { nro: 7 });
});

test('interpret: "FCNR minimum tenor 1 year" → { fcnr: 365 }', () => {
  const r = interpretSectionContext({
    section_heading: 'FCNR',
    notes: ['FCNR minimum tenor 1 year'],
  });
  assert.deepEqual(r.min_tenor_days_by_variant, { fcnr: 365 });
});

test('interpret: "min tenor for NRE is 3 months" → { nre: 90 }', () => {
  const r = interpretSectionContext({
    section_heading: 'NRE',
    notes: ['min tenor for NRE is 3 months'],
  });
  assert.deepEqual(r.min_tenor_days_by_variant, { nre: 90 });
});

test('interpret: combined HDFC-shape note (both senior exclusion AND min tenor)', () => {
  const r = interpretSectionContext({
    section_heading: 'Domestic / NRO / NRE',
    notes: ['Senior Citizen rates do not apply to NRIs', 'The minimum tenor for NRE Deposit is 1 year'],
  });
  assert.deepEqual(r.senior_excluded_for.sort(), ['fcnr', 'nre', 'nro']);
  assert.deepEqual(r.min_tenor_days_by_variant, { nre: 365 });
  assert.deepEqual(r.fulfills_variants.sort(), ['nre', 'nro', 'regular']);
  assert.deepEqual(r.raw_notes, []);
});

// ────────────────────────────────────────────────────────────────────
// raw_notes preservation
// ────────────────────────────────────────────────────────────────────

test('interpret: unrecognised note preserved in raw_notes', () => {
  const r = interpretSectionContext({
    section_heading: 'Domestic',
    notes: ['Premature withdrawal: 1% penalty applies above ₹5 lakh'],
  });
  assert.equal(r.raw_notes.length, 1);
  assert.match(r.raw_notes[0], /premature withdrawal/i);
});

test('interpret: empty notes array → empty raw_notes', () => {
  const r = interpretSectionContext({ section_heading: 'Domestic', notes: [] });
  assert.deepEqual(r.raw_notes, []);
});

test('interpret: empty input → safe defaults', () => {
  const r = interpretSectionContext({});
  assert.deepEqual(r.fulfills_variants, ['regular']);
  assert.deepEqual(r.senior_excluded_for, []);
  assert.deepEqual(r.min_tenor_days_by_variant, {});
  assert.deepEqual(r.raw_notes, []);
});

test('interpret: null input → safe defaults', () => {
  const r = interpretSectionContext(null);
  assert.deepEqual(r.fulfills_variants, ['regular']);
});

// ────────────────────────────────────────────────────────────────────
// Orch-2 (2026-05-21): rules embedded inside section_heading itself
//
// Some banks (HDFC observed) pack the heading, effective-date stamp,
// AND the notes into a single heading-tagged element. captureSectionContext
// puts that blob into section_heading. The rule applier must still see
// the rule-bearing substrings or senior-exclusion + min-tenor never fire.
// ────────────────────────────────────────────────────────────────────

test('Orch-2 interpret: rules embedded in section_heading (HDFC-shape concatenated h2)', () => {
  const r = interpretSectionContext({
    section_heading:
      'Fixed Deposit interest rate less than ₹3 crore Domestic / NRO / NRE FIXED DEPOSIT RATE Applicable from 6th March, 2026 *Note: Senior Citizen rates do not apply to NRIs | The minimum tenor for NRE Deposit is 1 year',
    notes: [],
  });
  assert.deepEqual(r.fulfills_variants.sort(), ['nre', 'nro', 'regular']);
  assert.deepEqual(r.senior_excluded_for.sort(), ['fcnr', 'nre', 'nro']);
  assert.deepEqual(r.min_tenor_days_by_variant, { nre: 365 });
});

test('Orch-2 interpret: heading-embedded rules without `*Note:` prefix still match', () => {
  const r = interpretSectionContext({
    section_heading:
      '≥ ₹3 Cr to < ₹5 Cr Domestic / NRO / NRE FIXED DEPOSIT RATE Applicable from 7th March, 2026. (Senior Citizen Rates do not apply to NRIs | Minimum tenor for NRE Deposit is 1 Year.)',
    notes: [],
  });
  assert.deepEqual(r.senior_excluded_for.sort(), ['fcnr', 'nre', 'nro']);
  assert.deepEqual(r.min_tenor_days_by_variant, { nre: 365 });
});

test('Orch-2 interpret: heading without rule patterns leaves senior/min_tenor empty', () => {
  const r = interpretSectionContext({
    section_heading: 'Domestic / NRO / NRE FIXED DEPOSIT RATE',
    notes: [],
  });
  assert.deepEqual(r.senior_excluded_for, []);
  assert.deepEqual(r.min_tenor_days_by_variant, {});
});

test('Orch-2 interpret: heading rules + notes rules union (both contribute)', () => {
  const r = interpretSectionContext({
    section_heading: 'Domestic / NRO / NRE Senior Citizen rates do not apply to NRIs',
    notes: ['min tenor for NRE is 1 year'],
  });
  assert.deepEqual(r.senior_excluded_for.sort(), ['fcnr', 'nre', 'nro']);
  assert.deepEqual(r.min_tenor_days_by_variant, { nre: 365 });
});
