'use strict';

/**
 * LLM-propose flow used by scripts/author-template.js.
 *
 * Sprint 006 Step 1h (un-deferred from Sprint 7). When the operator runs
 * author-template.js for a bank whose fingerprint matches no existing
 * template, this module calls AOAI with a focused prompt
 * (lib/prompts/author-template.md) and structured table-chunk context,
 * then parses a strict-JSON response describing the proposed
 * {template_id_suggestion, column_map, wait_hints, click_to_reveal, reason}.
 *
 * Pure functions + an injection point for the LLM client so tests don't
 * need real AOAI credentials.
 */

const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { extractTableChunks } = require('../actions/_cheerio_tables');

const PROMPT_PATH = path.resolve(__dirname, '..', 'prompts', 'author-template.md');

const VALID_FIELDS = new Set([
  'tenure_text',
  'rate_general_pct',
  'rate_senior_pct',
  'rate_super_senior_pct',
  'currency',
  'amount',
  'ignore',
]);

/**
 * Build the user prompt for the LLM-propose call.
 * Returns { system, user } strings.
 *
 * @param {object} args
 * @param {string} args.bankCode
 * @param {string} args.variant         regular|nre|nro|fcnr|gift
 * @param {string} args.url
 * @param {string} args.html            rendered HTML
 * @param {object} [args.systemTemplate] override the system prompt text (for testing)
 * @returns {{system: string, user: string}}
 */
function buildProposePrompt({ bankCode, variant, url, html, systemTemplate } = {}) {
  if (!html || typeof html !== 'string') throw new Error('buildProposePrompt: html required');
  const system = systemTemplate || fs.readFileSync(PROMPT_PATH, 'utf-8');

  // Extract top-N table chunks (score-ordered) for the LLM to choose from.
  // 12 candidates: multi-table pages (ESAF SFB ~7 FD tables, Emirates NBD ~10
  // rate tables, plus HDFC/BoB retail+bulk) routinely carry more rate tables
  // than the old cap of 6 — that cap silently dropped the lower-scored bulk /
  // amount-tier / callable / non-callable tables before the LLM ever saw them,
  // which is the root cause of multi-table UNDER-extraction. extractTableChunks
  // already returns chunks sorted by score descending (the scorer rewards
  // tenure+rate rows and penalizes fee/comparison/footnote tables), so the
  // top 12 are the most-rate-table-like candidates. The prompt grows but stays
  // well under the model's input limit (each chunk is capped at 8000 chars).
  // Cost note: ~2x the candidate payload of the old cap on dense multi-table
  // pages; single-table co-op banks (the bulk of the corpus) are unaffected
  // because they simply have fewer than 12 tables.
  const chunks = extractTableChunks(html, { maxChunkChars: 8000 }).slice(0, 12);

  // Compute a compact row-level preview + duplicate fingerprint per candidate.
  // The contextHtml that extractTableChunks emits walks preceding DOM siblings
  // and on real pages (e.g. ESAF) it bleeds the nearest section heading (often
  // "FCNR (B) Deposits") onto EVERY table — so the LLM can't tell distinct
  // domestic tables apart, nor tell a true desktop/mobile DUPLICATE from a
  // genuinely-different table, and it collapses to a single block (the
  // multi-table under-extraction). Sending the actual header + first/last data
  // rows gives the model concrete evidence, and `duplicate_of` flags the
  // responsive-twin tables explicitly so it maps DISTINCT tables once each.
  const previews = chunks.map((c) => tablePreview(c.tableHtml));
  const fpToFirst = new Map(); // content fingerprint → first candidate's table_index
  const duplicateOf = previews.map((p) => {
    if (!p || !p.fingerprint) return null;
    if (fpToFirst.has(p.fingerprint)) return fpToFirst.get(p.fingerprint);
    fpToFirst.set(p.fingerprint, undefined); // marker set after we know index
    return null;
  });
  // Second pass: record the owning index now that we have a stable order.
  fpToFirst.clear();
  for (let i = 0; i < chunks.length; i++) {
    const p = previews[i];
    if (!p || !p.fingerprint) continue;
    if (fpToFirst.has(p.fingerprint)) duplicateOf[i] = fpToFirst.get(p.fingerprint);
    else { fpToFirst.set(p.fingerprint, chunks[i].index); duplicateOf[i] = null; }
  }

  const candidatePayload = chunks.map((c, i) => ({
    // table_index is the SOURCE-ORDER DOM index (which `<table>` this is on the
    // page, 0-indexed). The extractor uses this to look up the table at runtime
    // — so the LLM MUST return this exact value as `table_index` in its
    // response, not its position in the sorted candidate list.
    table_index: c.index,
    score: c.score,
    signals: c.signals,
    // Row-level preview: the header row(s) + first 2 and last 2 data rows. Lets
    // the model compare tables by their ACTUAL content (tenures + rates) instead
    // of trusting the noisy section-heading contextHtml.
    header_rows: previews[i] ? previews[i].headerRows : [],
    first_data_rows: previews[i] ? previews[i].firstRows : [],
    last_data_rows: previews[i] ? previews[i].lastRows : [],
    data_row_count: previews[i] ? previews[i].dataRowCount : null,
    // When non-null, this candidate is an EXACT content duplicate (desktop/mobile
    // twin) of the candidate at this table_index — map only ONE of the pair.
    duplicate_of: duplicateOf[i],
    context_html: c.contextHtml || '',
    table_html: c.tableHtml,
  }));

  const user = [
    `bank_code: ${bankCode}`,
    `variant: ${variant}`,
    `url: ${url}`,
    `candidate_tables_count: ${chunks.length}`,
    ``,
    `Candidate tables (score-ordered, top ${chunks.length}):`,
    JSON.stringify(candidatePayload, null, 2),
    ``,
    `Return strict JSON per the schema. Pick which candidate_index is the rate table; map its columns to slab fields.`,
  ].join('\n');

  return { system, user };
}

/**
 * Read a candidate <table>'s HTML into a compact preview: up to 2 header-ish
 * rows (rows with no decimal-rate cell, leading), the first 2 and last 2 data
 * rows (rows containing a rate-shaped cell), and a content fingerprint of ALL
 * data rows. The fingerprint lets buildProposePrompt flag exact desktop/mobile
 * duplicate tables so the LLM maps each DISTINCT table once.
 *
 * Cells are truncated to keep the payload small; the fingerprint uses the full
 * normalized data-row text so near-identical tables that differ only in a
 * trailing footnote still fingerprint apart.
 */
function tablePreview(tableHtml) {
  if (!tableHtml || typeof tableHtml !== 'string') return null;
  let rows;
  try {
    const $ = cheerio.load(tableHtml);
    rows = [];
    $('tr').each((_, tr) => {
      const cells = [];
      $(tr).find('th, td').each((__, c) => cells.push($(c).text().replace(/\s+/g, ' ').trim()));
      if (cells.some((c) => c.length > 0)) rows.push(cells);
    });
  } catch { return null; }
  if (rows.length === 0) return null;

  const RATE_CELL = /\d+\.\d+/;
  const isData = (r) => r.some((c) => RATE_CELL.test(c));
  const headerRows = [];
  let firstDataAt = rows.length;
  for (let i = 0; i < rows.length; i++) {
    if (isData(rows[i])) { firstDataAt = i; break; }
    if (headerRows.length < 2) headerRows.push(rows[i].map(trimCell));
  }
  const dataRows = rows.slice(firstDataAt).filter(isData);
  const firstRows = dataRows.slice(0, 2).map((r) => r.map(trimCell));
  const lastRows = dataRows.slice(-2).map((r) => r.map(trimCell));
  const fingerprint = dataRows.map((r) => r.join('|')).join('\n').replace(/\s+/g, ' ').trim();
  return { headerRows, firstRows, lastRows, dataRowCount: dataRows.length, fingerprint };
}

function trimCell(c) {
  return String(c).slice(0, 40);
}

/**
 * Parse + validate the LLM's strict-JSON response.
 *
 * @param {string|object} raw      Either the raw string from chat.completions
 *                                 OR the already-parsed object
 * @returns {{
 *   template_id_suggestion: string|null,
 *   table_index: number,
 *   header_row: number,
 *   header_span_rows: number,
 *   column_map: object,
 *   tenure_cap_days: number|null,
 *   wait_hints: object|null,
 *   click_to_reveal: string[]|null,
 *   reason: string,
 * }}
 * @throws on parse failure or schema violation
 */
function parseProposeResponse(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    let stripped = raw.trim();
    // Tolerate fenced code blocks if the model wraps the JSON; strip them.
    stripped = stripped.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { parsed = JSON.parse(stripped); }
    catch (e) { throw new Error(`parseProposeResponse: JSON parse failed: ${e.message}`); }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('parseProposeResponse: response must be an object');
  }

  const out = {
    template_id_suggestion: typeof parsed.template_id_suggestion === 'string' ? parsed.template_id_suggestion : null,
    // `extracts` is the canonical multi-block shape; legacy top-level
    // {column_map, table_index, header_row, header_span_rows} is auto-wrapped
    // into a single-element array below.
    extracts: [],
    tenure_cap_days: Number.isInteger(parsed.tenure_cap_days) ? parsed.tenure_cap_days : null,
    wait_hints: parsed.wait_hints && typeof parsed.wait_hints === 'object' ? parsed.wait_hints : null,
    click_to_reveal: Array.isArray(parsed.click_to_reveal) ? parsed.click_to_reveal.filter((s) => typeof s === 'string') : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };

  if (Array.isArray(parsed.extracts) && parsed.extracts.length > 0) {
    for (const e of parsed.extracts) {
      const block = validateExtractBlock(e);
      if (block) out.extracts.push(block);
    }
  } else if (parsed.column_map) {
    // Legacy shape — single extract at top level
    const block = validateExtractBlock({
      table_index: parsed.table_index,
      header_row: parsed.header_row,
      header_span_rows: parsed.header_span_rows,
      column_map: parsed.column_map,
      deposit_range: typeof parsed.deposit_range === 'string' ? parsed.deposit_range : null,
    });
    if (block) out.extracts.push(block);
  }

  if (out.template_id_suggestion === null) {
    // LLM explicitly couldn't identify — this is allowed by the prompt contract
    return out;
  }
  if (out.extracts.length === 0) {
    throw new Error(`parseProposeResponse: no usable extract block for template_id_suggestion="${out.template_id_suggestion}"`);
  }
  // At least one extract block must have a tenure mapping AND at least one rate field
  const hasTenure = out.extracts.some((e) => {
    const fields = new Set(Object.values(e.column_map).map(stripDepositRange));
    return fields.has('tenure_text');
  });
  const hasGeneralRate = out.extracts.some((e) => {
    const fields = new Set(Object.values(e.column_map).map(stripDepositRange));
    return fields.has('rate_general_pct');
  });
  if (!hasTenure) throw new Error('parseProposeResponse: no extract block maps "tenure_text"');
  if (!hasGeneralRate) throw new Error('parseProposeResponse: no extract block maps "rate_general_pct"');

  // Back-compat mirror: expose the first extract block's fields at the top
  // level so older callers (and the existing test suite) can keep reading
  // `proposal.column_map` / `proposal.table_index`. New callers should prefer
  // `proposal.extracts`.
  if (out.extracts.length > 0) {
    const first = out.extracts[0];
    out.table_index = first.table_index;
    out.header_row = first.header_row;
    out.header_span_rows = first.header_span_rows;
    out.column_map = first.column_map;
  }
  return out;
}

function stripDepositRange(fieldSpec) {
  // Strip both the optional #currency suffix and the optional @deposit_range
  // suffix to recover the bare field name. Currency is stripped first since it
  // is always the trailing component (field[@range][#currency]).
  let s = fieldSpec;
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  const at = s.indexOf('@');
  return at >= 0 ? s.slice(0, at) : s;
}

function validateExtractBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const column_map = validateColumnMap(raw.column_map);
  if (!column_map || Object.keys(column_map).length === 0) return null;
  return {
    table_index: Number.isInteger(raw.table_index) ? raw.table_index : 0,
    header_row: Number.isInteger(raw.header_row) ? raw.header_row : 0,
    header_span_rows: Number.isInteger(raw.header_span_rows) ? raw.header_span_rows : 1,
    column_map,
    deposit_range: typeof raw.deposit_range === 'string' && raw.deposit_range.length > 0 ? raw.deposit_range : null,
  };
}

function validateColumnMap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (typeof v !== 'string') continue;
    // Accept "field", "field@deposit_range", "field#CURRENCY", or
    // "field@deposit_range#CURRENCY". Strip both suffixes to recover the bare
    // field name for validation; preserve the full spec in the output so the
    // extractor can split it again. Only the field part is validated here —
    // the deposit_range and currency components are free-form.
    const field = stripDepositRange(v);
    if (!VALID_FIELDS.has(field)) continue;
    out[String(idx)] = v;
  }
  return out;
}

/**
 * Full propose pipeline. Builds prompt, calls LLM (via injectable client),
 * parses + validates response.
 *
 * @param {object} args
 * @param {string} args.bankCode
 * @param {string} args.variant
 * @param {string} args.url
 * @param {string} args.html
 * @param {object} [args.logger]
 * @param {function} [args._chat]      Test injection — signature: ({messages, model, response_format}) => Promise<{choices: [{message: {content}}]}>
 * @param {function} [args._createClient]  Test injection
 * @returns {Promise<{proposal, prompt, raw_response}>}
 */
async function proposeTemplate(args) {
  const { bankCode, variant, url, html, logger, _chat, _createClient } = args || {};

  if (!html) throw new Error('proposeTemplate: html required');

  const { system, user } = buildProposePrompt({ bankCode, variant, url, html });

  let chatFn = _chat;
  if (!chatFn) {
    // Lazy-require so tests that pass _chat don't need AOAI configured.
    if (!process.env.AZURE_OPENAI_ENDPOINT) {
      const e = new Error('proposeTemplate: AZURE_OPENAI_ENDPOINT not set');
      e.code = 'AOAI_NOT_CONFIGURED';
      throw e;
    }
    // eslint-disable-next-line global-require
    const { createClient, chatCompletion } = require('../azure-openai-client');
    const client = (_createClient || createClient)();
    chatFn = (params) => chatCompletion(client, params, {
      model: process.env.AZURE_OPENAI_DEPLOYMENT_FULL || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1',
      logger: logger?.warn ? logger.warn.bind(logger) : undefined,
    });
  }

  if (logger?.info) logger.info(`[propose] calling AOAI for bank=${bankCode}, variant=${variant}, candidates_payload_chars=${user.length}`);
  const response = await chatFn({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
  });

  const raw = response?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('proposeTemplate: AOAI response missing message content');

  const proposal = parseProposeResponse(raw);
  return { proposal, prompt: { system, user }, raw_response: raw };
}

module.exports = {
  buildProposePrompt,
  parseProposeResponse,
  proposeTemplate,
  PROMPT_PATH,
  _internal: { validateColumnMap, VALID_FIELDS },
};
