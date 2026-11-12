'use strict';

/**
 * PVB multi-variant HTML extractor (skeleton).
 *
 * Sprint 006 Step 3b. Targets PVB family (HDFC, ICICI, Axis, Kotak, IndusInd,
 * YES, Federal, RBL, IDFCFirst, Bandhan) where the rate page typically carries
 * MULTIPLE variants on one or linked pages: regular + NRE + NRO + FCNR.
 *
 * Skeleton scope: delegates to _generic-html-3col for the regular variant when
 * the page is structurally 3-col; for FCNR currency-matrix tables, the
 * dispatcher should route to a fcnr-currency-matrix template (Sprint 7).
 * Real-bank tuning in Step 4 — Axis has 324 slabs across variants and is the
 * largest single bank in the cohort.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/extract-html-table-split.md
 */

const generic3col = require('./_generic-html-3col');
const cheerio = require('cheerio');
const { scoreTable, readTableRows } = require('../templating/_helpers/score-table');
const { extractFromCurrencyMatrix } = require('./_helpers/currency-matrix');
const { assertTraceability } = require('./_helpers/_assert_traceability');

module.exports = {
  template_id: 'pvb-multi-variant',
  applies_to: {
    kinds: ['html_static', 'html_js'],
    bank_types: ['PVB'],
  },
  extract,
};

function extract(ctx) {
  const { templateExtract = {}, productContext = {} } = ctx;
  const variant = (productContext && productContext.variant) || 'regular';

  // Regular variant: delegate to the generic 3-col extractor with PVB-friendly
  // defaults. The dispatcher passes templateExtract.column_map when the
  // operator-authored template has refined it.
  if (variant === 'regular' || variant === 'nre' || variant === 'nro') {
    const result = generic3col.extract({ ...ctx, templateExtract });
    return {
      ...result,
      diagnostics: { ...result.diagnostics, extractor_kind: 'pvb_multi_variant_via_generic3col', variant },
    };
  }

  // FCNR / GIFT: Sprint 006 Step 3f (un-deferred from Sprint 7) — real
  // currency-matrix extraction via lib/extractors/_helpers/currency-matrix.js.
  if (variant === 'fcnr' || variant === 'gift') {
    return extractCurrencyMatrixFromHtml(ctx, variant);
  }

  return {
    slabs: [],
    effective_date: null,
    warnings: [`pvb_multi_variant: unknown variant "${variant}"`],
    diagnostics: { extractor_kind: 'pvb_multi_variant_unknown_variant', bank_code: productContext.bank_code || null },
  };
}

/**
 * Sprint 006 Step 3f — extract FCNR/GIFT currency-matrix from HTML.
 * Picks the best-scoring table, then dispatches into currency-matrix helper.
 */
function extractCurrencyMatrixFromHtml(ctx, variant) {
  const { html, productContext = {} } = ctx;
  if (!html) {
    return {
      slabs: [], effective_date: null,
      warnings: ['pvb_multi_variant: html input missing'],
      diagnostics: { extractor_kind: 'pvb_multi_variant_currency_matrix', variant, bank_code: productContext.bank_code || null },
    };
  }
  const $ = cheerio.load(html);
  let best = null;
  $('table').each((_, el) => {
    const $t = $(el);
    const rows = readTableRows($, $t);
    if (rows.length < 2) return;
    const { score } = scoreTable(rows);
    if (!best || score > best.score) best = { rows, score };
  });

  if (!best) {
    return {
      slabs: [], effective_date: null,
      warnings: ['pvb_multi_variant: no <table> elements on page'],
      diagnostics: { extractor_kind: 'pvb_multi_variant_currency_matrix', variant, bank_code: productContext.bank_code || null },
    };
  }

  const result = extractFromCurrencyMatrix(best.rows);
  const warnings = [];
  if (!result.pattern) warnings.push('pvb_multi_variant: no currency-matrix pattern detected; rate columns may use unrecognized currency codes');

  // Anti-fabrication — tenure must match; rate-match relaxed for matrix patterns
  const trace = assertTraceability(result.slabs, { strict: false, requireRateMatch: false });
  if (!trace.passed) {
    warnings.push(`anti_fabrication: ${trace.failures.length}/${result.slabs.length} slabs failed traceability — dropping`);
    const failing = new Set(trace.failures.map((f) => f.index));
    for (let i = result.slabs.length - 1; i >= 0; i--) if (failing.has(i)) result.slabs.splice(i, 1);
  }

  return {
    slabs: result.slabs,
    effective_date: null,
    warnings,
    diagnostics: {
      extractor_kind: 'pvb_multi_variant_currency_matrix',
      variant,
      pattern: result.pattern,
      ...result.diagnostics,
      table_score: best.score,
      bank_code: productContext.bank_code || null,
    },
  };
}
