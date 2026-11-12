'use strict';

/**
 * Template fingerprinting — Sprint 005 Phase A.
 *
 * Given a rendered HTML body (or PDF text / DocIntelligence layout / image
 * placeholder), produce a content-free structural signature that's stable
 * across rate-number drift and bank-name variation. Two banks running the
 * same site template produce the same template_hash and therefore share an
 * extractor in Phase C.
 *
 * Spec: ../../sdlc/sprints/sprint-005/design/template-fingerprinting.md
 */

const crypto = require('node:crypto');
const cheerio = require('cheerio');
const { scoreTable, readTableRows } = require('./_helpers/score-table');
const { normalizeAndCanonicalize } = require('./synonyms');

const MAX_TREE_DEPTH = 6;            // walk depth cap for the tag-tree skeleton
const SLAB_BUCKETS = [
  { max: 0,  label: '0' },
  { max: 3,  label: '1-3' },
  { max: 8,  label: '4-8' },
  { max: 15, label: '9-15' },
  { max: 30, label: '16-30' },
  { max: Infinity, label: '30+' },
];

const VALID_KINDS = new Set(['html', 'pdf-text', 'docintel-layout', 'image']);

/**
 * Main entry point.
 *
 * @param {object} input
 * @param {string} input.html              For kind='html', the rendered body.
 * @param {string} [input.pdfText]         For kind='pdf-text'.
 * @param {object} [input.docintelLayout]  For kind='docintel-layout'.
 * @param {object} [input.image]           For kind='image' (dimensions, ocr_confidence).
 * @param {string} input.url               The page URL (used for domain TLD axis).
 * @param {string} [input.kind='html']
 * @returns {{template_hash, structural_signature, candidate_tables, reason}}
 */
function fingerprintPage({ html, pdfText, docintelLayout, image, url, kind = 'html' } = {}) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`fingerprintPage: invalid kind ${JSON.stringify(kind)}; expected one of ${[...VALID_KINDS].join(', ')}`);
  }
  const domainTld = pickDomainTld(url);

  if (kind !== 'html') {
    return fingerprintNonHtml({ kind, pdfText, docintelLayout, image, domainTld });
  }

  if (!html || typeof html !== 'string') {
    return packResult({
      structural_signature: { kind, domain_tld: domainTld, empty: true },
      candidate_tables: [],
      reason: 'empty-html',
    });
  }

  const $ = cheerio.load(html);

  // Score all <table>s to find the rate region anchor (densest rate table).
  const candidateTables = enumerateCandidateTables($);
  const top = candidateTables[0] || null;
  const anchor = top && top.score > 0 ? top : null;

  // Component 1: tag-tree skeleton rooted at the anchor (or <body> if none).
  const skeletonRoot = anchor ? anchor.$el : $('body').first();
  const tagTreeSkeleton = walkSkeleton($, skeletonRoot[0] || null, 0);

  // Component 2: header-cell vector for each candidate table (sorted set).
  const headerVectors = candidateTables.map((c) => buildHeaderVector(c.rows));

  // Component 3: slab-row-count bucket of the anchor.
  const slabBucket = anchor ? bucketRowCount(anchor.rows.length) : '0';

  // Component 4: framework hint.
  const frameworkHint = sniffFramework($, html);

  // Component 5: domain TLD (computed above).

  const signature = {
    kind: 'html',
    tag_tree_skeleton: tagTreeSkeleton,
    header_vectors: headerVectors,
    slab_bucket: slabBucket,
    framework_hint: frameworkHint,
    domain_tld: domainTld,
  };

  return packResult({
    structural_signature: signature,
    candidate_tables: candidateTables.map((c) => ({
      index: c.index,
      score: c.score,
      header_vector: buildHeaderVector(c.rows),
      row_count: c.rows.length,
      col_count: c.signals.colCount,
    })),
    reason: anchor ? 'ok' : 'no-rate-table',
  });
}

function packResult({ structural_signature, candidate_tables, reason }) {
  const canonical = JSON.stringify(structural_signature, Object.keys(structural_signature).sort());
  const hash = 'sha1:' + crypto.createHash('sha1').update(canonical).digest('hex');
  return {
    template_hash: hash,
    structural_signature,
    candidate_tables,
    reason,
  };
}

function fingerprintNonHtml({ kind, pdfText, docintelLayout, image, domainTld }) {
  let signature;
  if (kind === 'pdf-text') {
    const text = typeof pdfText === 'string' ? pdfText : '';
    signature = {
      kind,
      domain_tld: domainTld,
      page_count_bucket: bucketPageCount((text.match(/\f/g) || []).length + 1),
      has_currency_keywords: /\b(USD|GBP|EUR|JPY|CAD|AUD|SGD)\b/.test(text),
      column_count_hint: estimatePdfColumnCount(text),
    };
  } else if (kind === 'docintel-layout') {
    const tables = (docintelLayout && Array.isArray(docintelLayout.tables)) ? docintelLayout.tables : [];
    signature = {
      kind,
      domain_tld: domainTld,
      table_count_bucket: bucketRowCount(tables.length),
      columns_per_table: tables.map((t) => t.columnCount || 0).sort((a, b) => a - b),
      headers_normalized: tables.map((t) => buildHeaderVectorFromCells(extractHeaderCells(t))),
    };
  } else if (kind === 'image') {
    signature = {
      kind,
      domain_tld: domainTld,
      dimensions_bucket: image ? bucketDimensions(image.width, image.height) : 'unknown',
      ocr_confidence_bucket: image ? bucketConfidence(image.ocrConfidence) : 'unknown',
    };
  } else {
    signature = { kind, domain_tld: domainTld };
  }
  return packResult({
    structural_signature: signature,
    candidate_tables: [],
    reason: `non-html:${kind}`,
  });
}

function enumerateCandidateTables($) {
  const out = [];
  let idx = 0;
  $('table').each((_, el) => {
    const $t = $(el);
    const rows = readTableRows($, $t);
    if (rows.length === 0) return;
    const { score, signals } = scoreTable(rows);
    out.push({ index: idx++, $el: $t, rows, score, signals });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Walk the DOM rooted at a node and emit a compact tag-tree skeleton:
 * tag[.class-prefix] per node, separated by ">" for parent-child and "+" for
 * sibling-after-first. Caps at MAX_TREE_DEPTH and at the first 60 nodes per
 * level so a 200-row table doesn't dominate the signature.
 */
function walkSkeleton($, root, depth) {
  if (!root || depth > MAX_TREE_DEPTH) return '';
  const tag = root.name || (root.type === 'root' ? '#root' : '#text');
  const classToken = firstClassPrefix(root);
  const selfLabel = classToken ? `${tag}.${classToken}` : tag;

  const childParts = [];
  let childCount = 0;
  for (const child of (root.children || [])) {
    if (child.type !== 'tag') continue;
    if (childCount >= 60) { childParts.push('…'); break; }
    childParts.push(walkSkeleton($, child, depth + 1));
    childCount++;
  }
  if (childParts.length === 0) return selfLabel;
  return `${selfLabel}>(${childParts.join('+')})`;
}

function firstClassPrefix(node) {
  if (!node.attribs) return '';
  const cls = node.attribs.class;
  if (!cls) return '';
  const first = String(cls).trim().split(/\s+/)[0];
  if (!first) return '';
  // collapse trailing variant suffixes like -alt, -first, -row, --modifier
  return first.replace(/[-_]?(?:alt|first|last|row|cell|odd|even|active)\d*$/i, '').slice(0, 20);
}

function buildHeaderVector(rows) {
  if (!rows || rows.length === 0) return [];
  // Take the first row that doesn't contain a rate-like cell — it's the header.
  // If every row has rates, take row 0 anyway (likely no explicit header row).
  let header = rows[0];
  for (const r of rows) {
    if (!r.some((c) => /\d+\.\d+\s*%?/.test(c))) { header = r; break; }
  }
  return buildHeaderVectorFromCells(header);
}

function buildHeaderVectorFromCells(cells) {
  if (!cells) return [];
  const tokens = cells.map(normalizeAndCanonicalize).filter(Boolean);
  return [...new Set(tokens)].sort();
}

function bucketRowCount(n) {
  for (const b of SLAB_BUCKETS) if (n <= b.max) return b.label;
  return '30+';
}

function bucketPageCount(n) {
  if (n <= 1) return '1';
  if (n <= 4) return '2-4';
  if (n <= 10) return '5-10';
  return '10+';
}

function bucketDimensions(w, h) {
  if (!w || !h) return 'unknown';
  const max = Math.max(w, h);
  if (max < 600) return 'small';
  if (max < 1500) return 'medium';
  if (max < 3000) return 'large';
  return 'xlarge';
}

function bucketConfidence(c) {
  if (c == null) return 'unknown';
  if (c >= 0.9) return 'high';
  if (c >= 0.7) return 'medium';
  return 'low';
}

function estimatePdfColumnCount(text) {
  // Crude: count percentage signs on a few representative lines, treat that as
  // a rough proxy for column count. The real signal comes from DocIntel layout
  // (kind: docintel-layout); pdfText fingerprint is a coarse anchor.
  const lines = text.split('\n').filter((l) => /\d+\.\d+/.test(l)).slice(0, 20);
  if (lines.length === 0) return '0';
  const avg = lines.reduce((a, l) => a + (l.match(/\d+\.\d+/g) || []).length, 0) / lines.length;
  if (avg < 1.5) return '1';
  if (avg < 2.5) return '2';
  if (avg < 3.5) return '3';
  if (avg < 5)   return '4';
  return '5+';
}

function extractHeaderCells(table) {
  // DocIntel layout table shape: { cells: [{rowIndex, columnIndex, content, kind?}] }
  if (!table || !Array.isArray(table.cells)) return [];
  const header = table.cells.filter((c) => c.kind === 'columnHeader' || c.rowIndex === 0);
  header.sort((a, b) => (a.columnIndex || 0) - (b.columnIndex || 0));
  return header.map((c) => c.content || '');
}

function sniffFramework($, html) {
  const lower = String(html).toLowerCase();
  const tokens = new Set();
  if (lower.includes('wp-content') || lower.includes('wp-includes')) tokens.add('wordpress');
  if (lower.includes('/etc.clientlibs/') || lower.includes('aem.js')) tokens.add('aem');
  if (lower.includes('class="ng-') || lower.includes('ng-version=')) tokens.add('angular');
  if (lower.includes('data-reactroot') || lower.includes('__next')) tokens.add('react');
  if (lower.includes('vue.js') || lower.includes('__nuxt')) tokens.add('vue');
  if (lower.includes('bootstrap') || $('link[href*="bootstrap"]').length > 0) tokens.add('bootstrap');
  if ($('.ui-accordion, .panel-collapse, .accordion').length > 0) tokens.add('accordion');
  if ($('iframe').length > 0) tokens.add('iframe');
  if (lower.includes('jquery')) tokens.add('jquery');
  if (lower.includes('liferay')) tokens.add('liferay');
  return [...tokens].sort();
}

function pickDomainTld(url) {
  if (!url) return 'unknown';
  const w = String(url).toLowerCase();
  if (w.includes('.bank.in')) return '.bank.in';
  if (/\.co\.in(\/|$|\?)/.test(w)) return '.co.in';
  if (/\.com(\/|$|\?)/.test(w)) return '.com';
  if (/\.org(\/|$|\?)/.test(w)) return '.org';
  if (/\.in(\/|$|\?)/.test(w)) return '.in';
  return 'other';
}

module.exports = {
  fingerprintPage,
  // exported for unit tests:
  _internal: {
    walkSkeleton,
    buildHeaderVector,
    sniffFramework,
    pickDomainTld,
    bucketRowCount,
    enumerateCandidateTables,
  },
};
