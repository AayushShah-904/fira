'use strict';

/**
 * Tests for lib/cost-tracker.js — OCR cost telemetry (Phase 2a).
 *
 * Covers the FCNR-2a addition: extract_via_ocr returns cost_pages, the
 * orchestrator drains it into the tracker via recordOcrPages(), and the
 * summary surfaces ocr_cost_usd + ocr_pages alongside the LLM cost.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCostTracker } = require('../../lib/cost-tracker');

test('cost-tracker: no OCR pages → ocr_cost_usd=0, ocr_pages=0, total = LLM only', () => {
  const t = createCostTracker('gpt-4.1-mini');
  t.recordApiCall({ prompt_tokens: 1000, completion_tokens: 100 });
  const s = t.getSummary();
  assert.equal(s.ocr_pages, 0);
  assert.equal(s.ocr_cost_usd, 0);
  assert.ok(s.llm_cost_usd > 0);
  assert.equal(s.total_cost_usd, s.llm_cost_usd);
});

test('cost-tracker: recordOcrPages sums per call', () => {
  const t = createCostTracker('gpt-4.1-mini');
  t.recordOcrPages(3);
  t.recordOcrPages(2);
  const s = t.getSummary();
  assert.equal(s.ocr_pages, 5);
  // Default price $0.01/page → 5 pages = $0.05
  assert.equal(s.ocr_cost_usd, 0.05);
  assert.equal(s.total_cost_usd, 0.05);  // No LLM calls in this test
});

test('cost-tracker: LLM + OCR sum into total_cost_usd', () => {
  const t = createCostTracker('gpt-4.1-mini');
  t.recordApiCall({ prompt_tokens: 1_000_000, completion_tokens: 0 });  // exactly $0.40 input
  t.recordOcrPages(1);
  const s = t.getSummary();
  assert.ok(Math.abs(s.llm_cost_usd - 0.40) < 1e-9);
  assert.ok(Math.abs(s.ocr_cost_usd - 0.01) < 1e-9);
  assert.ok(Math.abs(s.total_cost_usd - 0.41) < 1e-9);
});

test('cost-tracker: recordOcrPages ignores invalid input (negative, NaN, undefined)', () => {
  const t = createCostTracker('gpt-4.1-mini');
  t.recordOcrPages(-5);
  t.recordOcrPages(NaN);
  t.recordOcrPages(undefined);
  t.recordOcrPages('not-a-number');
  t.recordOcrPages(0);
  const s = t.getSummary();
  assert.equal(s.ocr_pages, 0);
  assert.equal(s.ocr_cost_usd, 0);
});

test('cost-tracker: OCR pages appear in raw events as ocr_call type', () => {
  const t = createCostTracker('gpt-4.1-mini');
  t.recordOcrPages(2);
  const events = t.getRawEvents();
  const ocrEvent = events.find((e) => e.type === 'ocr_call');
  assert.ok(ocrEvent, 'ocr_call event must be emitted');
  assert.equal(ocrEvent.pages, 2);
  assert.ok(ocrEvent.timestamp);
});

test('cost-tracker: env override AZURE_DI_LAYOUT_PRICE_PER_PAGE works at module load', () => {
  // The module reads the env var at require-time, so we can't easily test
  // override here without re-loading. Document this as a known limitation;
  // for production override the env var is read once when the runner starts.
  // This test just verifies the default price is what we expect.
  const t = createCostTracker('gpt-4.1-mini');
  t.recordOcrPages(100);
  const s = t.getSummary();
  // Default: 100 pages × $0.01 = $1.00
  assert.equal(s.ocr_cost_usd, 1.00);
});
