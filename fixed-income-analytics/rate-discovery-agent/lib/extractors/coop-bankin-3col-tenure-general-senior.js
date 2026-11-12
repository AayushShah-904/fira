'use strict';

/**
 * Extractor: coop-bankin-3col-tenure-general-senior
 *
 * Sprint 005 Phase C — the HIGHEST-LEVERAGE extractor per Phase 0.1 cluster
 * analysis. The top 6 success clusters (103 banks combined) all share this
 * signature:
 *   html_static / .bank.in / regular-only / has-senior / 3-column (tenure +
 *   general + senior, optional super-senior 4th)
 *
 * Covers: DCCB / SUCB / NSUCB / SSCB / RRB co-operative banks on the
 * RBI-mandated .bank.in domain family.
 *
 * Design: ../../sdlc/sprints/sprint-005/design/extractor-registry.md
 */

const cheerio = require('cheerio');
const { scoreTable, readTableRows } = require('../templating/_helpers/score-table');
const { normalizeAndCanonicalize } = require('../templating/synonyms');
const { parseTenure } = require('../../scripts/utils/parse-tenure');
const { assertTraceability } = require('./_helpers/_assert_traceability');

const DEFAULT_TENURE_CAP_DAYS = 3650;
const RATE_MIN = 0.1;
const RATE_MAX = 15.0;

// Column-token → slab-field assignment used when the template doesn't carry
// an explicit column_map (e.g., automated authoring before operator review).
const HEADER_TOKEN_TO_FIELD = {
  tenure: 'tenure_text',
  regular: 'rate_general_pct',
  senior: 'rate_senior_pct',
  super_senior: 'rate_super_senior_pct',
};

module.exports = {
  template_id: 'coop-bankin-3col-tenure-general-senior',
  applies_to: {
    kinds: ['html_static', 'html_js'],
    framework_hints: ['wordpress', 'jquery', null],
    bank_types: ['DCCB', 'SUCB', 'NSUCB', 'SSCB', 'RRB'],
  },
  extract,
};

function extract(ctx) {
  const { html, templateExtract = {}, productContext = {} } = ctx;
  if (!html || typeof html !== 'string') {
    return emptyResult('html input is empty or non-string');
  }

  const $ = cheerio.load(html);
  const tables = enumerateScoredTables($);
  if (tables.length === 0) {
    return emptyResult('no <table> elements found on page');
  }

  // Honor templateExtract.table_selector if provided; otherwise pick the
  // highest-scoring positively-scored table.
  let candidate;
  if (templateExtract.table_selector) {
    const matches = $(templateExtract.table_selector);
    if (matches.length === 0) {
      return emptyResult(`table_selector "${templateExtract.table_selector}" matched zero tables`);
    }
    const idx = Math.min(templateExtract.table_index || 0, matches.length - 1);
    const $t = matches.eq(idx);
    const rows = readTableRows($, $t);
    const scored = scoreTable(rows);
    candidate = { index: idx, rows, score: scored.score, signals: scored.signals, source: 'selector' };
  } else {
    candidate = tables.find((t) => t.score > 0) || tables[0];
  }

  if (!candidate.rows || candidate.rows.length < 2) {
    return emptyResult('chosen table has fewer than 2 rows');
  }

  // Identify the header row: first row with NO rate-shaped cells, or row 0 if all rows have rates.
  const headerRowIndex = templateExtract.header_row != null
    ? templateExtract.header_row
    : findHeaderRow(candidate.rows);
  const headerSpan = templateExtract.header_span_rows || 1;
  const header = candidate.rows[headerRowIndex] || candidate.rows[0];

  // Build column map: prefer explicit templateExtract.column_map, else infer from header tokens.
  const columnMap = templateExtract.column_map || inferColumnMap(header);
  if (!hasRequiredColumns(columnMap)) {
    return emptyResult(`column_map missing required fields (need at least tenure + general): inferred=${JSON.stringify(columnMap)}, header=${JSON.stringify(header)}`);
  }

  const tenureCap = templateExtract.tenure_cap_days || DEFAULT_TENURE_CAP_DAYS;
  const slabs = [];
  const rowsDroppedReasons = {};
  let rowsSeen = 0;

  for (let i = 0; i < candidate.rows.length; i++) {
    if (i < headerRowIndex + headerSpan) continue;
    const row = candidate.rows[i];
    rowsSeen++;
    const slab = parseRow(row, columnMap, tenureCap);
    if (slab.error) {
      rowsDroppedReasons[slab.error] = (rowsDroppedReasons[slab.error] || 0) + 1;
      continue;
    }
    slabs.push(slab.slab);
  }

  // Anti-fabrication contract: enforce strict traceability.
  // Use strict:false in extractor and surface failures as warnings so a single
  // bad row doesn't lose the whole bank. Callers (golden tests, runtime)
  // re-assert with strict:true to abort on contract violation.
  const trace = assertTraceability(slabs, { strict: false });
  const warnings = [];
  if (!trace.passed) {
    warnings.push(`anti_fabrication: ${trace.failures.length}/${slabs.length} slabs failed traceability — dropping`);
    // Remove failing slabs by index (high-to-low so indices stay valid)
    const failingIdx = new Set(trace.failures.map((f) => f.index));
    for (let i = slabs.length - 1; i >= 0; i--) if (failingIdx.has(i)) slabs.splice(i, 1);
  }

  return {
    slabs,
    effective_date: findEffectiveDate($) || null,
    warnings,
    diagnostics: {
      table_used_index: candidate.index,
      header_row_text: header.join(' | '),
      rows_seen: rowsSeen,
      rows_kept: slabs.length,
      rows_dropped_reasons: rowsDroppedReasons,
      column_map: columnMap,
      table_score: candidate.score,
    },
  };
}

function enumerateScoredTables($) {
  const out = [];
  let idx = 0;
  $('table').each((_, el) => {
    const $t = $(el);
    const rows = readTableRows($, $t);
    if (rows.length === 0) return;
    const { score, signals } = scoreTable(rows);
    out.push({ index: idx++, rows, score, signals });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 3); i++) {
    const r = rows[i];
    if (!r.some((c) => /\d+\.\d+\s*%?/.test(c))) return i;
  }
  return 0;
}

function inferColumnMap(header) {
  const map = {};
  for (let i = 0; i < header.length; i++) {
    const canon = normalizeAndCanonicalize(header[i]);
    const field = HEADER_TOKEN_TO_FIELD[canon];
    if (field && !Object.values(map).includes(field)) {
      map[String(i)] = field;
    }
  }
  return map;
}

function hasRequiredColumns(columnMap) {
  const fields = new Set(Object.values(columnMap));
  return fields.has('tenure_text') && fields.has('rate_general_pct');
}

function parseRow(row, columnMap, tenureCap) {
  const slab = {
    tenure_text: null,
    tenure_min_days: null,
    tenure_max_days: null,
    rate_general_pct: null,
    rate_senior_pct: null,
    rate_super_senior_pct: null,
    source_row_text: row.join(' ').replace(/\s+/g, ' ').trim(),
  };

  for (const [colIdx, field] of Object.entries(columnMap)) {
    const cell = row[Number(colIdx)];
    if (cell == null) continue;
    if (field === 'tenure_text') {
      slab.tenure_text = cell.trim();
      // Strip parentheticals for parsing — but keep the original text for traceability.
      const cleaned = cell.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
      const parsed = parseTenure(cleaned);
      if (parsed && parsed.minDays != null) {
        slab.tenure_min_days = parsed.minDays;
        slab.tenure_max_days = parsed.maxDays != null ? Math.min(parsed.maxDays, tenureCap) : null;
      }
    } else if (field === 'rate_general_pct' || field === 'rate_senior_pct' || field === 'rate_super_senior_pct') {
      const rate = parseRate(cell);
      if (rate != null) slab[field] = rate;
    }
  }

  // Required-field guards
  if (!slab.tenure_text) return { error: 'no_tenure_text' };
  if (slab.tenure_min_days == null) return { error: 'unparseable_tenure' };
  if (slab.rate_general_pct == null) return { error: 'no_general_rate' };
  if (slab.rate_general_pct < RATE_MIN || slab.rate_general_pct > RATE_MAX) return { error: 'general_rate_out_of_bounds' };

  return { slab };
}

function parseRate(cell) {
  if (cell == null) return null;
  const cleaned = String(cell).replace(/[%,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || /^n\/?a$/i.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

function findEffectiveDate($) {
  // Look for "w.e.f." / "with effect from" / "effective from" / "as on" patterns
  // in the page body. Best-effort — returns null if nothing matches.
  const bodyText = $('body').text().replace(/\s+/g, ' ');
  const patterns = [
    /\bw\.?e\.?f\.?\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    /\bwith\s+effect\s+from\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    /\beffective\s+(?:from\s+)?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
    /\bas\s+on\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
  ];
  for (const re of patterns) {
    const m = bodyText.match(re);
    if (m) return m[1];
  }
  return null;
}

function emptyResult(warning) {
  return {
    slabs: [],
    effective_date: null,
    warnings: [warning],
    diagnostics: {
      table_used_index: null,
      header_row_text: null,
      rows_seen: 0,
      rows_kept: 0,
      rows_dropped_reasons: {},
      column_map: null,
      table_score: null,
    },
  };
}
