'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const psb = require('../../lib/extractors/psb-pdf-rate-card-3col');
const pvb = require('../../lib/extractors/pvb-multi-variant');
const fb = require('../../lib/extractors/fb-multi-variant');
const ibu = require('../../lib/extractors/ibu-static-pdf-quarterly');

// --- psb-pdf-rate-card-3col ----------------------------------------------

test('psb-pdf-rate-card-3col: module shape', () => {
  assert.equal(psb.template_id, 'psb-pdf-rate-card-3col');
  assert.ok(psb.applies_to.kinds.includes('pdf-text'));
  assert.ok(psb.applies_to.bank_types.includes('PSB'));
});

test('psb-pdf-rate-card-3col: extracts from tab-separated pdfText', () => {
  const pdfText = [
    'Period\tGeneral\tSenior',
    '7 days to 14 days\t3.50\t4.00',
    '15 days to 30 days\t4.00\t4.50',
    '31 days to 90 days\t5.00\t5.50',
    '91 days to 180 days\t6.00\t6.50',
    '181 days to 1 year\t6.50\t7.00',
    '1 year to 2 years\t6.75\t7.25',
  ].join('\n');
  const r = psb.extract({ pdfText, productContext: { bank_code: 'state-bank-of-india' } });
  assert.ok(r.slabs.length >= 4, `expected ≥4 slabs, got ${r.slabs.length}; warnings=${JSON.stringify(r.warnings)}`);
  // Every slab carries source_row_text per anti-fabrication
  for (const s of r.slabs) assert.ok(s.source_row_text);
});

test('psb-pdf-rate-card-3col: empty input → 0 slabs with warning', () => {
  const r = psb.extract({});
  assert.equal(r.slabs.length, 0);
  assert.match(r.warnings[0], /no pdfText or docintelLayout/);
});

test('psb-pdf-rate-card-3col: docintel-layout extracts slabs from layout fixture (Sprint 6 Step 3e)', () => {
  const layout = {
    tables: [{
      rowCount: 4, columnCount: 3,
      cells: [
        { rowIndex: 0, columnIndex: 0, content: 'Period' },
        { rowIndex: 0, columnIndex: 1, content: 'General Rate' },
        { rowIndex: 0, columnIndex: 2, content: 'Senior Citizen' },
        { rowIndex: 1, columnIndex: 0, content: '1 year' },
        { rowIndex: 1, columnIndex: 1, content: '6.50' },
        { rowIndex: 1, columnIndex: 2, content: '7.00' },
        { rowIndex: 2, columnIndex: 0, content: '2 years' },
        { rowIndex: 2, columnIndex: 1, content: '6.75' },
        { rowIndex: 2, columnIndex: 2, content: '7.25' },
        { rowIndex: 3, columnIndex: 0, content: '3 years' },
        { rowIndex: 3, columnIndex: 1, content: '7.00' },
        { rowIndex: 3, columnIndex: 2, content: '7.50' },
      ],
    }],
  };
  const r = psb.extract({ docintelLayout: layout, productContext: { bank_code: 'state-bank-of-india' } });
  assert.equal(r.slabs.length, 3, `warnings=${JSON.stringify(r.warnings)}, diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.slabs[0].rate_general_pct, 6.5);
  assert.equal(r.slabs[0].rate_senior_pct, 7.0);
  assert.equal(r.diagnostics.extractor_kind, 'psb_pdf_docintel');
});

test('psb-pdf-rate-card-3col: docintel-layout with empty tables → 0 slabs with warning', () => {
  const r = psb.extract({ docintelLayout: { tables: [] }, productContext: { bank_code: 'x' } });
  assert.equal(r.slabs.length, 0);
  assert.match(r.warnings[0], /no tables/);
});

// --- pvb-multi-variant ----------------------------------------------------

test('pvb-multi-variant: module shape', () => {
  assert.equal(pvb.template_id, 'pvb-multi-variant');
  assert.ok(pvb.applies_to.bank_types.includes('PVB'));
});

test('pvb-multi-variant regular: delegates to generic 3-col', () => {
  const html = `<html><body><table>
    <thead><tr><th>Tenure</th><th>General</th><th>Senior</th></tr></thead>
    <tbody>
      <tr><td>1 year</td><td>6.50%</td><td>7.00%</td></tr>
      <tr><td>3 years</td><td>6.75%</td><td>7.25%</td></tr>
    </tbody>
  </table></body></html>`;
  const r = pvb.extract({ html, templateExtract: {}, productContext: { bank_code: 'hdfc', variant: 'regular' } });
  assert.equal(r.slabs.length, 2);
  assert.equal(r.diagnostics.extractor_kind, 'pvb_multi_variant_via_generic3col');
});

test('pvb-multi-variant fcnr: no html → empty result with diagnostic (Sprint 6 Step 3f wired)', () => {
  const r = pvb.extract({ productContext: { variant: 'fcnr', bank_code: 'hdfc' } });
  assert.equal(r.slabs.length, 0);
  // Path is now real (was a Sprint 7 skeleton); diagnostic includes pattern info instead of skeleton message
  assert.equal(r.diagnostics.extractor_kind, 'pvb_multi_variant_currency_matrix');
});

// --- fb-multi-variant -----------------------------------------------------

test('fb-multi-variant: module shape', () => {
  assert.equal(fb.template_id, 'fb-multi-variant');
  assert.ok(fb.applies_to.bank_types.includes('FB'));
});

test('fb-multi-variant regular: delegates to generic 3-col', () => {
  const html = `<html><body><table>
    <thead><tr><th>Tenure</th><th>Rate</th><th>Senior</th></tr></thead>
    <tbody>
      <tr><td>1 year</td><td>5.50%</td><td>5.75%</td></tr>
      <tr><td>3 years</td><td>5.75%</td><td>6.00%</td></tr>
    </tbody>
  </table></body></html>`;
  const r = fb.extract({ html, templateExtract: {}, productContext: { bank_code: 'dbs-bank-india-limited', variant: 'regular' } });
  assert.equal(r.slabs.length, 2);
  assert.equal(r.diagnostics.extractor_kind, 'fb_multi_variant_via_generic3col');
});

// --- ibu-static-pdf-quarterly ---------------------------------------------

test('ibu-static-pdf-quarterly: module shape', () => {
  assert.equal(ibu.template_id, 'ibu-static-pdf-quarterly');
  assert.ok(ibu.applies_to.kinds.includes('pdf-text'));
  assert.ok(ibu.applies_to.bank_types.includes('IBU'));
});

test('ibu-static-pdf-quarterly: tags currency from header', () => {
  const pdfText = [
    'HDFC IBU FCNR Deposit Rates — USD',
    'Tenure\tUSD Rate',
    '1 year to 2 years\t5.50',
    '2 years to 3 years\t5.40',
    '3 years to 5 years\t5.30',
  ].join('\n');
  const r = ibu.extract({ pdfText, productContext: { bank_code: 'hdfc-bank-ibu' } });
  assert.ok(r.slabs.length >= 2, `expected ≥2 slabs, got ${r.slabs.length}`);
  for (const s of r.slabs) {
    assert.equal(s.currency, 'USD');
  }
  assert.equal(r.diagnostics.dominant_currency, 'USD');
});

test('ibu-static-pdf-quarterly: multi-currency PDF flags Sprint 7 follow-up', () => {
  const pdfText = [
    'IBU Rates — USD | GBP | EUR',
    'Tenure\tUSD\tGBP\tEUR',
    '1 year to 2 years\t5.50\t5.25\t3.10',
  ].join('\n');
  const r = ibu.extract({ pdfText, productContext: { bank_code: 'hdfc-bank-ibu' } });
  assert.ok(r.warnings.some((w) => w.includes('multi-currency')));
});

test('ibu-static-pdf-quarterly: empty input → 0 slabs with warning', () => {
  const r = ibu.extract({});
  assert.equal(r.slabs.length, 0);
  assert.match(r.warnings[0], /no pdfText or docintelLayout/);
});

test('ibu-static-pdf-quarterly DocIntel multi-currency: 2 tenures × 3 currencies = 6 slabs, one "-" skipped', () => {
  const layout = {
    tables: [{
      rowCount: 3, columnCount: 4,
      cells: [
        { rowIndex: 0, columnIndex: 0, content: 'Tenure' },
        { rowIndex: 0, columnIndex: 1, content: 'USD' },
        { rowIndex: 0, columnIndex: 2, content: 'EUR' },
        { rowIndex: 0, columnIndex: 3, content: 'GBP' },
        // row 1 — full
        { rowIndex: 1, columnIndex: 0, content: '7 - 14 days' },
        { rowIndex: 1, columnIndex: 1, content: '3.50%' },
        { rowIndex: 1, columnIndex: 2, content: '1.85%' },
        { rowIndex: 1, columnIndex: 3, content: '3.35%' },
        // row 2 — EUR is a dash → skipped (so 6 total, not 7... wait: 2x3=6 minus 1 = 5)
        { rowIndex: 2, columnIndex: 0, content: '1 month < 2 months' },
        { rowIndex: 2, columnIndex: 1, content: '3.75%' },
        { rowIndex: 2, columnIndex: 2, content: '-' },
        { rowIndex: 2, columnIndex: 3, content: '3.30%' },
      ],
    }],
  };
  const r = ibu.extract({ docintelLayout: layout, productContext: { bank_code: 'hdfc-bank-ibu' } });
  // 2 tenures × 3 currency columns = 6 cells, one ("-") skipped → 5 slabs.
  assert.equal(r.slabs.length, 5, `diagnostics=${JSON.stringify(r.diagnostics)}`);
  // currency tags + rate correctness
  const r1usd = r.slabs.find((s) => s.tenure_text === '7 - 14 days' && s.currency === 'USD');
  assert.equal(r1usd.rate_general_pct, 3.5);
  assert.equal(r1usd.rate_senior_pct, null);
  const r1eur = r.slabs.find((s) => s.tenure_text === '7 - 14 days' && s.currency === 'EUR');
  assert.equal(r1eur.rate_general_pct, 1.85);
  // The skipped EUR cell on row 2 means there's no EUR slab for that tenure.
  const r2eur = r.slabs.find((s) => s.tenure_text === '1 month < 2 months' && s.currency === 'EUR');
  assert.equal(r2eur, undefined);
  // All three currencies appear overall.
  assert.deepEqual([...new Set(r.slabs.map((s) => s.currency))].sort(), ['EUR', 'GBP', 'USD']);
  assert.equal(r.diagnostics.extractor_kind, 'ibu_static_pdf_docintel_matrix');
});

test('ibu-static-pdf-quarterly DocIntel back-compat: single generic-rate column still extracts via legacy path', () => {
  const layout = {
    tables: [{
      rowCount: 4, columnCount: 2,
      cells: [
        { rowIndex: 0, columnIndex: 0, content: 'Period' },
        { rowIndex: 0, columnIndex: 1, content: 'Rate of Interest' },  // no currency token
        { rowIndex: 1, columnIndex: 0, content: '1 year to 2 years' },
        { rowIndex: 1, columnIndex: 1, content: '5.50' },
        { rowIndex: 2, columnIndex: 0, content: '2 years to 3 years' },
        { rowIndex: 2, columnIndex: 1, content: '5.40' },
        { rowIndex: 3, columnIndex: 0, content: '3 years to 5 years' },
        { rowIndex: 3, columnIndex: 1, content: '5.30' },
      ],
    }],
  };
  const r = ibu.extract({ docintelLayout: layout, productContext: { bank_code: 'some-ibu' } });
  assert.equal(r.slabs.length, 3, `diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.slabs[0].rate_general_pct, 5.5);
  // Legacy path uses the non-matrix extractor kind.
  assert.equal(r.diagnostics.extractor_kind, 'ibu_static_pdf_docintel');
});
