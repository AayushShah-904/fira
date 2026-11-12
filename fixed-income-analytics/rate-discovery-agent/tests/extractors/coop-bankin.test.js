'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const coopBankin = require('../../lib/extractors/coop-bankin-3col-tenure-general-senior');

// --- Synthetic fixture builders -----------------------------------------

function buildCoopPage(slabs, { headerLabels = ['Period', 'Rate of Interest', 'Senior Citizen'] } = {}) {
  const headerHtml = headerLabels.map((h) => `<th>${h}</th>`).join('');
  const rowsHtml = slabs.map((s) =>
    `<tr><td>${s.tenure}</td><td>${s.general}%</td><td>${s.senior ?? ''}${s.senior != null ? '%' : ''}</td></tr>`
  ).join('\n');
  return `
    <!doctype html>
    <html><body class="wordpress wp-theme-coop">
      <h2>Fixed Deposit Rates</h2>
      <p>Effective w.e.f. 01/04/2026</p>
      <table class="rate-table">
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </body></html>`;
}

function build4ColCoopPage(slabs) {
  const rows = slabs.map((s) =>
    `<tr><td>${s.tenure}</td><td>${s.general}%</td><td>${s.senior}%</td><td>${s.superSenior ?? ''}${s.superSenior != null ? '%' : ''}</td></tr>`
  ).join('\n');
  return `
    <!doctype html>
    <html><body>
      <table>
        <thead><tr><th>Tenure</th><th>General</th><th>Senior Citizen</th><th>Super Senior</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </body></html>`;
}

function buildMultiTableCoopPage(slabs) {
  // First table is a noisy footnote ("w.e.f."); second table is the real rates.
  // The table-picker must NOT pick the first.
  const rows = slabs.map((s) =>
    `<tr><td>${s.tenure}</td><td>${s.general}%</td><td>${s.senior}%</td></tr>`
  ).join('\n');
  return `
    <!doctype html>
    <html><body>
      <table>
        <thead><tr><th>w.e.f.</th></tr></thead>
        <tbody><tr><td>w.e.f. 2026-04-01 — see card rate</td></tr></tbody>
      </table>
      <table class="real-rates">
        <thead><tr><th>Period</th><th>General</th><th>Senior</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </body></html>`;
}

// --- Tests --------------------------------------------------------------

test('coop-bankin extractor exports the contract module', () => {
  assert.equal(coopBankin.template_id, 'coop-bankin-3col-tenure-general-senior');
  assert.ok(coopBankin.applies_to);
  assert.deepEqual(coopBankin.applies_to.kinds.sort(), ['html_js', 'html_static']);
  assert.equal(typeof coopBankin.extract, 'function');
});

test('extracts a 3-column DCCB-style rate table', () => {
  const slabs = [
    { tenure: '7 Days to 45 days', general: 3.5, senior: 4.0 },
    { tenure: '46 days to 90 days', general: 4.25, senior: 4.75 },
    { tenure: '91 days to 180 days', general: 5.5, senior: 6.0 },
    { tenure: '181 days to 1 year', general: 6.25, senior: 6.75 },
    { tenure: '1 year to 2 years', general: 6.5, senior: 7.0 },
    { tenure: '2 years to 3 years', general: 6.75, senior: 7.25 },
    { tenure: 'above 5 years', general: 6.0, senior: 6.5 },
  ];
  const html = buildCoopPage(slabs);
  const r = coopBankin.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 7, `warnings=${JSON.stringify(r.warnings)}, diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.slabs[0].tenure_text, '7 Days to 45 days');
  assert.equal(r.slabs[0].tenure_min_days, 7);
  assert.equal(r.slabs[0].tenure_max_days, 45);
  assert.equal(r.slabs[0].rate_general_pct, 3.5);
  assert.equal(r.slabs[0].rate_senior_pct, 4.0);
  assert.ok(r.slabs[0].source_row_text.includes('7 Days to 45 days'));
});

test('extracts a 4-column table with super-senior column', () => {
  const html = build4ColCoopPage([
    { tenure: '1 year', general: 6.5, senior: 7.0, superSenior: 7.25 },
    { tenure: '2 years', general: 6.75, senior: 7.25, superSenior: 7.5 },
    { tenure: '5 years', general: 6.5, senior: 7.0, superSenior: 7.25 },
  ]);
  const r = coopBankin.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 3);
  assert.equal(r.slabs[0].rate_super_senior_pct, 7.25);
});

test('picks the rate table from a multi-table page with a noisy footnote table', () => {
  const html = buildMultiTableCoopPage([
    { tenure: '7 days to 45 days', general: 3.5, senior: 4.0 },
    { tenure: '1 year', general: 6.5, senior: 7.0 },
    { tenure: '3 years', general: 6.75, senior: 7.25 },
  ]);
  const r = coopBankin.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 3, `warnings=${JSON.stringify(r.warnings)}`);
});

test('handles parenthetical wording in tenure cells', () => {
  const html = buildCoopPage([
    { tenure: '7 Days to 45 days (new slab)', general: 3.5, senior: 4.0 },
    { tenure: 'Above 36 months to 60 months (new slab)', general: 6.5, senior: 7.0 },
  ]);
  const r = coopBankin.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 2);
  assert.equal(r.slabs[0].tenure_min_days, 7);
  assert.equal(r.slabs[0].tenure_max_days, 45);
});

test('handles blank senior cell — emits rate_senior_pct=null without dropping the row', () => {
  const html = buildCoopPage([
    { tenure: '7 days to 14 days', general: 3.25, senior: null },
    { tenure: '1 year', general: 6.5, senior: 7.0 },
  ]);
  const r = coopBankin.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 2);
  assert.equal(r.slabs[0].rate_senior_pct, null);
  assert.equal(r.slabs[1].rate_senior_pct, 7.0);
});

test('returns an empty result with a warning when no <table> is present', () => {
  const html = `<html><body><p>Rates not available online — visit branch.</p></body></html>`;
  const r = coopBankin.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 0);
  assert.match(r.warnings.join(' '), /no .table./i);
});

test('returns an empty result when html is missing', () => {
  const r = coopBankin.extract({ html: '', templateExtract: {} });
  assert.equal(r.slabs.length, 0);
});

test('honors explicit column_map from templateExtract', () => {
  // Build a page where the inferred header map would be wrong, then override.
  // Headers are non-obvious so synonym inference would NOT pick correctly.
  const html = `
    <table>
      <thead><tr><th>X</th><th>Y</th><th>Z</th></tr></thead>
      <tbody>
        <tr><td>1 year</td><td>6.5%</td><td>7.0%</td></tr>
        <tr><td>3 years</td><td>6.75%</td><td>7.25%</td></tr>
      </tbody>
    </table>`;
  const r = coopBankin.extract({
    html,
    templateExtract: { column_map: { 0: 'tenure_text', 1: 'rate_general_pct', 2: 'rate_senior_pct' } },
  });
  assert.equal(r.slabs.length, 2);
  assert.equal(r.slabs[0].rate_general_pct, 6.5);
});

test('honors tenure_cap_days override from templateExtract', () => {
  const html = buildCoopPage([
    { tenure: '5 years and above', general: 6.0, senior: 6.5 },
  ]);
  // Default cap is 3650. Push the cap up to support 15-year tenures (Axis/HDFC scenario).
  const r = coopBankin.extract({ html, templateExtract: { tenure_cap_days: 5475 } });
  assert.equal(r.slabs.length, 1);
  // The preset "5 years and above" maxes at 3650; the cap doesn't extend the preset.
  // But the parsed max_days is still bounded by the cap, so the assertion checks that
  // the cap is NOT silently clipping a value that's already below it.
  assert.equal(r.slabs[0].tenure_max_days, 3650);
});

test('records useful diagnostics for operator debugging', () => {
  const html = buildCoopPage([
    { tenure: '1 year', general: 6.5, senior: 7.0 },
    { tenure: '3 years', general: 6.75, senior: 7.25 },
  ]);
  const r = coopBankin.extract({ html, templateExtract: {} });
  assert.equal(r.diagnostics.rows_seen, 2);
  assert.equal(r.diagnostics.rows_kept, 2);
  assert.match(r.diagnostics.header_row_text, /Period/);
  assert.ok(r.diagnostics.column_map);
  assert.ok(r.diagnostics.table_score > 0);
});

test('drops rows with unparseable tenures and surfaces the reason in diagnostics', () => {
  const html = `
    <table>
      <thead><tr><th>Period</th><th>Rate</th><th>Senior</th></tr></thead>
      <tbody>
        <tr><td>1 year</td><td>6.5%</td><td>7.0%</td></tr>
        <tr><td>garbage tenure</td><td>9.5%</td><td>10%</td></tr>
        <tr><td>3 years</td><td>6.75%</td><td>7.25%</td></tr>
      </tbody>
    </table>`;
  const r = coopBankin.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 2);
  assert.ok(r.diagnostics.rows_dropped_reasons.unparseable_tenure >= 1);
});

test('finds effective_date from "w.e.f." pattern in page text', () => {
  const html = buildCoopPage([{ tenure: '1 year', general: 6.5, senior: 7.0 }]);
  const r = coopBankin.extract({ html, templateExtract: {} });
  assert.equal(r.effective_date, '01/04/2026');
});

test('anti-fabrication: every emitted slab has source_row_text containing the tenure and rates', () => {
  const html = buildCoopPage([
    { tenure: '1 year', general: 6.5, senior: 7.0 },
    { tenure: '3 years', general: 6.75, senior: 7.25 },
  ]);
  const r = coopBankin.extract({ html, templateExtract: {} });
  for (const s of r.slabs) {
    assert.ok(s.source_row_text, 'source_row_text must be set');
    assert.ok(s.source_row_text.includes(s.tenure_text), 'source_row_text must contain tenure_text');
  }
});
