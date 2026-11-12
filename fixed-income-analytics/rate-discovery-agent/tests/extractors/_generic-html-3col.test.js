'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const generic = require('../../lib/extractors/_generic-html-3col');

function buildHtml(slabs, headers = ['Tenure', 'Rate', 'Senior Citizen']) {
  const headerHtml = headers.map((h) => `<th>${h}</th>`).join('');
  const rows = slabs.map((s) =>
    `<tr><td>${s.tenure}</td><td>${s.general}%</td><td>${s.senior ?? ''}${s.senior != null ? '%' : ''}</td></tr>`
  ).join('\n');
  return `<html><body><table><thead><tr>${headerHtml}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

test('_generic-html-3col module shape', () => {
  assert.equal(generic.template_id, '_generic-html-3col');
  assert.deepEqual(generic.applies_to.kinds.sort(), ['html_js', 'html_static']);
  assert.equal(typeof generic.extract, 'function');
});

test('extracts a 3-column table with inferred column_map', () => {
  const html = buildHtml([
    { tenure: '7 days to 14 days', general: 3.5, senior: 4.0 },
    { tenure: '1 year', general: 6.5, senior: 7.0 },
    { tenure: '3 years to 5 years', general: 6.75, senior: 7.25 },
  ]);
  const r = generic.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 3, `warnings=${JSON.stringify(r.warnings)}, diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.slabs[0].rate_general_pct, 3.5);
  assert.equal(r.slabs[0].rate_senior_pct, 4.0);
  assert.equal(r.diagnostics.extractor_kind, 'generic');
});

test('returns empty result on page with no rate-bearing table', () => {
  const html = '<html><body><p>Visit branch for rates</p></body></html>';
  const r = generic.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 0);
  assert.match(r.warnings[0], /no <table>/);
});

test('honors explicit column_map override', () => {
  const html = `<html><body><table>
    <thead><tr><th>X</th><th>Y</th><th>Z</th></tr></thead>
    <tbody>
      <tr><td>1 year</td><td>6.5%</td><td>7.0%</td></tr>
      <tr><td>3 years</td><td>6.75%</td><td>7.25%</td></tr>
    </tbody>
  </table></body></html>`;
  const r = generic.extract({
    html,
    templateExtract: { column_map: { 0: 'tenure_text', 1: 'rate_general_pct', 2: 'rate_senior_pct' } },
  });
  assert.equal(r.slabs.length, 2);
});

test('anti-fabrication: every emitted slab has source_row_text containing tenure', () => {
  const html = buildHtml([{ tenure: '1 year', general: 6.5, senior: 7.0 }]);
  const r = generic.extract({ html, templateExtract: {} });
  for (const s of r.slabs) {
    assert.ok(s.source_row_text.includes(s.tenure_text), 'source_row_text must include tenure_text');
  }
});

test('drops rows with unparseable tenures and surfaces reason in diagnostics', () => {
  const html = buildHtml([
    { tenure: '1 year', general: 6.5, senior: 7.0 },
    { tenure: 'garbage tenure', general: 9.5, senior: 10.0 },
    { tenure: '3 years', general: 6.75, senior: 7.25 },
  ]);
  const r = generic.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 2);
  assert.ok((r.diagnostics.rows_dropped_reasons.unparseable_tenure || 0) >= 1);
});

// --- Foreign-currency (GIFT/FCNR) per-currency extraction -----------------

test('GIFT currency table: tenure rows × currency columns yields one slab per currency, keeps low FX rates', () => {
  // Header [Tenure, USD, EUR, GBP], two tenure rows. EUR cell of row 1 is a
  // very low FX rate (0.05%) that the domestic floor (0.1) would drop — it
  // must be KEPT because the column carries a currency.
  const html = `<html><body><table>
    <thead><tr><th>Tenure</th><th>USD</th><th>EUR</th><th>GBP</th></tr></thead>
    <tbody>
      <tr><td>1 year</td><td>5.25%</td><td>0.05%</td><td>4.10%</td></tr>
      <tr><td>2 years</td><td>5.40%</td><td>3.20%</td><td>4.25%</td></tr>
    </tbody>
  </table></body></html>`;
  const r = generic.extract({
    html,
    templateExtract: {
      column_map: {
        0: 'tenure_text',
        1: 'rate_general_pct#USD',
        2: 'rate_general_pct#EUR',
        3: 'rate_general_pct#GBP',
      },
    },
  });
  assert.equal(r.slabs.length, 6, `expected 2 tenures × 3 currencies; warnings=${JSON.stringify(r.warnings)}`);

  const find = (tenure, cur) => r.slabs.find((s) => s.tenure_text === tenure && s.currency === cur);
  assert.equal(find('1 year', 'USD').rate_general_pct, 5.25);
  assert.equal(find('1 year', 'EUR').rate_general_pct, 0.05, 'low FX rate must be kept');
  assert.equal(find('1 year', 'GBP').rate_general_pct, 4.10);
  assert.equal(find('2 years', 'USD').rate_general_pct, 5.40);
  assert.equal(find('2 years', 'EUR').rate_general_pct, 3.20);
  assert.equal(find('2 years', 'GBP').rate_general_pct, 4.25);

  // Every slab must carry exactly its mapped currency.
  for (const s of r.slabs) assert.ok(['USD', 'EUR', 'GBP'].includes(s.currency), 'slab must carry currency');
});

test('amount×currency coalescing never merges across currencies', () => {
  // Two adjacent amount buckets × two currencies. For a given tenure, USD has
  // the SAME rate (5.00%) across both buckets, and so does EUR (5.00%).
  // Adjacent-bucket coalescing (the buckets below_3cr / 3cr_to_5cr are
  // contiguous and parseable) should merge each currency's two buckets into
  // ONE spanning slab — but NEVER merge USD with EUR even though their rates
  // are identical. Expect exactly 2 slabs (one per currency), not 1, not 4.
  const html = `<html><body><table>
    <thead><tr><th>Tenure</th><th>USD-A</th><th>EUR-A</th><th>USD-B</th><th>EUR-B</th></tr></thead>
    <tbody>
      <tr><td>1 year</td><td>5.00%</td><td>5.00%</td><td>5.00%</td><td>5.00%</td></tr>
    </tbody>
  </table></body></html>`;
  const r = generic.extract({
    html,
    templateExtract: {
      column_map: {
        0: 'tenure_text',
        1: 'rate_general_pct@below_3cr#USD',
        2: 'rate_general_pct@below_3cr#EUR',
        3: 'rate_general_pct@3cr_to_5cr#USD',
        4: 'rate_general_pct@3cr_to_5cr#EUR',
      },
    },
  });
  assert.equal(r.slabs.length, 2, `expected exactly 2 slabs (USD, EUR coalesced within currency); got ${JSON.stringify(r.slabs)}`);
  const currencies = r.slabs.map((s) => s.currency).sort();
  assert.deepEqual(currencies, ['EUR', 'USD']);
  // Each currency's two adjacent buckets coalesced into one spanning range.
  for (const s of r.slabs) {
    assert.equal(s.rate_general_pct, 5.00);
    assert.equal(s.deposit_range, 'below_5cr', `deposit_range should be the merged span, got ${s.deposit_range}`);
  }
});

test('regression: plain domestic 3-col table produces slabs with NO currency key', () => {
  const html = buildHtml([
    { tenure: '1 year', general: 6.5, senior: 7.0 },
    { tenure: '3 years', general: 6.75, senior: 7.25 },
  ]);
  const r = generic.extract({ html, templateExtract: {} });
  assert.equal(r.slabs.length, 2);
  for (const s of r.slabs) {
    assert.ok(!('currency' in s), 'domestic slab must NOT have a currency key');
  }
});
