/**
 * Token and cost tracker for Azure OpenAI agent runs.
 *
 * Supports two-tier pricing: pass the model name to createCostTracker()
 * and it picks the right per-token prices from env vars.
 *
 * Mirrors the trace-parser.js API so run-discovery.js post-processing
 * can switch from Claude CLI tracing to this with minimal changes.
 */

/** Resolve per-token pricing for a given model deployment name. */
function resolvePricing(model) {
  const m = (model || "").toLowerCase();
  const isMini = m.includes("mini");

  if (isMini) {
    return {
      inputPricePer1M: parseFloat(process.env.AZURE_OPENAI_MINI_INPUT_PRICE_PER_1M || "0.40"),
      outputPricePer1M: parseFloat(process.env.AZURE_OPENAI_MINI_OUTPUT_PRICE_PER_1M || "1.60"),
    };
  }
  return {
    inputPricePer1M: parseFloat(process.env.AZURE_OPENAI_FULL_INPUT_PRICE_PER_1M || "2.00"),
    outputPricePer1M: parseFloat(process.env.AZURE_OPENAI_FULL_OUTPUT_PRICE_PER_1M || "8.00"),
  };
}

/**
 * Create a cost tracker instance.
 * @param {string} [model] - Model deployment name (for pricing lookup). Can be updated later via setModel().
 * @returns {object} Tracker with recordApiCall, recordToolCall, getSummary, etc.
 */
// Azure Document Intelligence Layout S0 tier pricing — $10 per 1000 pages.
// Phase 2a (sprint-004 2026-05-22) — pre-flight for pm-q2 re-run. Surfaced
// as a separate cost line so operator can see DI spend per cohort.
const OCR_PRICE_PER_PAGE = parseFloat(
  process.env.AZURE_DI_LAYOUT_PRICE_PER_PAGE || "0.01"
);

function createCostTracker(model) {
  const startMs = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let apiCallCount = 0;
  let ocrPages = 0;
  const toolCalls = [];
  const rawEvents = [];
  let finalText = "";
  let currentModel = model || process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1";

  return {
    /** Update the model (e.g., after tier escalation). Recalculates cost on next getSummary(). */
    setModel(m) {
      currentModel = m;
    },

    /** Record token usage from an API response. */
    recordApiCall(usage) {
      if (!usage) return;
      apiCallCount++;
      inputTokens += usage.prompt_tokens || 0;
      outputTokens += usage.completion_tokens || 0;
      rawEvents.push({
        type: "api_call",
        timestamp: new Date().toISOString(),
        model: currentModel,
        usage: {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
        },
      });
    },

    /** Record a tool execution. */
    recordToolCall(name, durationMs, isError, inputPreview, resultPreview) {
      const record = {
        name,
        durationMs,
        isError: !!isError,
        inputPreview: (inputPreview || "").slice(0, 200),
        resultPreview: (resultPreview || "").slice(0, 300),
      };
      toolCalls.push(record);
      rawEvents.push({
        type: "tool_call",
        timestamp: new Date().toISOString(),
        ...record,
      });
    },

    /**
     * Record Azure Document Intelligence Layout pages consumed by an OCR-
     * routed extraction. Each extract_via_ocr action returns `cost_pages`
     * in its result; the orchestrator drains it through here so the
     * per-bank summary can show OCR spend separately from LLM spend.
     */
    recordOcrPages(pages) {
      const n = Number(pages);
      if (!Number.isFinite(n) || n <= 0) return;
      ocrPages += n;
      rawEvents.push({
        type: "ocr_call",
        timestamp: new Date().toISOString(),
        pages: n,
      });
    },

    /** Set the model's final text response. */
    setFinalText(text) {
      finalText = text || "";
    },

    /** Get the model's final text response. */
    getFinalText() {
      return finalText;
    },

    /**
     * Get summary in the same shape as trace-parser's getSummary().
     * Consumed by run-pipeline.js and run-batch.js.
     */
    getSummary() {
      const wallClockMs = Date.now() - startMs;
      const totalToolMs = toolCalls.reduce((sum, t) => sum + (t.durationMs || 0), 0);
      const { inputPricePer1M, outputPricePer1M } = resolvePricing(currentModel);
      const llmCostUsd =
        (inputTokens * inputPricePer1M) / 1_000_000 +
        (outputTokens * outputPricePer1M) / 1_000_000;
      const ocrCostUsd = ocrPages * OCR_PRICE_PER_PAGE;
      const costUsd = llmCostUsd + ocrCostUsd;

      return {
        model: currentModel,
        wall_clock_ms: wallClockMs,
        duration_ms: wallClockMs,
        duration_api_ms: wallClockMs - totalToolMs,
        num_turns: apiCallCount,
        tool_call_count: toolCalls.length,
        total_cost_usd: costUsd,
        llm_cost_usd: llmCostUsd,
        ocr_cost_usd: ocrCostUsd,
        ocr_pages: ocrPages,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        is_error: false,
        rate_limit_events: [],
      };
    },

    /** Get tool call records (same shape as trace-parser). */
    getToolCalls() {
      return toolCalls.map((t) => ({
        name: t.name,
        durationMs: t.durationMs,
        isError: t.isError,
        inputPreview: t.inputPreview,
      }));
    },

    /** Get raw events for .trace.jsonl output. */
    getRawEvents() {
      return rawEvents;
    },
  };
}

module.exports = { createCostTracker };
