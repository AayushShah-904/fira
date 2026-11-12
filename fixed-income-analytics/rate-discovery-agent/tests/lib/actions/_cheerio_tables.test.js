'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractScoredTables, extractTableChunks, extractTableTierLabel, pickBestTable, _scoreTable } = require('../../../lib/actions/_cheerio_tables');
const cheerio = require('cheerio');

const RATE_TABLE_HTML = `
<html><body>
<h2>Domestic FD Rates</h2>
<table id="rates">
  <thead><tr><th>Tenure</th><th>General</th><th>Senior Citizen</th></tr></thead>
  <tbody>
    <tr><td>7 days to 45 days</td><td>3.50%</td><td>4.00%</td></tr>
    <tr><td>46 days to 90 days</td><td>4.75%</td><td>5.25%</td></tr>
    <tr><td>91 days to 180 days</td><td>5.50%</td><td>6.00%</td></tr>
    <tr><td>1 year to 2 years</td><td>6.50%</td><td>7.00%</td></tr>
    <tr><td>3 years to 5 years</td><td>6.25%</td><td>6.75%</td></tr>
  </tbody>
</table>
</body></html>`;

const RATE_TABLE_WITH_FOOTNOTE_HTML = `
<html><body>
<table id="rates">
  <tr><th>Tenure</th><th>General</th><th>Senior</th></tr>
  <tr><td>7-45 days</td><td>3.50%</td><td>4.00%</td></tr>
  <tr><td>1 year</td><td>6.50%</td><td>7.00%</td></tr>
</table>
<table id="compare">
  <tr><th>Tenure</th><th>Card Rate</th><th>Existing Rate</th><th>Revised Rate</th></tr>
  <tr><td>1 year</td><td>6.50%</td><td>6.55%</td><td>6.60%</td></tr>
</table>
<table id="callout">
  <tr><td>444 Days Premium</td><td>7.25%</td></tr>
</table>
</body></html>`;

test('extractScoredTables: single rate table scores positive', () => {
  const tables = extractScoredTables(RATE_TABLE_HTML);
  assert.equal(tables.length, 1);
  assert.ok(tables[0].score > 30, `expected score > 30 (got ${tables[0].score})`);
  assert.equal(tables[0].rows.length, 6, '5 data rows + 1 header');
  assert.equal(tables[0].signals.pctRows, 5);
  assert.equal(tables[0].signals.tenureRows, 5);
});

test('extractScoredTables: multi-table page picks rate table over comparison/callout', () => {
  const tables = extractScoredTables(RATE_TABLE_WITH_FOOTNOTE_HTML);
  assert.equal(tables.length, 3);
  // Top-scored should be the real rate table (id=rates), not the comparison
  // (id=compare; penalised for "Card/Existing/Revised" terms) or the callout
  // (id=callout; penalised for single data row).
  assert.equal(tables[0].index, 0, 'rate table is index 0 in source');
  assert.ok(tables[0].score > tables[1].score);
  assert.ok(tables[0].score > tables[2].score);
});

test('scoreTable: penalises "Card Rate" / "Existing" / "Revised" footnote tables', () => {
  const noisyRows = [
    ['Tenure', 'Card Rate', 'Existing', 'Revised'],
    ['1 year', '6.50%', '6.55%', '6.60%'],
    ['2 years', '7.00%', '7.05%', '7.10%'],
  ];
  const cleanRows = [
    ['Tenure', 'General', 'Senior'],
    ['1 year', '6.50%', '7.00%'],
    ['2 years', '7.00%', '7.50%'],
  ];
  const noisy = _scoreTable(noisyRows);
  const clean = _scoreTable(cleanRows);
  assert.equal(noisy.signals.noisy, true);
  assert.equal(clean.signals.noisy, false);
  assert.ok(clean.score > noisy.score, `clean (${clean.score}) should outscore noisy (${noisy.score})`);
});

test('scoreTable: single-data-row tables outranked by real tables', () => {
  const callout = _scoreTable([
    ['444 Days Premium', '7.25%'],
  ]);
  const rateTable = _scoreTable([
    ['Tenure', 'Rate'],
    ['7 days to 45 days', '3.50%'],
    ['46 days to 90 days', '4.75%'],
    ['1 year', '6.50%'],
  ]);
  // The absolute score may stay positive, but a real rate table must outrank it.
  assert.ok(rateTable.score > callout.score, `real rate table (${rateTable.score}) should outscore callout (${callout.score})`);
  assert.equal(callout.signals.dataRows, 1, 'callout has single data row');
});

test('extractScoredTables: handles nested tbody/thead correctly', () => {
  const html = `
    <table>
      <thead><tr><th>Tenure</th><th>Rate</th></tr></thead>
      <tbody>
        <tr><td>7 days</td><td>3.50%</td></tr>
        <tr><td>30 days</td><td>4.00%</td></tr>
      </tbody>
    </table>`;
  const t = extractScoredTables(html);
  assert.equal(t.length, 1);
  assert.equal(t[0].rows.length, 3, 'thead row + 2 tbody rows');
});

test('extractScoredTables: handles HTML entities in cells', () => {
  const html = `
    <table>
      <tr><th>Tenure</th><th>Rate</th></tr>
      <tr><td>7&nbsp;days</td><td>3.50&#37;</td></tr>
      <tr><td>1&nbsp;year</td><td>6.50&#37;</td></tr>
    </table>`;
  const t = extractScoredTables(html);
  assert.equal(t.length, 1);
  // Cheerio's text() decodes entities, so the cell becomes "7 days"
  assert.equal(t[0].rows[1][0], '7 days');
});

test('pickBestTable: returns null when no positive-score tables', () => {
  const html = '<table><tr><td>Nothing rate-shaped here</td></tr></table>';
  const out = pickBestTable(html);
  assert.equal(out, null);
});

test('pickBestTable: returns highest-scoring table', () => {
  const out = pickBestTable(RATE_TABLE_WITH_FOOTNOTE_HTML);
  assert.ok(out);
  assert.equal(out.index, 0);
});

test('extractScoredTables: empty or invalid input returns []', () => {
  assert.deepEqual(extractScoredTables(''), []);
  assert.deepEqual(extractScoredTables(null), []);
  assert.deepEqual(extractScoredTables(undefined), []);
});

test('extractScoredTables: skips empty tables (no rows)', () => {
  const html = '<table></table><table><tr><td>1 year</td><td>6.5%</td></tr></table>';
  const t = extractScoredTables(html);
  assert.equal(t.length, 1);
});

// ── Div-based "tables" — common in React/Vue/Liferay UIs ──

test('extractScoredTables: detects repeated div-row sibling structure', () => {
  // React-style rate grid with no <table> element
  const html = `
    <div class="rate-grid">
      <div class="header">
        <span>Tenure</span><span>General</span><span>Senior</span>
      </div>
      <div class="rate-row">
        <span>7 days to 45 days</span><span>3.50%</span><span>4.00%</span>
      </div>
      <div class="rate-row">
        <span>46 days to 90 days</span><span>4.75%</span><span>5.25%</span>
      </div>
      <div class="rate-row">
        <span>1 year</span><span>6.50%</span><span>7.00%</span>
      </div>
      <div class="rate-row">
        <span>2 years to 3 years</span><span>7.00%</span><span>7.50%</span>
      </div>
    </div>`;
  const t = extractScoredTables(html);
  assert.ok(t.length >= 1, 'should detect at least one div-based table');
  const divTable = t.find((x) => x.source === 'div-table');
  assert.ok(divTable, 'div-table source should be present');
  assert.ok(divTable.rows.length >= 4, `expected >=4 rows from div siblings (got ${divTable.rows.length})`);
  // Cells should be split: each row has [tenure, general, senior]
  assert.equal(divTable.rows[0].length, 3, 'each row split into 3 cells');
});

test('extractScoredTables: detects role="table" semantic markup', () => {
  const html = `
    <div role="table">
      <div role="row">
        <div role="columnheader">Tenure</div>
        <div role="columnheader">Rate</div>
      </div>
      <div role="row">
        <div role="cell">7 days</div>
        <div role="cell">3.50%</div>
      </div>
      <div role="row">
        <div role="cell">1 year</div>
        <div role="cell">6.50%</div>
      </div>
      <div role="row">
        <div role="cell">2 years</div>
        <div role="cell">7.00%</div>
      </div>
    </div>`;
  const t = extractScoredTables(html);
  const roleTable = t.find((x) => x.source === 'role-table');
  assert.ok(roleTable, 'role-table source should be present');
  assert.equal(roleTable.rows.length, 4, 'header + 3 cells');
});

test('extractScoredTables: prefers <table> over div-table at equal data', () => {
  // Same data presented twice — once as <table>, once as div-grid. The
  // 2-point penalty on div-tables means the <table> wins ties.
  const html = `
    <table>
      <tr><th>Tenure</th><th>Rate</th></tr>
      <tr><td>7 days</td><td>3.50%</td></tr>
      <tr><td>1 year</td><td>6.50%</td></tr>
      <tr><td>3 years</td><td>7.00%</td></tr>
    </table>
    <div class="rate-grid">
      <div><span>7 days</span><span>3.50%</span></div>
      <div><span>1 year</span><span>6.50%</span></div>
      <div><span>3 years</span><span>7.00%</span></div>
    </div>`;
  const t = extractScoredTables(html);
  assert.ok(t.length >= 2);
  assert.equal(t[0].source, 'table', 'top-ranked should be the standard table');
});

test('extractScoredTables: ignores div-grids without 3+ rate-shaped rows', () => {
  // Only 2 rows have both tenure + pct — below threshold
  const html = `
    <div>
      <div><span>Header</span><span>Rate</span></div>
      <div><span>7 days</span><span>3.50%</span></div>
      <div><span>1 year</span><span>6.50%</span></div>
      <div><span>About us</span><span>Read more</span></div>
    </div>`;
  const t = extractScoredTables(html);
  const divTable = t.find((x) => x.source === 'div-table');
  assert.equal(divTable, undefined, 'should not match div-table with only 2 rate-shaped rows');
});

test('extractScoredTables: does NOT double-count nested div-grids', () => {
  // Outer div contains inner div-grid. Should only emit one candidate (inner).
  const html = `
    <div class="outer">
      <h2>Our FD Rates</h2>
      <div class="rate-grid">
        <div><span>7 days</span><span>3.50%</span></div>
        <div><span>1 year</span><span>6.50%</span></div>
        <div><span>3 years</span><span>7.00%</span></div>
        <div><span>5 years</span><span>7.25%</span></div>
      </div>
    </div>`;
  const t = extractScoredTables(html);
  const divTables = t.filter((x) => x.source === 'div-table');
  assert.equal(divTables.length, 1, 'one candidate, not two — inner deduped via seen-set');
});

// ── extractTableChunks (prompt-improvement-2026-05-18) ─────────────────

test('extractTableChunks: single rate table → one chunk with tableHtml + context', () => {
  const chunks = extractTableChunks(RATE_TABLE_HTML);
  assert.equal(chunks.length, 1);
  const [c] = chunks;
  assert.ok(c.tableHtml.includes('<table'), 'tableHtml preserves opening <table');
  assert.ok(c.tableHtml.includes('3.50%'), 'tableHtml preserves cell values');
  assert.ok(c.score > 0);
  assert.ok(c.contextHtml.includes('Domestic FD Rates'), 'context captures preceding heading');
});

test('extractTableChunks: multi-table page emits one chunk per table, score-sorted', () => {
  const chunks = extractTableChunks(RATE_TABLE_WITH_FOOTNOTE_HTML);
  assert.ok(chunks.length >= 2);
  // Highest-scoring chunk first
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i - 1].score >= chunks[i].score);
  }
});

test('extractTableChunks: WEF banner appears in context', () => {
  const html = `
    <html><body>
      <p>Interest rates w.e.f. 01.05.2026</p>
      <h2>NRE Term Deposits</h2>
      <table>
        <tr><th>Tenure</th><th>Rate</th></tr>
        <tr><td>1 year</td><td>6.50%</td></tr>
        <tr><td>2 years</td><td>6.75%</td></tr>
      </table>
    </body></html>`;
  const chunks = extractTableChunks(html);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].contextHtml, /w\.e\.f\./i, 'context captures WEF banner');
  assert.match(chunks[0].contextHtml, /NRE Term Deposits/, 'context captures heading');
});

test('extractTableChunks: maxChunkChars truncates oversized table HTML', () => {
  const giantRows = Array.from({ length: 200 }, (_, i) =>
    `<tr><td>tenure ${i}</td><td>${(3 + i / 100).toFixed(2)}%</td></tr>`
  ).join('');
  const html = `<html><body><h2>Long</h2><table>${giantRows}</table></body></html>`;
  const chunks = extractTableChunks(html, { maxChunkChars: 1024 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].tableHtml.length <= 1024 + 32, 'tableHtml respects maxChunkChars (+ truncation marker)');
  assert.match(chunks[0].tableHtml, /CHUNK_TRUNCATED/);
});

test('extractTableChunks: empty / invalid input returns []', () => {
  assert.deepEqual(extractTableChunks(''), []);
  assert.deepEqual(extractTableChunks(null), []);
  assert.deepEqual(extractTableChunks(undefined), []);
});

test('extractTableChunks: skips empty <table> elements', () => {
  const html = '<html><body><table></table><table><tr><td>1 year</td><td>6%</td></tr></table></body></html>';
  const chunks = extractTableChunks(html);
  assert.equal(chunks.length, 1, 'empty table dropped, one real chunk emitted');
});

// ── A4 — extractTableTierLabel + tier_hint plumbing ────────────────────

test('extractTableTierLabel: returns nearest <h3> text in lowercase', () => {
  const html = `
    <div>
      <h2>Domestic FD</h2>
      <p>Some prose between heading and section.</p>
      <h3>Deposits Below ₹3 Cr</h3>
      <table id="t">
        <tr><th>Tenure</th><th>Rate</th></tr>
        <tr><td>1 year</td><td>6.50%</td></tr>
      </table>
    </div>`;
  const $ = cheerio.load(html);
  const label = extractTableTierLabel($, $('#t'));
  assert.equal(label, 'deposits below ₹3 cr');
});

test('extractTableTierLabel: returns null when no heading-shape sibling within budget', () => {
  const html = `<div><p>Just prose, no heading</p><table id="t"><tr><th>X</th></tr></table></div>`;
  const $ = cheerio.load(html);
  assert.equal(extractTableTierLabel($, $('#t')), null);
});

test('extractTableTierLabel: handles bold/strong as heading-shape', () => {
  const html = `<div><strong>Bulk Deposits Above ₹3 Cr</strong><table id="t"><tr><td>1 yr</td><td>7%</td></tr></table></div>`;
  const $ = cheerio.load(html);
  const label = extractTableTierLabel($, $('#t'));
  assert.equal(label, 'bulk deposits above ₹3 cr');
});

test('extractTableChunks: tier_hint is null when RDA_TIER_AWARE_DEDUP unset (default)', () => {
  const html = `<div><h3>Below 3 Cr</h3><table><tr><td>1 yr</td><td>6.5%</td><td>2 yr</td><td>6.75%</td><td>3 yr</td><td>7.0%</td></tr></table></div>`;
  delete process.env.RDA_TIER_AWARE_DEDUP;
  const chunks = extractTableChunks(html);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].tier_hint, null);
});

test('extractTableChunks: tier_hint populated when RDA_TIER_AWARE_DEDUP=1', () => {
  const html = `<div><h3>Below 3 Cr</h3><table><tr><td>1 year</td><td>6.5%</td></tr><tr><td>2 years</td><td>6.75%</td></tr></table></div>`;
  process.env.RDA_TIER_AWARE_DEDUP = '1';
  try {
    const chunks = extractTableChunks(html);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].tier_hint, 'below 3 cr');
  } finally {
    delete process.env.RDA_TIER_AWARE_DEDUP;
  }
});

test('extractTableChunks: stacked-tier page produces distinct tier_hints per chunk', () => {
  const html = `
    <div>
      <h3>Below 3 Cr</h3>
      <table>
        <tr><th>Tenure</th><th>Rate</th></tr>
        <tr><td>1 year</td><td>6.50%</td></tr>
        <tr><td>2 years</td><td>6.75%</td></tr>
      </table>
      <h3>Above 3 Cr to 5 Cr</h3>
      <table>
        <tr><th>Tenure</th><th>Rate</th></tr>
        <tr><td>1 year</td><td>7.00%</td></tr>
        <tr><td>2 years</td><td>7.25%</td></tr>
      </table>
    </div>`;
  process.env.RDA_TIER_AWARE_DEDUP = '1';
  try {
    const chunks = extractTableChunks(html);
    assert.ok(chunks.length >= 2, 'two tables → two chunks');
    const hints = chunks.map((c) => c.tier_hint).sort();
    assert.deepEqual(hints, ['above 3 cr to 5 cr', 'below 3 cr']);
  } finally {
    delete process.env.RDA_TIER_AWARE_DEDUP;
  }
});
