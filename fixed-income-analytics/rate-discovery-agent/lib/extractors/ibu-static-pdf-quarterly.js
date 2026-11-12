'use strict';

/**
 * IBU (IFSC Banking Unit) static PDF rate-card extractor (skeleton).
 *
 * Sprint 006 Step 3b. Targets GIFT City IBU banks where rate cards are
 * quarterly PDFs in foreign currency (USD/GBP/EUR/JPY). Pilot 50 includes
 * HDFC-IBU and IDBI-IBU; BoI-IBU + IndusInd-IBU are explicitly deferred to
 * Sprint 7 (100% failures in Sprint 5 — need vendor-specific PDF research).
 *
 * Skeleton scope: handles pdf-text via parse-pdf-rate-lines. Tags every slab
 * with currency from header detection. Real-bank tuning in Step 4 against
 * the captured PDFs from the 2 pilot IBUs.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/extract-html-table-split.md
 */

const { parseRateLines } = require('../../scripts/utils/parse-pdf-rate-lines');
const { assertTraceability } = require('./_helpers/_assert_traceability');
const { cellsToGrid, classifyColumns, parseRateCell, findHeaderRowIndex } = require('./_helpers/docintel-grid');
const { parseTenure } = require('../../scripts/utils/parse-tenure');
const { normaliseCurrency } = require('../../scripts/utils/normalise-currency');

const CURRENCY_HEADER_RE = /\b(USD|GBP|EUR|JPY|CAD|AUD|SGD|CHF|HKD|NZD)\b/i;

module.exports = {
  template_id: 'ibu-static-pdf-quarterly',
  applies_to: {
    kinds: ['pdf-text', 'docintel-layout'],
    bank_types: ['IBU'],
  },
  extract,
};

function extract(ctx) {
  const { pdfText, docintelLayout, productContext = {} } = ctx;

  // Path 2 takes precedence when a DocIntel layout with tables is present.
  // IBU GIFT/FCNR cards are multi-currency MATRICES (tenure × currency columns)
  // that the deterministic line parser (Path 1) cannot read — but
  // fetch_pdf returns BOTH pdfText and docIntelLayout for these (multi-column
  // hint forces the DocIntel route). The structured grid is the authoritative
  // source for matrices, so route to it first; Path 1 stays the fallback for
  // text-only PDFs (no DocIntel layout).
  if (docintelLayout && Array.isArray(docintelLayout.tables) && docintelLayout.tables.length > 0) {
    return extractFromDocIntel(docintelLayout, productContext);
  }

  // Path 1: deterministic text
  if (pdfText && typeof pdfText === 'string') {
    const lines = pdfText.split('\n');
    const parsed = parseRateLines(lines);
    const slabs = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.slabs) ? parsed.slabs : []);

    // Detect the dominant currency from header lines; tag every slab with it.
    // Real implementation in Sprint 7 emits one slab per (tenure × currency)
    // when multiple currency columns are present — for the skeleton, single-
    // currency PDFs work and multi-currency ones get a warning.
    const headerLine = lines.find((l) => CURRENCY_HEADER_RE.test(l)) || '';
    const currencies = [...new Set([...headerLine.matchAll(/\b(USD|GBP|EUR|JPY|CAD|AUD|SGD|CHF|HKD|NZD)\b/gi)].map((m) => m[0].toUpperCase()))];
    const dominantCurrency = currencies[0] || null;

    const enriched = slabs.map((s) => ({
      ...s,
      currency: dominantCurrency,
      source_row_text: findSourceRow(s, lines),
    }));
    const trace = assertTraceability(enriched, { strict: false, requireRateMatch: false });
    const warnings = [];
    if (currencies.length > 1) {
      warnings.push(`ibu_static_pdf_quarterly: multi-currency PDF (${currencies.join(',')}) — Sprint 7 will emit per-(tenure × currency) slabs; skeleton tagged dominant=${dominantCurrency}`);
    }
    if (!dominantCurrency) {
      warnings.push('ibu_static_pdf_quarterly: no currency detected in header — slabs untagged');
    }
    if (!trace.passed) {
      warnings.push(`anti_fabrication: ${trace.failures.length}/${enriched.length} slabs failed traceability — dropping`);
      const failing = new Set(trace.failures.map((f) => f.index));
      for (let i = enriched.length - 1; i >= 0; i--) if (failing.has(i)) enriched.splice(i, 1);
    }
    return {
      slabs: enriched,
      effective_date: null,
      warnings,
      diagnostics: {
        extractor_kind: 'ibu_static_pdf_text',
        currencies_detected: currencies,
        dominant_currency: dominantCurrency,
        rows_seen: slabs.length,
        rows_kept: enriched.length,
        bank_code: productContext.bank_code || null,
      },
    };
  }

  // Path 2: DocIntelligence layout (Sprint 006 Step 3e — un-deferred from Sprint 7)
  if (docintelLayout && Array.isArray(docintelLayout.tables)) {
    return extractFromDocIntel(docintelLayout, productContext);
  }

  return {
    slabs: [],
    effective_date: null,
    warnings: ['ibu_static_pdf_quarterly: no pdfText or docintelLayout in input'],
    diagnostics: { extractor_kind: 'ibu_static_pdf_no_input', bank_code: productContext.bank_code || null },
  };
}

/**
 * DocIntel path for IBU PDFs (Sprint 006 Step 3f).
 *
 * IBU GIFT/FCNR cards are commonly multi-currency MATRICES: tenure rows ×
 * currency columns (e.g. hdfc-bank-ibu header
 * ["Period","FD rate with premature...","USD FD rate without...","EUR FD rate*","GBP FD rate*"],
 * idfc-first-bank-ibu header ["Interest Rates on ...","USD","EUR"]). The old
 * code used classifyColumns to find a single generalCol and ignored the other
 * currency columns, yielding 0/wrong slabs.
 *
 * New behaviour: for each table, detect every CURRENCY COLUMN by scanning the
 * header for an ISO currency token, then emit one slab per (tenure × currency),
 * each tagged with its column's currency. The table that yields the most
 * currency-tagged slabs wins (this naturally drops hdfc's premature-withdrawal
 * *terms* table, which has no currency columns). When NO table has any currency
 * column (single-currency cards with a generic "Rate" header), fall back to the
 * legacy single-generalCol path so we don't regress those.
 */

// Word-boundary ISO currency-code matcher. A header cell is a "currency column"
// iff it contains exactly one of these codes (e.g. "USD FD rate*" → USD).
const CCY_TOKEN_RE = /\b(USD|GBP|EUR|JPY|CAD|AUD|SGD|CHF|HKD|NZD|AED)\b/i;

/**
 * Build colIndex -> currency map for a header row. A cell qualifies only when
 * it contains exactly one distinct ISO code (a cell mentioning two codes is
 * ambiguous and skipped). Cells with no code are not currency columns —
 * this is what drops hdfc's "FD rate with premature withdrawal" col 1.
 */
function detectCurrencyColumns(headerRow) {
  const map = {};
  if (!Array.isArray(headerRow)) return map;
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] || '');
    const matches = [...h.matchAll(/\b(USD|GBP|EUR|JPY|CAD|AUD|SGD|CHF|HKD|NZD|AED)\b/gi)]
      .map((m) => m[1].toUpperCase());
    const distinct = [...new Set(matches)];
    if (distinct.length === 1) map[i] = distinct[0];
  }
  return map;
}

function extractFromDocIntel(docintelLayout, productContext) {
  const tables = docintelLayout.tables;
  if (tables.length === 0) {
    return {
      slabs: [],
      effective_date: null,
      warnings: ['ibu_static_pdf_docintel: no tables in layout response'],
      diagnostics: { extractor_kind: 'ibu_static_pdf_docintel', table_count: 0, bank_code: productContext.bank_code || null },
    };
  }

  // -- Header-level currency detection (for diagnostics + dominantCurrency,
  //    preserved from the prior implementation for back-compat). --
  const detectedCurrencies = new Set();
  for (const t of tables) {
    const g = cellsToGrid(t);
    if (g.length === 0) continue;
    const hdrIdx = findHeaderRowIndex(g);
    for (const cell of g[hdrIdx]) {
      const exact = normaliseCurrency(cell);
      if (exact) { detectedCurrencies.add(exact); continue; }
      const m = String(cell || '').match(CCY_TOKEN_RE);
      if (m) detectedCurrencies.add(m[1].toUpperCase());
    }
  }
  const currencies = [...detectedCurrencies];
  const dominantCurrency = currencies[0] || null;

  // -- Pass 1: multi-currency MATRIX extraction (one slab per tenure × currency). --
  // Pick the table that yields the most currency-tagged slabs.
  let bestSlabs = [];
  let bestDiag = null;
  let anyCurrencyColumnSeen = false;

  for (let ti = 0; ti < tables.length; ti++) {
    const grid = cellsToGrid(tables[ti]);
    if (grid.length < 2) continue;
    const headerIdx = findHeaderRowIndex(grid);
    const ccyCols = detectCurrencyColumns(grid[headerIdx]);
    const ccyColIndices = Object.keys(ccyCols).map(Number);
    if (ccyColIndices.length === 0) continue; // no currency columns → not a matrix table
    anyCurrencyColumnSeen = true;

    // Tenure column: prefer classifier, default to 0.
    const cols = classifyColumns(grid[headerIdx]);
    let tenureCol = cols.tenureCol;
    if (tenureCol < 0) tenureCol = 0;

    const slabs = [];
    for (let r = headerIdx + 1; r < grid.length; r++) {
      const row = grid[r];
      const tenureRaw = row[tenureCol];
      if (!tenureRaw) continue;
      const tenureCleaned = tenureRaw.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
      const parsedTenure = parseTenure(tenureCleaned);
      if (!parsedTenure || parsedTenure.minDays == null) continue;
      const sourceRow = row.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      for (const ci of ccyColIndices) {
        const rate = parseRateCell(row[ci]);
        if (rate == null) continue; // skips null / "-" / empty
        slabs.push({
          tenure_text: tenureRaw.trim(),
          tenure_min_days: parsedTenure.minDays,
          tenure_max_days: parsedTenure.maxDays != null ? parsedTenure.maxDays : null,
          rate_general_pct: rate,
          rate_senior_pct: null, // FCNR/GIFT have no senior premium
          rate_super_senior_pct: null,
          currency: ccyCols[ci],
          source_row_text: sourceRow,
        });
      }
    }
    if (slabs.length > bestSlabs.length) {
      bestSlabs = slabs;
      bestDiag = {
        table_used_index: ti,
        header_row_index: headerIdx,
        currency_columns: ccyCols,
        tenure_col: tenureCol,
        rows_seen: grid.length - headerIdx - 1,
        rows_kept: slabs.length,
      };
    }
  }

  const warnings = [];
  let extractorKind = 'ibu_static_pdf_docintel_matrix';

  // -- Pass 2 (back-compat): no table had any currency column → legacy
  //    single-generalCol extraction so single-currency cards don't regress. --
  if (!anyCurrencyColumnSeen) {
    extractorKind = 'ibu_static_pdf_docintel';
    for (let ti = 0; ti < tables.length; ti++) {
      const grid = cellsToGrid(tables[ti]);
      if (grid.length < 2) continue;
      const headerIdx = findHeaderRowIndex(grid);
      const cols = classifyColumns(grid[headerIdx]);
      if (cols.tenureCol < 0 || cols.generalCol < 0) continue;

      const slabs = [];
      for (let r = headerIdx + 1; r < grid.length; r++) {
        const row = grid[r];
        const tenureRaw = row[cols.tenureCol];
        const generalRaw = row[cols.generalCol];
        if (!tenureRaw) continue;
        const general = parseRateCell(generalRaw);
        if (general == null) continue;
        const tenureCleaned = tenureRaw.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
        const parsedTenure = parseTenure(tenureCleaned);
        if (!parsedTenure || parsedTenure.minDays == null) continue;
        slabs.push({
          tenure_text: tenureRaw.trim(),
          tenure_min_days: parsedTenure.minDays,
          tenure_max_days: parsedTenure.maxDays != null ? parsedTenure.maxDays : null,
          rate_general_pct: general,
          rate_senior_pct: null,
          rate_super_senior_pct: null,
          currency: dominantCurrency,
          source_row_text: row.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
        });
      }
      if (slabs.length > bestSlabs.length) {
        bestSlabs = slabs;
        bestDiag = { table_used_index: ti, header_row_index: headerIdx, column_map: cols, rows_seen: grid.length - headerIdx - 1, rows_kept: slabs.length };
      }
    }
    if (!dominantCurrency) {
      warnings.push('ibu_static_pdf_docintel: no currency detected in headers — slabs untagged');
    }
  }

  // Anti-fabrication post-validation
  const trace = assertTraceability(bestSlabs, { strict: false, requireRateMatch: false });
  if (!trace.passed) {
    warnings.push(`anti_fabrication: ${trace.failures.length}/${bestSlabs.length} slabs failed traceability — dropping`);
    const failing = new Set(trace.failures.map((f) => f.index));
    for (let i = bestSlabs.length - 1; i >= 0; i--) if (failing.has(i)) bestSlabs.splice(i, 1);
  }

  // Distinct currencies actually emitted on slabs (matrix path).
  const slabCurrencies = [...new Set(bestSlabs.map((s) => s.currency).filter(Boolean))];

  return {
    slabs: bestSlabs,
    effective_date: null,
    warnings,
    diagnostics: {
      extractor_kind: extractorKind,
      table_count: tables.length,
      currencies_detected: currencies,
      slab_currencies: slabCurrencies,
      dominant_currency: dominantCurrency,
      ...(bestDiag || { table_used_index: null, rows_seen: 0, rows_kept: 0 }),
      bank_code: productContext.bank_code || null,
    },
  };
}

function findSourceRow(slab, lines) {
  if (!slab.tenure_text) return '';
  const wanted = String(slab.tenure_text).toLowerCase();
  for (const line of lines) {
    if (line.toLowerCase().includes(wanted)) return line.replace(/\s+/g, ' ').trim();
  }
  return `${slab.tenure_text} ${slab.rate_general_pct ?? ''}`.trim();
}
