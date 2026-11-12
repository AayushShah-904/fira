'use strict';

/**
 * Foreign bank multi-variant extractor (skeleton).
 *
 * Sprint 006 Step 3b. Targets non-WAF foreign banks (DBS India, Citi, SBM,
 * Emirates NBD, MUFG, B-of-B-K, StanChart, HSBC India). Most have multi-variant
 * pages similar in shape to PVBs but with different domain TLDs (.com vs .co.in)
 * and frequently iframe-wrapped rate widgets.
 *
 * Skeleton scope: delegates to _generic-html-3col for the regular variant.
 * Real-bank tuning in Step 4. WAF-blocked FBs (Amex, Barclays, Nova Scotia,
 * Fino) are explicitly out of the pilot — they go straight to manual
 * curation via bin/approve-accept.js in Sprint 7.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/extract-html-table-split.md
 */

const generic3col = require('./_generic-html-3col');
const cheerio = require('cheerio');
const { scoreTable, readTableRows } = require('../templating/_helpers/score-table');
const { extractFromCurrencyMatrix } = require('./_helpers/currency-matrix');
const { assertTraceability } = require('./_helpers/_assert_traceability');

module.exports = {
  template_id: 'fb-multi-variant',
  applies_to: {
    kinds: ['html_static', 'html_js'],
    bank_types: ['FB'],
  },
  extract,
};

function extract(ctx) {
  const { productContext = {} } = ctx;
  const variant = (productContext && productContext.variant) || 'regular';

  if (variant === 'regular' || variant === 'nre' || variant === 'nro') {
    const result = generic3col.extract(ctx);
    return {
      ...result,
      diagnostics: { ...result.diagnostics, extractor_kind: 'fb_multi_variant_via_generic3col', variant },
    };
  }

  if (variant === 'fcnr' || variant === 'gift') {
    return extractCurrencyMatrixFromHtml(ctx, variant);
  }

  return {
    slabs: [],
    effective_date: null,
    warnings: [`fb_multi_variant: unknown variant "${variant}"`],
    diagnostics: { extractor_kind: 'fb_multi_variant_unknown_variant', bank_code: productContext.bank_code || null },
  };
}

function extractCurrencyMatrixFromHtml(ctx, variant) {
  const { html, productContext = {} } = ctx;
  if (!html) {
    return {
      slabs: [], effective_date: null,
      warnings: ['fb_multi_variant: html input missing'],
      diagnostics: { extractor_kind: 'fb_multi_variant_currency_matrix', variant, bank_code: productContext.bank_code || null },
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
      warnings: ['fb_multi_variant: no <table> elements on page'],
      diagnostics: { extractor_kind: 'fb_multi_variant_currency_matrix', variant, bank_code: productContext.bank_code || null },
    };
  }

  const result = extractFromCurrencyMatrix(best.rows);
  const warnings = [];
  if (!result.pattern) warnings.push('fb_multi_variant: no currency-matrix pattern detected');

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
      extractor_kind: 'fb_multi_variant_currency_matrix',
      variant,
      pattern: result.pattern,
      ...result.diagnostics,
      table_score: best.score,
      bank_code: productContext.bank_code || null,
    },
  };
}
