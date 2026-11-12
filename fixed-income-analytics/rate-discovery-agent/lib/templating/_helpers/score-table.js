'use strict';

/**
 * Shared "is this <table> a rate table?" scorer.
 *
 * Sprint 005 Phase A — extracted from lib/actions/_cheerio_tables.js so the
 * template fingerprint (lib/templating/fingerprint.js) and the future Phase C
 * generic HTML extractor (lib/extractors/_generic-html-3col.js) score tables
 * the same way. Cluster-equivalence implies extractor-equivalence — and that
 * holds only if both modules pick the same rate region.
 *
 * The original copy in lib/actions/_cheerio_tables.js is intentionally kept
 * during the Phase F stub period so existing call-sites (extract_html_table.js)
 * continue to work without coupling to this new path.
 */

const PCT_RE = /\d+\.\d+\s*%?/;
const TENURE_RE = /\b\d+\s*(?:days?|d|months?|mo|m|years?|y|weeks?|wk|w)\b/i;
const NOISE_PATTERNS = [
  /\bcard\s+rate\b/i,
  /\bexisting\s+rate\b/i,
  /\brevised\s+rate\b/i,
  /\bcomparison\b/i,
  /\bw\.?e\.?f\.?\b/i,
];

/**
 * Score a table represented as string[][] rows.
 * @param {string[][]} rows
 * @returns {{score: number, signals: {pctRows, tenureRows, bothRows, dataRows, noisy, colCount}}}
 */
function scoreTable(rows) {
  let score = 0;
  const signals = { pctRows: 0, tenureRows: 0, bothRows: 0, dataRows: 0, noisy: false, colCount: 0 };

  for (const row of rows) {
    const joined = row.join(' ');
    const hasPct = PCT_RE.test(joined);
    const hasTenure = TENURE_RE.test(joined);
    if (hasPct) { signals.pctRows++; score += 5; }
    if (hasTenure) { signals.tenureRows++; score += 3; }
    if (hasPct && hasTenure) { signals.bothRows++; score += 3; }
    if (hasPct || hasTenure) signals.dataRows++;
  }

  signals.colCount = Math.max(...rows.map((r) => r.length), 0);
  if (signals.colCount > 2) score += Math.min((signals.colCount - 2) * 2, 8);

  if (signals.dataRows === 1) score -= 5;

  const allText = rows.map((r) => r.join(' ')).join(' ');
  if (NOISE_PATTERNS.some((re) => re.test(allText))) {
    score -= 15;
    signals.noisy = true;
  }

  return { score, signals };
}

/**
 * Flat row reader: walks all <tr> in a cheerio $table and extracts cell text.
 * Whitespace is normalized; entities are decoded by cheerio's text().
 */
function readTableRows($, $table) {
  const rows = [];
  $table.find('tr').each((_, tr) => {
    const cells = [];
    $(tr).find('th, td').each((_, cell) => {
      const text = $(cell).text().replace(/\s+/g, ' ').trim();
      cells.push(text);
    });
    if (cells.some((c) => c.length > 0)) rows.push(cells);
  });
  return rows;
}

module.exports = {
  PCT_RE,
  TENURE_RE,
  NOISE_PATTERNS,
  scoreTable,
  readTableRows,
};
