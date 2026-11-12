'use strict';

/**
 * Generic 3-column HTML extractor — dispatcher fallback when no template_id matches.
 *
 * Sprint 006 Step 3a. The dispatcher routes to this module when:
 *   - Bank has no `template_id` in bank-domains.json
 *   - Page kind is `html_static` or `html_js`
 *   - Structure is "obviously 3-column" (tenure / general / senior)
 *
 * This is essentially `coop-bankin-3col-tenure-general-senior.js` with:
 *   - No bank_type filter (applies broadly)
 *   - No `.bank.in` domain implied
 *   - Slightly looser thresholds
 *
 * It is NOT a replacement for `lib/actions/extract_html_table.js` — that file's
 * 1,870-LOC split into deterministic core + LLM fallback is deferred to Sprint 7.
 * See sdlc/sprints/sprint-006/design/extract-html-table-split.md.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/extract-html-table-split.md
 */

const cheerio = require('cheerio');
const { scoreTable, readTableRows } = require('../templating/_helpers/score-table');
const { normalizeAndCanonicalize } = require('../templating/synonyms');
const { parseTenure } = require('../../scripts/utils/parse-tenure');
const { assertTraceability } = require('./_helpers/_assert_traceability');

const DEFAULT_TENURE_CAP_DAYS = 3650;
const DEFAULT_DEPOSIT_RANGE = 'below_3cr';
const RATE_MIN = 0.1;
const RATE_MIN_CURRENCY = 0.01; // Foreign-currency deposit rates (e.g. JPY ~0.05%) can be lower.
const RATE_MAX = 15.0;

const HEADER_TOKEN_TO_FIELD = {
  tenure: 'tenure_text',
  regular: 'rate_general_pct',
  senior: 'rate_senior_pct',
  super_senior: 'rate_super_senior_pct',
};

const RATE_FIELDS = new Set(['rate_general_pct', 'rate_senior_pct', 'rate_super_senior_pct']);

module.exports = {
  template_id: '_generic-html-3col',
  applies_to: {
    kinds: ['html_static', 'html_js'],
  },
  extract,
};

function extract(ctx) {
  const { html, templateExtract = {}, productContext = {} } = ctx;
  if (!html || typeof html !== 'string') return emptyResult('html input is empty or non-string');

  const $ = cheerio.load(html);
  const tables = enumerateScoredTables($);
  if (tables.length === 0) return emptyResult('no <table> elements found on page');

  // Build the list of extract blocks. The new shape is `templateExtract.extracts:
  // [{table_index, header_row, header_span_rows, deposit_range, column_map}]`.
  // Legacy single-block shape (top-level column_map/table_index/header_row) is
  // wrapped into a one-element array for back-compat. When no extract config is
  // supplied at all, fall back to inferring from the highest-scored table —
  // this is the "operator hasn't authored yet" path.
  const tenureCap = templateExtract.tenure_cap_days || DEFAULT_TENURE_CAP_DAYS;
  const extractBlocks = normalizeExtractBlocks(templateExtract);

  const allSlabs = [];
  const perBlockDiagnostics = [];
  let totalRowsSeen = 0;
  const droppedReasons = {};
  const warningsOut = [];

  for (const block of extractBlocks) {
    const candidate = pickCandidateTable(tables, block.table_index);
    if (!candidate) {
      warningsOut.push(`table_index=${block.table_index} not found (page has ${tables.length} table(s))`);
      perBlockDiagnostics.push({ table_index: block.table_index, error: 'table_not_found' });
      continue;
    }
    if (!candidate.rows || candidate.rows.length < 2) {
      perBlockDiagnostics.push({ table_index: block.table_index, error: 'table_too_short', rows: candidate.rows.length });
      continue;
    }

    const headerRowIndex = block.header_row != null ? block.header_row : findHeaderRow(candidate.rows);
    const headerSpan = block.header_span_rows || 1;
    const header = candidate.rows[headerRowIndex] || candidate.rows[0];

    const columnMap = block.column_map || inferColumnMap(header);
    if (!hasRequiredColumns(columnMap)) {
      warningsOut.push(`column_map missing required fields (need tenure + general) for table_index=${block.table_index}; inferred=${JSON.stringify(columnMap)}, header=${JSON.stringify(header)}`);
      perBlockDiagnostics.push({ table_index: block.table_index, error: 'missing_required_columns', column_map: columnMap, header });
      continue;
    }

    const blockSlabs = [];
    let rowsSeen = 0;
    for (let i = 0; i < candidate.rows.length; i++) {
      if (i < headerRowIndex + headerSpan) continue;
      const row = candidate.rows[i];
      rowsSeen++;
      const parsed = parseRow(row, columnMap, tenureCap, block.deposit_range);
      if (parsed.error) {
        droppedReasons[parsed.error] = (droppedReasons[parsed.error] || 0) + 1;
        continue;
      }
      for (const s of parsed.slabs) blockSlabs.push(s);
    }
    totalRowsSeen += rowsSeen;
    perBlockDiagnostics.push({
      table_used_index: candidate.index,
      header_row_text: header.join(' | '),
      rows_seen: rowsSeen,
      rows_kept: blockSlabs.length,
      column_map: columnMap,
      deposit_range: block.deposit_range || null,
      table_score: candidate.score,
    });
    for (const s of blockSlabs) allSlabs.push(s);
  }

  // Anti-fabrication enforcement
  const trace = assertTraceability(allSlabs, { strict: false });
  if (!trace.passed) {
    warningsOut.push(`anti_fabrication: ${trace.failures.length}/${allSlabs.length} slabs failed traceability — dropping`);
    const failingIdx = new Set(trace.failures.map((f) => f.index));
    for (let i = allSlabs.length - 1; i >= 0; i--) if (failingIdx.has(i)) allSlabs.splice(i, 1);
  }

  return {
    slabs: allSlabs,
    effective_date: null,
    warnings: warningsOut,
    diagnostics: {
      // Top-level fields preserve back-compat with older callers that read
      // diagnostics.rows_seen / rows_kept / column_map directly.
      table_used_index: perBlockDiagnostics[0] ? perBlockDiagnostics[0].table_used_index : null,
      header_row_text: perBlockDiagnostics[0] ? perBlockDiagnostics[0].header_row_text : null,
      rows_seen: totalRowsSeen,
      rows_kept: allSlabs.length,
      rows_dropped_reasons: droppedReasons,
      column_map: perBlockDiagnostics[0] ? perBlockDiagnostics[0].column_map : null,
      table_score: perBlockDiagnostics[0] ? perBlockDiagnostics[0].table_score : null,
      extractor_kind: 'generic',
      extract_blocks: perBlockDiagnostics,
    },
  };
}

function normalizeExtractBlocks(templateExtract) {
  // Preferred new shape
  if (Array.isArray(templateExtract.extracts) && templateExtract.extracts.length > 0) {
    return templateExtract.extracts.map((b) => ({
      table_index: Number.isInteger(b.table_index) ? b.table_index : 0,
      header_row: Number.isInteger(b.header_row) ? b.header_row : null,
      header_span_rows: Number.isInteger(b.header_span_rows) ? b.header_span_rows : 1,
      column_map: b.column_map || null,
      deposit_range: typeof b.deposit_range === 'string' ? b.deposit_range : null,
    }));
  }
  // Legacy single-block at top level (kept for older registry entries / tests)
  return [{
    table_index: Number.isInteger(templateExtract.table_index) ? templateExtract.table_index : null,
    header_row: Number.isInteger(templateExtract.header_row) ? templateExtract.header_row : null,
    header_span_rows: Number.isInteger(templateExtract.header_span_rows) ? templateExtract.header_span_rows : 1,
    column_map: templateExtract.column_map || null,
    deposit_range: null,
  }];
}

function pickCandidateTable(scoredTables, requestedIndex) {
  if (requestedIndex == null) {
    // No explicit index — pick highest-scored positive (legacy "operator hasn't authored")
    return scoredTables.find((t) => t.score > 0) || scoredTables[0] || null;
  }
  // Explicit index refers to the source-order index, not the score-sorted order.
  return scoredTables.find((t) => t.index === requestedIndex) || null;
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
    if (!rows[i].some((c) => /\d+\.\d+\s*%?/.test(c))) return i;
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

// Parse a column_map value into its components. Grammar:
//   field
//   field@deposit_range
//   field#CURRENCY
//   field@deposit_range#CURRENCY
// Parse order: split off `#<currency>` FIRST (everything after the first `#`),
// then parse `@<deposit_range>` on the remainder. Currency is uppercased.
function parseFieldSpec(fieldSpec) {
  let rest = fieldSpec;
  let currency = null;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const cur = rest.slice(hash + 1).trim();
    currency = cur ? cur.toUpperCase() : null;
    rest = rest.slice(0, hash);
  }
  let field = rest;
  let depositRange = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    field = rest.slice(0, at);
    depositRange = rest.slice(at + 1) || null;
  }
  return { field, depositRange, currency };
}

function hasRequiredColumns(columnMap) {
  // column_map values can carry @deposit_range and/or #currency suffixes —
  // strip them before checking required fields. Without this, any amount-bucket
  // or currency cross-product table fails the required-fields gate even though
  // the mapping is correct.
  const fields = new Set(Object.values(columnMap).map((v) => parseFieldSpec(v).field));
  return fields.has('tenure_text') && fields.has('rate_general_pct');
}

function parseRow(row, columnMap, tenureCap, blockDepositRange) {
  // Row-shared values
  let tenureText = null;
  let tenureMinDays = null;
  let tenureMaxDays = null;
  // Per-currency, per-deposit-range bucket. Currency is the OUTER grouping so
  // coalesceRanges only ever merges amount-buckets WITHIN the same currency,
  // never across currencies. `null` currency == domestic path (no currency).
  const byCurrency = new Map(); // currency(null|"USD") -> Map<deposit_range, {rates}>
  const ensure = (cur, r) => {
    if (!byCurrency.has(cur)) byCurrency.set(cur, new Map());
    const inner = byCurrency.get(cur);
    if (!inner.has(r)) inner.set(r, {});
    return inner.get(r);
  };

  for (const [colIdx, fieldSpec] of Object.entries(columnMap)) {
    const cell = row[Number(colIdx)];
    if (cell == null) continue;
    // fieldSpec grammar: field[@deposit_range][#currency]
    const { field, depositRange: fieldRange, currency } = parseFieldSpec(fieldSpec);

    if (field === 'tenure_text') {
      tenureText = cell.trim();
      const cleaned = cell.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
      const parsed = parseTenure(cleaned);
      if (parsed && parsed.minDays != null) {
        tenureMinDays = parsed.minDays;
        tenureMaxDays = parsed.maxDays != null ? Math.min(parsed.maxDays, tenureCap) : null;
      }
    } else if (RATE_FIELDS.has(field)) {
      const rate = parseRate(cell);
      if (rate == null) continue;
      const range = fieldRange || blockDepositRange || DEFAULT_DEPOSIT_RANGE;
      ensure(currency, range)[field] = rate;
    }
    // 'ignore' / 'currency' / 'amount' — skip silently
  }

  if (!tenureText) return { error: 'no_tenure_text' };
  if (tenureMinDays == null) return { error: 'unparseable_tenure' };

  const sourceRowText = row.join(' ').replace(/\s+/g, ' ').trim();
  const slabs = [];

  for (const [currency, byRange] of byCurrency.entries()) {
    // Coalesce adjacent amount-buckets with identical rates — PER CURRENCY.
    // When a bank publishes a 7-column bulk table where all 7 sub-buckets show
    // the same 5.60% for a given tenure, we emit ONE slab spanning the union
    // range — not 7 duplicate slabs differing only by deposit_range label.
    // Different rates → still fan out one slab per distinct rate-fingerprint
    // group, with the synthesized range covering each group's contiguous run.
    // Grouping currency on the OUTER loop guarantees we never coalesce two
    // currencies that happen to share a rate value.
    const coalesced = coalesceRanges(byRange);
    const rateMin = currency ? RATE_MIN_CURRENCY : RATE_MIN;
    for (const [range, rates] of coalesced.entries()) {
      if (rates.rate_general_pct == null) continue;
      if (rates.rate_general_pct < rateMin || rates.rate_general_pct > RATE_MAX) continue;
      const slab = {
        tenure_text: tenureText,
        tenure_min_days: tenureMinDays,
        tenure_max_days: tenureMaxDays,
        rate_general_pct: rates.rate_general_pct,
        rate_senior_pct: rates.rate_senior_pct ?? null,
        rate_super_senior_pct: rates.rate_super_senior_pct ?? null,
        deposit_range: range,
        source_row_text: sourceRowText,
      };
      // Only add `currency` when one was actually mapped for this column — the
      // domestic path must NOT gain a currency key (not even currency: null).
      if (currency) slab.currency = currency;
      slabs.push(slab);
    }
  }

  if (slabs.length === 0) return { error: 'no_general_rate' };
  return { slabs };
}

// --- Deposit-range coalescing -------------------------------------------

function rateFingerprint(rates) {
  return `${rates.rate_general_pct ?? '-'}|${rates.rate_senior_pct ?? '-'}|${rates.rate_super_senior_pct ?? '-'}`;
}

// Parse a deposit_range name into [lower, upper] numeric bounds in Crore.
// Lakhs are converted to fractional Crore (1L = 0.01Cr). Returns null when
// the name doesn't match a recognized shape — caller then skips coalescing
// for that group.
function parseDepositRangeBounds(name) {
  if (!name) return null;
  const parseAmount = (s) => {
    const m = String(s).match(/^(\d+(?:\.\d+)?)(cr|l)$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return m[2].toLowerCase() === 'cr' ? n : n / 100;
  };
  let m = name.match(/^below_(\d+(?:\.\d+)?(?:cr|l))$/i);
  if (m) return [0, parseAmount(m[1])];
  m = name.match(/^above_(\d+(?:\.\d+)?(?:cr|l))$/i);
  if (m) return [parseAmount(m[1]), Infinity];
  m = name.match(/^(\d+(?:\.\d+)?(?:cr|l))_to_(\d+(?:\.\d+)?(?:cr|l))$/i);
  if (m) return [parseAmount(m[1]), parseAmount(m[2])];
  return null;
}

function formatBound(n) {
  if (n >= 1) {
    return Number.isInteger(n) ? `${n}cr` : `${n}cr`;
  }
  if (n > 0) {
    const l = n * 100;
    return Number.isInteger(l) ? `${l}l` : `${l.toFixed(2)}l`;
  }
  return '0';
}

function synthesizeRangeName(low, high) {
  if (low === 0) return `below_${formatBound(high)}`;
  if (high === Infinity) return `above_${formatBound(low)}`;
  return `${formatBound(low)}_to_${formatBound(high)}`;
}

// Group `byRange` map entries by their rate fingerprint, then merge entries
// in the same group when their bounds are contiguous (no gap). Single-entry
// groups pass through unchanged. Groups whose entries don't share parseable
// bounds also pass through unchanged (one slab per entry) so we never lose
// information by mis-detecting contiguity.
function coalesceRanges(byRange) {
  if (byRange.size < 2) return byRange;
  const groups = new Map();
  for (const [name, rates] of byRange.entries()) {
    const fp = rateFingerprint(rates);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push({ name, rates, bounds: parseDepositRangeBounds(name) });
  }
  const result = new Map();
  for (const items of groups.values()) {
    if (items.length === 1) {
      result.set(items[0].name, items[0].rates);
      continue;
    }
    const allParseable = items.every((i) => i.bounds);
    if (!allParseable) {
      for (const i of items) result.set(i.name, i.rates);
      continue;
    }
    items.sort((a, b) => a.bounds[0] - b.bounds[0]);
    let contiguous = true;
    for (let i = 1; i < items.length; i++) {
      if (Math.abs(items[i].bounds[0] - items[i - 1].bounds[1]) > 1e-6) { contiguous = false; break; }
    }
    if (!contiguous) {
      for (const i of items) result.set(i.name, i.rates);
      continue;
    }
    const low = items[0].bounds[0];
    const high = items[items.length - 1].bounds[1];
    const mergedName = synthesizeRangeName(low, high);
    result.set(mergedName, items[0].rates);
  }
  return result;
}

function parseRate(cell) {
  if (cell == null) return null;
  const cleaned = String(cell).replace(/[%,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || /^n\/?a$/i.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

function emptyResult(warning) {
  return {
    slabs: [],
    effective_date: null,
    warnings: [warning],
    diagnostics: { table_used_index: null, header_row_text: null, rows_seen: 0, rows_kept: 0, rows_dropped_reasons: {}, column_map: null, table_score: null, extractor_kind: 'generic' },
  };
}
