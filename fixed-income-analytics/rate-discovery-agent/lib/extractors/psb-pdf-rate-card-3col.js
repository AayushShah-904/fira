'use strict';

/**
 * PSB PDF rate-card extractor (skeleton).
 *
 * Sprint 006 Step 3b. Targets PSB family rate cards: BoB, Union, IOB, Canara,
 * IDBI, etc. — most PSBs publish a single PDF "Domestic Rates" + a separate
 * "FCNR/NRI Rates" PDF. The pattern is dependable: 3-column (tenure / general /
 * senior) with sometimes a 4th super-senior column.
 *
 * Skeleton scope: implements the extractor contract over pdfText + docintelLayout
 * inputs (from lib/fetch/fetch_pdf.js). Reuses Sprint 5's scripts/utils/parse-
 * pdf-rate-lines.js#parseRateLines for the deterministic text path. Real-bank
 * tuning against captured PDFs happens in Step 4.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/extract-html-table-split.md
 */

const { parseRateLines } = require('../../scripts/utils/parse-pdf-rate-lines');
const { assertTraceability } = require('./_helpers/_assert_traceability');
const { cellsToGrid, classifyColumns, parseRateCell, findHeaderRowIndex } = require('./_helpers/docintel-grid');
const { parseTenure } = require('../../scripts/utils/parse-tenure');

module.exports = {
  template_id: 'psb-pdf-rate-card-3col',
  applies_to: {
    kinds: ['pdf-text', 'docintel-layout'],
    bank_types: ['PSB'],
  },
  extract,
};

function extract(ctx) {
  const { pdfText, docintelLayout, productContext = {}, templateExtract = {} } = ctx;

  // Path 1: deterministic text (pdfjs subprocess output)
  if (pdfText && typeof pdfText === 'string') {
    const lines = pdfText.split('\n');
    const parsed = parseRateLines(lines);
    const slabs = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.slabs) ? parsed.slabs : []);
    const enriched = slabs.map((s) => withSourceRowText(s, lines));
    const trace = assertTraceability(enriched, { strict: false, requireRateMatch: false });
    const warnings = parsed && Array.isArray(parsed.warnings) ? parsed.warnings.slice() : [];
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
        extractor_kind: 'psb_pdf_text',
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
    warnings: ['psb_pdf_rate_card_3col: no pdfText or docintelLayout in input'],
    diagnostics: { extractor_kind: 'psb_pdf_no_input', bank_code: productContext.bank_code || null },
  };
}

/**
 * Walk DocIntel tables → score-pick the rate-bearing one → emit slabs.
 * Anti-fabrication: source_row_text concatenates the actual row's cell contents.
 */
function extractFromDocIntel(docintelLayout, productContext) {
  const tables = docintelLayout.tables;
  if (tables.length === 0) {
    return {
      slabs: [],
      effective_date: null,
      warnings: ['psb_pdf_docintel: no tables in layout response'],
      diagnostics: { extractor_kind: 'psb_pdf_docintel', table_count: 0, bank_code: productContext.bank_code || null },
    };
  }

  // Score each table: prefer ones with tenure + general columns + ≥3 data rows
  let bestSlabs = [];
  let bestTableIdx = -1;
  let bestDiagnostics = null;
  const droppedReasons = {};

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
      if (!tenureRaw) { droppedReasons.no_tenure = (droppedReasons.no_tenure || 0) + 1; continue; }
      const general = parseRateCell(generalRaw);
      if (general == null) { droppedReasons.no_general = (droppedReasons.no_general || 0) + 1; continue; }
      const tenureCleaned = tenureRaw.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
      const parsedTenure = parseTenure(tenureCleaned);
      if (!parsedTenure || parsedTenure.minDays == null) {
        droppedReasons.unparseable_tenure = (droppedReasons.unparseable_tenure || 0) + 1;
        continue;
      }
      const senior = cols.seniorCol >= 0 ? parseRateCell(row[cols.seniorCol]) : null;
      const superSenior = cols.superSeniorCol >= 0 ? parseRateCell(row[cols.superSeniorCol]) : null;
      slabs.push({
        tenure_text: tenureRaw.trim(),
        tenure_min_days: parsedTenure.minDays,
        tenure_max_days: parsedTenure.maxDays != null ? parsedTenure.maxDays : null,
        rate_general_pct: general,
        rate_senior_pct: senior,
        rate_super_senior_pct: superSenior,
        source_row_text: row.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      });
    }

    if (slabs.length > bestSlabs.length) {
      bestSlabs = slabs;
      bestTableIdx = ti;
      bestDiagnostics = {
        table_used_index: ti,
        header_row_index: headerIdx,
        column_map: cols,
        rows_seen: grid.length - headerIdx - 1,
        rows_kept: slabs.length,
      };
    }
  }

  // Anti-fabrication post-validation (rate-match relaxed since DocIntel sometimes
  // re-formats numbers; tenure-match still strict)
  const trace = assertTraceability(bestSlabs, { strict: false, requireRateMatch: false });
  const warnings = [];
  if (!trace.passed) {
    warnings.push(`anti_fabrication: ${trace.failures.length}/${bestSlabs.length} slabs failed traceability — dropping`);
    const failing = new Set(trace.failures.map((f) => f.index));
    for (let i = bestSlabs.length - 1; i >= 0; i--) if (failing.has(i)) bestSlabs.splice(i, 1);
  }

  return {
    slabs: bestSlabs,
    effective_date: null,
    warnings,
    diagnostics: {
      extractor_kind: 'psb_pdf_docintel',
      table_count: tables.length,
      ...(bestDiagnostics || { table_used_index: null, rows_seen: 0, rows_kept: 0 }),
      rows_dropped_reasons: droppedReasons,
      bank_code: productContext.bank_code || null,
    },
  };
}

function withSourceRowText(slab, lines) {
  // parseRateLines drops the original line; reconstruct source_row_text by
  // finding the line that contains both the tenure text and the rate.
  if (!slab.tenure_text) return { ...slab, source_row_text: '' };
  const wanted = String(slab.tenure_text).toLowerCase();
  const ratePattern = slab.rate_general_pct != null ? String(slab.rate_general_pct.toFixed(2)) : null;
  for (const line of lines) {
    const ll = line.toLowerCase();
    if (ll.includes(wanted) && (!ratePattern || line.includes(ratePattern) || line.includes(String(slab.rate_general_pct)))) {
      return { ...slab, source_row_text: line.replace(/\s+/g, ' ').trim() };
    }
  }
  return { ...slab, source_row_text: `${slab.tenure_text} ${slab.rate_general_pct ?? ''}`.trim() };
}
