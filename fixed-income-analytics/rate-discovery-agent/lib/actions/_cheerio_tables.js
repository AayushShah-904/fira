'use strict';

/**
 * Cheerio-based <table> extraction with multi-table scoring.
 *
 * Replaces the regex-based parseHtmlTables from scripts/extract_rates.js for
 * the orchestrator's extract_html_table action. Better at:
 *
 *   - Nested DOM (tbody, thead, tfoot, rowspan/colspan) — cheerio handles
 *     the parse tree; the old regex `<tr>...<\/tr>` matcher missed nesting.
 *   - Entity decoding (&nbsp;, &amp;, &#8377;) — cheerio's $.text() handles
 *     these consistently.
 *   - Multi-table layouts — Indian bank pages routinely have 3–8 tables
 *     (rate table + comparison table + premium tenures + senior citizen
 *     callout + "as on" footnote table). Scoring lets us pick the one
 *     that's actually the rate table instead of the first match.
 *
 * Scoring heuristics (sum to a final score; highest wins):
 *
 *   + 5 per row that contains a percentage cell (X.YY% or X.YY)
 *   + 3 per row that contains a tenure-like cell (N days/months/years)
 *   + 3 per row that has BOTH a percentage AND a tenure cell (real rate row)
 *   + 2 per column the table has beyond 2 (multi-rate-column = "general /
 *     senior / super-senior" structure typical of FD tables)
 *   – 15 if the table text mentions "card rate", "existing rate", "revised
 *     rate", "comparison", or "w.e.f." — those are typically footnotes
 *     or compare-tables that look rate-shaped but aren't the canonical one.
 *   – 5 if the table has only 1 data row (likely a callout, not a rate
 *     table — real rate tables have 8+ tenure rows).
 *
 * The scorer is deliberately bounded (no per-row score exceeds 11) so a
 * single noisy table can't outscore a real 10-row rate table.
 */

const cheerio = require('cheerio');

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
 * Parse HTML and return scored tables.
 *
 * Looks at:
 *   - Standard <table> elements (with nested thead/tbody/tfoot)
 *   - Semantic role="table" containers
 *   - Repeated sibling div/li structures that look row-shaped (a.k.a. "div
 *     tables" — common in React/Vue/Angular UIs and Liferay portlets)
 *
 * @param {string} html - rendered HTML (e.g., from Playwright page.content())
 * @returns {Array<{index: number, rows: string[][], score: number, signals: object, source: string}>}
 *   sorted by score descending. Tables with score <= 0 are still included
 *   so the caller can log them for debugging, but they should not be picked.
 */
function extractScoredTables(html) {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);
  const out = [];
  let idx = 0;
  $('table').each((_, tableEl) => {
    const $table = $(tableEl);
    const rows = readTableRows($, $table);
    if (rows.length === 0) return;
    const { score, signals } = scoreTable(rows);
    // Orch-1 (sprint-004 2026-05-21): expose `$el` and `$` so the caller can
    // walk DOM ancestors per table (e.g., `extractTableTierLabel` /
    // `captureSectionContext`) without re-parsing the HTML. Non-enumerable-ish
    // by convention (prefix `_` discouraged; existing tests pass `.rows` /
    // `.score` / `.signals` selectively so adding fields is back-compat).
    out.push({ index: idx++, rows, score, signals, source: 'table', $el: $table, $ });
  });
  for (const cand of extractDivTables($)) {
    const { score, signals } = scoreTable(cand.rows);
    // Slight penalty for div-tables: standard <table>s are more authoritative
    // when both exist on the same page.
    out.push({ index: idx++, rows: cand.rows, score: score - 2, signals: { ...signals, source: cand.source }, source: cand.source, $el: cand.$el || null, $ });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Detect non-`<table>` rate tables: containers whose direct children include
 * multiple row-like elements with both a tenure-shaped string and a
 * percentage-shaped string.
 *
 * Heuristic walks two pattern families:
 *   1. role="table" / role="rowgroup" semantic containers
 *   2. divs / uls whose direct children each contain rate-row text
 *
 * Returns candidates as { rows: string[][], source: 'div-table'|'role-table' }.
 * The caller scores them just like <table>s.
 */
function extractDivTables($) {
  const candidates = [];

  // Pattern 1: explicit role="table"
  $('[role="table"]').each((_, el) => {
    const $t = $(el);
    if ($t.find('table').length > 0) return; // a real <table> inside; let the table scan handle it
    const rows = readRoleTableRows($, $t);
    if (rows.length >= 3) candidates.push({ rows, source: 'role-table', $el: $t });
  });

  // Pattern 2: repeated row-like siblings inside any container. Be conservative
  // to avoid grabbing nav menus — require at least 3 children with BOTH a
  // tenure AND a percentage in their text, and require the container to NOT
  // contain a <table> (handled separately above).
  const seen = new WeakSet();
  $('div, ul, ol, section').each((_, el) => {
    if (seen.has(el)) return;
    const $c = $(el);
    if ($c.find('table').length > 0) return;
    if ($c.find('[role="table"]').length > 0) return;
    const $children = $c.children();
    if ($children.length < 3 || $children.length > 50) return;

    let bothCount = 0;
    const rows = [];
    $children.each((_, child) => {
      // joinedText inserts spaces between adjacent text nodes — cheerio's
      // .text() concatenates without separators, so "<span>1 year</span>
      // <span>6.5%</span>" reads as "1 year6.5%" and breaks word-boundary
      // tenure detection. joinedText keeps the boundary intact.
      const text = joinedText($, $(child));
      if (!text) return;
      const hasPct = PCT_RE.test(text);
      const hasTenure = TENURE_RE.test(text);
      if (hasPct && hasTenure) {
        bothCount++;
        rows.push(splitDivRow($, $(child)));
      }
    });
    if (bothCount >= 3) {
      candidates.push({ rows, source: 'div-table', $el: $c });
      // Mark descendants seen so we don't re-extract from a child container.
      $c.find('*').each((_, d) => seen.add(d));
    }
  });

  return candidates;
}

/**
 * Read a role="table" container into rows. Looks for role="row" within,
 * and role="cell"/"columnheader"/"rowheader" within each row.
 */
function readRoleTableRows($, $table) {
  const rows = [];
  $table.find('[role="row"]').each((_, tr) => {
    const cells = [];
    $(tr).find('[role="cell"], [role="columnheader"], [role="rowheader"], [role="gridcell"]').each((_, c) => {
      cells.push($(c).text().replace(/\s+/g, ' ').trim());
    });
    if (cells.some((c) => c.length > 0)) rows.push(cells);
  });
  return rows;
}

/**
 * Like cheerio's .text() but inserts a space between adjacent text nodes
 * (cheerio's default concatenates them, breaking word boundaries — for
 * example "<span>1 year</span><span>6.5%</span>" returns "1 year6.5%" which
 * fails a TENURE_RE that anchors on `\bdays?\b` / `\byears?\b`).
 */
function joinedText($, $el) {
  return $el.contents().map((_, n) => {
    if (n.type === 'text') return n.data;
    return joinedText($, $(n));
  }).get().join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort split of a div-row into cells. Tries:
 *   1. Direct child span/div/p text
 *   2. Tab-separated fragments
 *   3. Whole-row text as a single cell
 *
 * Quality varies by site; downstream column_mapping has to be lenient.
 */
function splitDivRow($, $row) {
  const children = $row.children('span, div, p, td, th, li').toArray()
    .map((c) => $(c).text().replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0);
  if (children.length >= 2) return children;
  // Fall back to tab-separated text
  const text = $row.text().replace(/\s+/g, ' ').trim();
  const tabs = text.split(/\t/).map((s) => s.trim()).filter(Boolean);
  if (tabs.length >= 2) return tabs;
  return [text];
}

/**
 * Walk a cheerio <table> element and produce string[][] rows.
 * Handles thead/tbody/tfoot transparently — the relative position of <tr>
 * doesn't matter for our purposes. Whitespace is normalized; entities
 * decoded by cheerio's text() automatically.
 *
 * Note: this is the simple flat reader. The Fix #5 rowspan/colspan/nested-
 * table expansion attempted in commit 5160f26 was reverted 2026-05-23 —
 * see sdlc/sprints/sprint-004/implementation/cohort-pm-q2-clean-pass-... .
 * The earlier Fix #1c picker (currency-count ranking in extractWithCheerio)
 * carried the FCNR-recovery load for Canara/IDBI/City-Union/Punjab-Sind/
 * Dhanlaxmi/Karnataka without any rowspan expansion. The rowspan rewrite
 * never validated against the live PNB page (Playwright blocked from this
 * dev host) and DID inject 12 spurious Call-Deposit rows into ICICI's
 * FCNR table that Phase C3's tenure-filter then had to clean up. Truly
 * mashed-cell layouts go through the Phase D screenshot+OCR pipeline.
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

  // Column-count bonus: rate tables usually have 3-5 columns (tenure +
  // general + senior + super-senior + maybe deposit-range).
  signals.colCount = Math.max(...rows.map((r) => r.length), 0);
  if (signals.colCount > 2) score += Math.min((signals.colCount - 2) * 2, 8);

  // Penalty: single-data-row tables are usually callouts.
  if (signals.dataRows === 1) score -= 5;

  // Penalty: footnote / comparison tables.
  const allText = rows.map((r) => r.join(' ')).join(' ');
  if (NOISE_PATTERNS.some((re) => re.test(allText))) {
    score -= 15;
    signals.noisy = true;
  }

  return { score, signals };
}

/**
 * Convenience: parse HTML, score tables, and return the rows of the highest-
 * scoring one (or null if no positive-score table exists).
 */
function pickBestTable(html) {
  const tables = extractScoredTables(html);
  if (tables.length === 0) return null;
  if (tables[0].score <= 0) return null;
  return tables[0];
}

/**
 * Extract per-table chunks with surrounding context for LLM extraction
 * (prompt-improvement-2026-05-18). The whole-page payload used to land
 * past the LLM input cap and the model hallucinated to fill gaps; sending
 * one table at a time keeps every chunk well under any reasonable cap and
 * forces the model to reason about exactly one table's contents.
 *
 * Each chunk includes:
 *   - `tableHtml` — outerHTML of the <table> element (raw, no normalisation).
 *   - `contextHtml` — preceding sibling/ancestor text within ~2000 chars,
 *     focused on headings (`<h1..h6>`, `<caption>`) and any `<p>` containing
 *     `w.e.f.` / `effective` / `as on` (where the W.E.F. banner usually
 *     lives). Concatenated newline-separated in document order.
 *   - `signals` + `score` — same scoring as extractScoredTables.
 *
 * `extractScoredTables` returns the same scored set but with pre-parsed
 * `rows` instead of HTML — keep both. The new helper only walks <table>
 * elements (not div-tables) because (a) the LLM benefits more from the
 * original HTML which preserves rowspan/colspan/styling cues, and (b) div-
 * tables are a small minority and the deterministic Path A handles them.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {number} [opts.maxChunkChars=30000] — per-chunk hard cap; tables
 *   larger than this are truncated (kept slabs may be incomplete, but the
 *   LLM should mark `errors: ["input_truncated_mid_table"]`).
 * @param {number} [opts.contextLookbackChars=2000] — how far up the DOM
 *   to search for heading + WEF context.
 * @returns {Array<{ index, tableHtml, contextHtml, signals, score }>}
 *   sorted by score descending.
 */
function extractTableChunks(html, { maxChunkChars = 30000, contextLookbackChars = 2000 } = {}) {
  if (!html || typeof html !== 'string') return [];
  const tierAware = process.env.RDA_TIER_AWARE_DEDUP === '1';
  const $ = cheerio.load(html);
  const out = [];
  let idx = 0;
  $('table').each((_, tableEl) => {
    const $t = $(tableEl);
    const rows = readTableRows($, $t);
    if (rows.length === 0) return;
    const { score, signals } = scoreTable(rows);

    let tableHtml = $.html($t) || '';
    if (tableHtml.length > maxChunkChars) {
      // Cheap structural cap. Single tables rarely exceed 30 KB; when they
      // do, the LLM prompt explicitly requires reporting truncation in
      // `errors[]`, so the caller still ships only verified slabs.
      tableHtml = tableHtml.slice(0, maxChunkChars) + '\n<!-- CHUNK_TRUNCATED -->';
    }

    const contextHtml = buildTableContext($, $t, contextLookbackChars);

    // A4 (sprint-004 / tier-header-propagation) — capture the closest
    // section-heading text above the table as a deposit-tier hint.
    // Gated on RDA_TIER_AWARE_DEDUP=1 through the 12-bank rung to avoid
    // disturbing Sprint 3 baselines until the wider smoke confirms safety.
    const tier_hint = tierAware ? extractTableTierLabel($, $t, contextLookbackChars) : null;

    out.push({ index: idx++, tableHtml, contextHtml, signals, score, tier_hint });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Find the closest preceding section-heading-like element to a `<table>`
 * and return its text as a deposit-tier hint. Used by A4 to label tier-
 * stacked tables (AU SFB-style: < ₹3 Cr / ₹3-5 Cr / ≥ ₹5 Cr stacked).
 *
 * Walks the same DOM ancestor-chain that `buildTableContext` does, but
 * stops at the FIRST heading-shaped sibling within ~300 chars upstream
 * and returns just that text. `buildTableContext` returns the full
 * heading + WEF concat; this returns the single label most likely to
 * name the table's tier.
 *
 * Returns the lowercased trimmed text (up to 200 chars) or null if no
 * heading-like sibling exists within the search window.
 */
function extractTableTierLabel($, $table, lookbackChars = 300) {
  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, caption, strong, b';
  let cursor = $table;
  let budget = lookbackChars;
  while (cursor.length && budget > 0) {
    // Closest preceding sibling first (reverse document order).
    const sibs = cursor.prevAll().toArray();
    for (const sib of sibs) {
      const $sib = $(sib);
      const text = ($sib.text() || '').trim();
      if (!text) continue;
      // Match either when the sibling IS a heading-shape element or
      // CONTAINS one as a child (some banks wrap headings in <div>).
      const isHeading = $sib.is(HEADING_SELECTOR) || $sib.find(HEADING_SELECTOR).length > 0;
      if (isHeading) {
        // Don't return giant blobs — most legitimate tier labels are short.
        return text.toLowerCase().slice(0, 200);
      }
      // Charge sibling text against the budget so we don't walk too far
      // through prose between the heading and the table.
      budget -= Math.min(text.length, 500);
      if (budget <= 0) return null;
    }
    cursor = cursor.parent();
    if (!cursor.length || cursor[0].name === 'html' || cursor[0].name === undefined) break;
  }
  return null;
}

/**
 * Walk preceding siblings + ancestor's preceding siblings up to ~2000 chars
 * of recovered text, capturing heading + WEF banner blocks in document
 * order. Bounded so we never emit more than the lookback budget.
 */
function buildTableContext($, $table, lookbackChars) {
  const HEADING = 'h1, h2, h3, h4, h5, h6, caption, thead';
  const WEF_RE = /\b(?:w\.?e\.?f\.?|effective|as\s+on)\b/i;
  const pieces = [];
  let remaining = lookbackChars;

  // Walk back from the table element. Collect preceding siblings of the
  // table itself, then of each ancestor, until we have enough or run out.
  let cursor = $table;
  while (cursor.length && remaining > 0) {
    // Preceding siblings, in reverse-document order (closest first); we
    // unshift to keep the final array in document order.
    const sibs = cursor.prevAll().toArray();
    for (const sib of sibs) {
      if (remaining <= 0) break;
      const $sib = $(sib);
      const tag = (sib.tagName || sib.name || '').toLowerCase();
      const text = ($sib.text() || '').trim();
      if (!text) continue;

      const isHeading = $sib.is(HEADING) || $sib.find(HEADING).length > 0;
      const hasWef = WEF_RE.test(text);

      if (isHeading || hasWef) {
        const snippet = text.slice(0, Math.min(remaining, 500));
        pieces.unshift(`[${tag}] ${snippet}`);
        remaining -= snippet.length + tag.length + 3;
      }
    }
    cursor = cursor.parent();
    if (!cursor.length || cursor[0].name === 'html' || cursor[0].name === undefined) break;
  }

  return pieces.join('\n');
}

module.exports = {
  extractScoredTables,
  extractTableChunks,
  extractTableTierLabel,
  pickBestTable,
  // Exposed for unit testing:
  _scoreTable: scoreTable,
  _readTableRows: readTableRows,
  _buildTableContext: buildTableContext,
};
