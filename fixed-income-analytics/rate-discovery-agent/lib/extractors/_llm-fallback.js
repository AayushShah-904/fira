'use strict';

/**
 * LLM-fallback extractor — last-resort dispatcher path.
 *
 * Sprint 006 Step 3d (un-deferred from Sprint 7 per operator 2026-05-24).
 * Real AOAI integration replaces the Step 3a stub.
 *
 * Flow:
 *   1. Extract candidate table chunks from rendered HTML
 *   2. Per chunk: build focused prompt + call AOAI + parse JSON response
 *   3. Anti-fabrication post-process: validate every slab's source_row_text
 *      appears verbatim in the chunk's text (drops fabricated slabs)
 *   4. Dedupe across chunks
 *   5. Return slabs + diagnostics including which chunks fired the LLM
 *
 * Lifts the LLM scaffolding from lib/actions/extract_html_table.js via its
 * new exports (buildHtmlExtractionPrompt, callLlmOnChunk, validateSlabAgainstChunk,
 * dedupSlabs, extractTableChunksReExport). This is the "lift without moving"
 * pattern: extract_html_table.js remains the canonical home until Sprint 7
 * retires it; the dispatcher path calls those functions via this module.
 *
 * Design: ../../sdlc/sprints/sprint-006/design/extract-html-table-split.md
 *         (un-deferral note: real AOAI lands in Sprint 6 per operator 2026-05-24)
 */

const cheerio = require('cheerio');

module.exports = {
  template_id: '_llm-fallback',
  applies_to: {
    kinds: ['html_static', 'html_js'],
  },
  extract,
};

/**
 * @param {object} ctx
 * @param {string} [ctx.html]
 * @param {object} [ctx.productContext]   { bank_code, bank_type, variant, bank_name, category, state, expected_slab_count, ... }
 * @param {object} [ctx.templateExtract]  { expected_currencies? }
 * @param {object} [ctx.logger]
 * @param {object} [ctx._llmClient]       Test injection — full client object
 * @param {function} [ctx._chatOverride]  Test injection — replaces chatCompletion
 */
async function extract(ctx) {
  const { html, productContext = {}, templateExtract = {}, logger, _llmClient, _chatOverride } = ctx || {};
  if (!html || typeof html !== 'string') {
    return emptyResult('html input missing or non-string', productContext);
  }

  // Lazy-require so unit tests that don't exercise AOAI don't pay the import cost
  // eslint-disable-next-line global-require
  const upstream = require('../actions/extract_html_table');
  const {
    buildHtmlExtractionPrompt,
    callLlmOnChunk,
    validateSlabAgainstChunk,
    dedupSlabs,
    extractTableChunksReExport: extractTableChunks,
    _filterChunksForCurrencyVariant: filterChunksForCurrencyVariant,
  } = upstream;

  const variant = productContext.variant || 'regular';
  const expectedCurrencies = templateExtract.expected_currencies
    || (variant === 'fcnr' || variant === 'gift' ? ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD'] : []);

  // 1. Candidate chunks
  let chunks = extractTableChunks(html, { maxChunkChars: 30000 });
  if (chunks.length === 0) {
    return emptyResult('no rate-bearing <table> chunks found', productContext);
  }

  // 1b. Currency-aware chunk selection for fcnr/gift (sprint-011 Fix A —
  // same consolidated-page bug as extractViaLlmFromHtml: without this the
  // LLM latches onto the dominant INR table and missing_currency_multi
  // rejects the result after a wasted LLM call).
  const currencyFilter = filterChunksForCurrencyVariant(chunks, variant, expectedCurrencies);
  if (currencyFilter.filtered) {
    if (currencyFilter.rejected) {
      return emptyResult(currencyFilter.reason, productContext);
    }
    if (logger && logger.debug) {
      logger.debug(`_llm-fallback: variant=${variant} currency-aware chunk filter kept ${currencyFilter.chunks.length}/${chunks.length} chunks (distinct-currency counts: ${currencyFilter.counts.join(',')})`);
    }
    chunks = currencyFilter.chunks;
  }

  // 2. Build prompt (variant + currency context + bank metadata grounding)
  const prompt = buildHtmlExtractionPrompt(variant, expectedCurrencies, {
    bank_name: productContext.bank_name,
    bank_type: productContext.bank_type,
    category: productContext.category,
    state: productContext.state,
    expected_slab_count: productContext.expected_slab_count,
    scraper_notes: productContext.scraper_notes,
    url: productContext.url,
  });

  // 3. Acquire client
  const client = _llmClient || acquireClient(_chatOverride);
  if (!client) {
    return emptyResult('AOAI not configured (AZURE_OPENAI_ENDPOINT missing) — set env or use --no-llm', productContext);
  }
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_FULL
    || process.env.AZURE_OPENAI_DEPLOYMENT
    || 'gpt-4.1';

  // 4. Per-chunk LLM call + anti-fabrication validation
  const allSlabs = [];
  const llmUsages = [];
  const warnings = [];
  const errors = [];
  let effectiveDate = null;
  let chunksWithSlabs = 0;
  let chunkIdx = 0;

  for (const chunk of chunks) {
    chunkIdx++;
    let llmOutput;
    try {
      llmOutput = await callLlmOnChunk({
        client, deployment, prompt, chunk,
        chunkIndex: chunkIdx, chunkCount: chunks.length, logger,
      });
    } catch (err) {
      warnings.push(`llm_chunk[${chunkIdx}] threw: ${err.message}`);
      continue;
    }
    if (!llmOutput) {
      warnings.push(`llm_chunk[${chunkIdx}] returned null (call failed or empty response)`);
      continue;
    }
    if (llmOutput.usage) llmUsages.push({ chunk_index: chunkIdx, ...llmOutput.usage });
    if (!effectiveDate && llmOutput.effective_date) effectiveDate = llmOutput.effective_date;
    for (const w of llmOutput.warnings) warnings.push(`llm_chunk[${chunkIdx}]: ${w}`);
    for (const e of llmOutput.errors) errors.push(`llm_chunk[${chunkIdx}]: ${e}`);

    // 5. Anti-fabrication post-processor
    const chunkText = chunkPlainText(chunk);
    const kept = [];
    let droppedFabricated = 0;
    for (const slab of llmOutput.slabs) {
      const check = validateSlabAgainstChunk(slab, chunkText, chunk);
      if (check.ok) {
        kept.push(slab);
      } else {
        droppedFabricated++;
      }
    }
    if (droppedFabricated > 0) {
      warnings.push(`llm_chunk[${chunkIdx}] anti_fabrication: dropped ${droppedFabricated} slab(s) whose source_row_text did not appear in chunk text`);
    }
    if (kept.length > 0) chunksWithSlabs++;
    for (const slab of kept) allSlabs.push(slab);
  }

  // 6. Dedupe across chunks
  const deduped = dedupSlabs(allSlabs);
  const dedupedDropped = allSlabs.length - deduped.length;
  if (dedupedDropped > 0) warnings.push(`dedupe: dropped ${dedupedDropped} duplicate slab(s) across chunks`);

  return {
    slabs: deduped,
    effective_date: effectiveDate,
    warnings: ['llm_fallback: extracted via LLM path (Sprint 6 Step 3d wired)', ...warnings],
    errors,
    diagnostics: {
      extractor_kind: 'llm_fallback_aoai',
      chunks_seen: chunks.length,
      chunks_with_slabs: chunksWithSlabs,
      slabs_before_dedupe: allSlabs.length,
      slabs_after_dedupe: deduped.length,
      llm_usages: llmUsages,
      bank_code: productContext.bank_code || null,
      variant,
    },
  };
}

function chunkPlainText(chunk) {
  if (!chunk || !chunk.tableHtml) return '';
  try {
    const $ = cheerio.load(`<root>${chunk.contextHtml || ''}${chunk.tableHtml}</root>`);
    return $('root').text().replace(/\s+/g, ' ').trim();
  } catch {
    return String(chunk.tableHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function acquireClient(_chatOverride) {
  if (_chatOverride) {
    return { chat: { completions: { create: _chatOverride } } };
  }
  if (!process.env.AZURE_OPENAI_ENDPOINT) return null;
  try {
    // eslint-disable-next-line global-require
    const { createClient } = require('../azure-openai-client');
    return createClient();
  } catch {
    return null;
  }
}

function emptyResult(warning, productContext) {
  return {
    slabs: [],
    effective_date: null,
    warnings: [`llm_fallback: ${warning}`],
    errors: [],
    diagnostics: {
      extractor_kind: 'llm_fallback_aoai',
      chunks_seen: 0,
      chunks_with_slabs: 0,
      slabs_before_dedupe: 0,
      slabs_after_dedupe: 0,
      llm_usages: [],
      bank_code: (productContext && productContext.bank_code) || null,
    },
  };
}
