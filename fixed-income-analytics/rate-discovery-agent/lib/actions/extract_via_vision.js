'use strict';

/**
 * Action: extract_via_vision — Sprint 003 A5 contract.
 *
 * Vision-based rate extraction for image-only rate cards or scanned PDFs
 * rendered as images. Sends the image URL to Azure OpenAI's chat-completions
 * endpoint with a vision-capable model (gpt-4.1 or newer) and a focused
 * extraction prompt; receives structured slabs back as JSON.
 *
 * Q9: emits `extraction_method: "vision_model"` (NOT "automatic_vision").
 *
 * Requirements:
 *   - AZURE_OPENAI_ENDPOINT (and either AZURE_OPENAI_API_KEY or managed
 *     identity) must be configured.
 *   - The model named in AZURE_OPENAI_VISION_DEPLOYMENT (or AZURE_OPENAI_DEPLOYMENT
 *     as fallback) must support vision (gpt-4.1, etc.).
 *
 * Calibration fixtures from sub-agents.md B3 (not exercised by unit tests;
 * those need live AOAI access):
 *   - output/latest/angul-united-central-co-operative-bank-ltd_rates.json
 *     (12 slabs, operator-transcribed) — vision should produce ≥ 11 of 12.
 *   - Banswara page 8 (21-07-2023 circular) — ≥ 10 correctly.
 *
 * Input:
 *   { url: string, product_type?: string, variant?: string, hints?: { expected_currencies? }, logger? }
 *
 * Output (success):
 *   { ok: true, slabs: [...], effective_date?, warnings: [...],
 *     extraction_method: "vision_model", path_used: "deterministic",
 *     product_type, variant, raw_response? }
 *
 * Output (failure):
 *   null  (per CLAUDE.md; caller writes empty rate_slabs).
 */

const VALID_VARIANTS = new Set(['regular', 'nre', 'nro', 'fcnr', 'gift']);
const CURRENCY_VARIANTS = new Set(['fcnr', 'gift']);

/**
 * Focused extraction prompt. Designed to be short, schema-explicit, and
 * resistant to chatty model behavior. The model is asked to return raw JSON
 * — no markdown fences, no commentary.
 */
function buildPrompt(variant, hints) {
  const currencyClause = CURRENCY_VARIANTS.has(variant)
    ? `Each slab MUST include a "currency" field (e.g., "USD", "GBP", "EUR", "JPY", "CAD", "AUD"). If a single tenure shows multiple currencies, emit one slab per (tenure, currency).`
    : `Slabs are INR-denominated; do NOT include a "currency" field.`;
  const seniorClause = CURRENCY_VARIANTS.has(variant)
    ? `FCNR/GIFT slabs have NO senior or super-senior premium — leave "rate_senior_pct" and "rate_super_senior_pct" as null.`
    : `Include "rate_senior_pct" and "rate_super_senior_pct" if the rate card shows separate columns; otherwise leave them null.`;
  const expected = Array.isArray(hints?.expected_currencies) && hints.expected_currencies.length > 0
    ? `\nExpected currencies for this page (in priority order): ${hints.expected_currencies.join(', ')}.`
    : '';

  // Bank-context preface (added 2026-05-17 — see same change in extract_html_table.js).
  // Anonymous prompts let the model confuse footnote/example tables for rate data;
  // identifying the bank up front grounds extraction.
  const contextLines = [];
  if (hints?.bank_name) contextLines.push(`Bank Name: ${hints.bank_name}`);
  if (hints?.bank_type) contextLines.push(`Bank Type: ${hints.bank_type}`);
  if (hints?.category)  contextLines.push(`Category: ${hints.category}`);
  if (hints?.state)     contextLines.push(`State: ${hints.state}`);
  if (hints?.cached_notes && typeof hints.cached_notes === 'string') {
    contextLines.push(`Prior-run notes: ${hints.cached_notes.slice(0, 400)}`);
  }
  const contextPreface = contextLines.length ? `${contextLines.join('\n')}\n\n` : '';

  return [
    `${contextPreface}You are extracting rate-slab data from an image of a bank's deposit rate card.`,
    ``,
    `Variant: ${variant} (${CURRENCY_VARIANTS.has(variant) ? 'FD foreign-currency' : 'FD INR'}).`,
    ``,
    `Return ONLY a JSON object with this shape (no prose, no markdown):`,
    `{`,
    `  "effective_date": "ISO-8601 date or null if not visible",`,
    `  "rate_slabs": [`,
    `    {`,
    `      "tenure_text": "verbatim from the card (e.g., '7 days to 14 days')",`,
    `      "tenure_min_days": number or null,`,
    `      "tenure_max_days": number or null,`,
    `      "rate_general_pct": number,`,
    `      "rate_senior_pct": number or null,`,
    `      "rate_super_senior_pct": number or null${CURRENCY_VARIANTS.has(variant) ? ',\n      "currency": "USD" | "GBP" | "EUR" | ...' : ''}`,
    `    }`,
    `  ],`,
    `  "warnings": ["any concerns about legibility / ambiguity"]`,
    `}`,
    ``,
    currencyClause,
    seniorClause,
    expected,
    `If the image is unreadable or contains no rate table for the requested variant, return {"rate_slabs": [], "warnings": ["why"]}.`,
  ].filter(Boolean).join('\n');
}

async function extractViaVision(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('extractViaVision: input must be an object');
  }
  const { url, product_type, variant, hints, logger } = input;
  if (!url || typeof url !== 'string') throw new Error('extractViaVision: input.url is required');
  const v = variant || 'regular';
  if (!VALID_VARIANTS.has(v)) {
    throw new Error(`extractViaVision: unsupported variant "${v}"`);
  }

  if (!process.env.AZURE_OPENAI_ENDPOINT) {
    if (logger?.warn) logger.warn('extract_via_vision: AZURE_OPENAI_ENDPOINT not set; skipping');
    return null;
  }

  const { createClient, chatCompletion } = require('../azure-openai-client');
  const client = createClient();
  // Vision needs a vision-capable model — prefer explicit VISION override,
  // then FULL (gpt-4.1 supports vision), then generic DEPLOYMENT, then a
  // hard-coded fallback. MINI is NOT in this list — gpt-4.1-mini does not
  // support image inputs.
  const deployment = process.env.AZURE_OPENAI_VISION_DEPLOYMENT
    || process.env.AZURE_OPENAI_DEPLOYMENT_FULL
    || process.env.AZURE_OPENAI_DEPLOYMENT
    || 'gpt-4.1';

  const prompt = buildPrompt(v, hints);

  let response;
  try {
    response = await chatCompletion(client, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }, { model: deployment, logger: logger?.warn ? logger.warn.bind(logger) : undefined });
  } catch (err) {
    if (logger?.warn) logger.warn(`extract_via_vision: AOAI call failed: ${err.message}`);
    return null;
  }

  const text = response?.choices?.[0]?.message?.content || '';
  if (!text) {
    if (logger?.warn) logger.warn('extract_via_vision: empty response from model');
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (logger?.warn) logger.warn(`extract_via_vision: model returned non-JSON: ${err.message}`);
    return null;
  }

  const slabs = Array.isArray(parsed.rate_slabs) ? parsed.rate_slabs : [];
  if (slabs.length === 0) {
    if (logger?.warn) logger.warn(`extract_via_vision: zero slabs returned${parsed.warnings ? ` (${parsed.warnings.join('; ')})` : ''}`);
    return null;
  }

  // Enforce currency presence for fcnr/gift; emit a warning if any slab lacks it.
  const warnings = Array.isArray(parsed.warnings) ? [...parsed.warnings] : [];
  if (CURRENCY_VARIANTS.has(v)) {
    const missingCurrency = slabs.filter((s) => !s.currency);
    if (missingCurrency.length > 0) {
      const fallback = (hints?.expected_currencies && hints.expected_currencies[0]) || 'USD';
      for (const s of slabs) if (!s.currency) s.currency = fallback;
      warnings.push(`currency_fallback: ${missingCurrency.length} ${v} slabs lacked currency; defaulted to "${fallback}"`);
    }
  }

  return {
    ok: true,
    slabs,
    effective_date: parsed.effective_date || null,
    warnings,
    extraction_method: 'vision_model',
    path_used: 'deterministic', // contract field; the vision model IS the extractor — no separate LLM-fallback step here
    product_type: product_type || 'FD',
    variant: v,
    raw_response: text,
    llm_usages: response?.usage
      ? [{ model: deployment, usage: response.usage, action: 'extract_via_vision', variant: v }]
      : undefined,
  };
}

module.exports = { extractViaVision, _buildPrompt: buildPrompt };
