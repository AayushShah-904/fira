/**
 * Streaming parser for `claude -p --output-format stream-json --verbose` output.
 *
 * The CLI emits one JSON object per line on stdout:
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","message":{"content":[{"type":"text"|"tool_use",...}],...}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...",...}]}}
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed"|...}}
 *   {"type":"result","duration_ms":...,"duration_api_ms":...,"total_cost_usd":...,"usage":{...}}
 *
 * This parser consumes bytes incrementally, buffering partial lines, and
 * builds a running structured summary of what the agent did: tool calls
 * (count, duration, errors), token usage, cost, final text, rate-limit
 * states, and reasoning turns.
 *
 * Use:
 *   const { createTraceParser } = require("./utils/trace-parser");
 *   const parser = createTraceParser();
 *   claude.stdout.on("data", (chunk) => parser.feed(chunk));
 *   claude.on("close", () => {
 *     const summary = parser.getSummary();
 *     fs.writeFileSync("trace.jsonl", parser.getRawEvents().map(JSON.stringify).join("\n"));
 *   });
 */

/** @typedef {{name: string, id: string, startedAtMs: number, endedAtMs?: number, durationMs?: number, inputPreview?: string, isError?: boolean, resultPreview?: string}} ToolCallRecord */

function createTraceParser() {
  let buffer = "";
  const rawEvents = [];

  const state = {
    sessionId: null,
    model: null,
    startedAtMs: null,
    endedAtMs: null,

    // Result event fields (populated when we see it)
    durationMs: null,
    durationApiMs: null,
    numTurns: null,
    totalCostUsd: null,
    stopReason: null,
    terminalReason: null,
    isError: false,

    // Accumulated from the final `result.usage` event
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,

    // Tool calls indexed by tool_use_id while open; moved to .tools on close
    _openTools: new Map(),
    tools: /** @type {ToolCallRecord[]} */ ([]),

    // Rate-limit snapshots, filtered to non-"allowed" entries
    rateLimitEvents: [],

    // Per-turn usage samples (from assistant messages)
    turnUsages: [],

    // Final text response from the agent (from the `result.result` field)
    finalText: "",

    // Number of stream parse errors (truncated/bad lines)
    parseErrors: 0,
  };

  function now() {
    return Date.now();
  }

  /**
   * Process a single parsed JSON event.
   */
  function handleEvent(ev) {
    if (!ev || typeof ev !== "object") return;
    rawEvents.push(ev);

    const type = ev.type;
    const t = now();

    if (state.startedAtMs == null) state.startedAtMs = t;

    if (type === "system" && ev.subtype === "init") {
      state.sessionId = ev.session_id || null;
      state.model = ev.model || null;
      return;
    }

    if (type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
      // Capture per-turn token usage so we can graph usage growth
      if (ev.message.usage) {
        state.turnUsages.push({
          at: t,
          input_tokens: ev.message.usage.input_tokens || 0,
          output_tokens: ev.message.usage.output_tokens || 0,
          cache_creation_input_tokens: ev.message.usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: ev.message.usage.cache_read_input_tokens || 0,
        });
      }

      // Open any tool_use blocks
      for (const block of ev.message.content) {
        if (block && block.type === "tool_use") {
          const id = block.id || `unknown-${state.tools.length}`;
          const name = block.name || "unknown";
          let inputPreview = "";
          try {
            inputPreview = JSON.stringify(block.input || {}).slice(0, 400);
          } catch {
            inputPreview = String(block.input).slice(0, 400);
          }
          state._openTools.set(id, {
            name,
            id,
            startedAtMs: t,
            inputPreview,
          });
        }
      }
      return;
    }

    if (type === "user" && ev.message && Array.isArray(ev.message.content)) {
      // Close matching tool_use blocks
      for (const block of ev.message.content) {
        if (block && block.type === "tool_result") {
          const id = block.tool_use_id;
          if (!id) continue;
          const open = state._openTools.get(id);
          if (!open) continue;
          const durationMs = t - open.startedAtMs;
          const isError = block.is_error === true;
          // Tool result content can be string or array of content blocks
          let resultPreview = "";
          try {
            if (typeof block.content === "string") {
              resultPreview = block.content.slice(0, 300);
            } else if (Array.isArray(block.content)) {
              const textPart = block.content.find((c) => c && c.type === "text");
              resultPreview = textPart ? String(textPart.text || "").slice(0, 300) : "";
            }
          } catch {}
          state.tools.push({
            ...open,
            endedAtMs: t,
            durationMs,
            isError,
            resultPreview,
          });
          state._openTools.delete(id);
        }
      }
      return;
    }

    if (type === "rate_limit_event") {
      const info = ev.rate_limit_info || {};
      if (info.status && info.status !== "allowed") {
        state.rateLimitEvents.push({
          at: t,
          status: info.status,
          rate_limit_type: info.rateLimitType,
          resets_at: info.resetsAt,
          overage_status: info.overageStatus,
        });
      }
      return;
    }

    if (type === "result") {
      state.endedAtMs = t;
      state.durationMs = ev.duration_ms ?? null;
      state.durationApiMs = ev.duration_api_ms ?? null;
      state.numTurns = ev.num_turns ?? null;
      state.totalCostUsd = ev.total_cost_usd ?? null;
      state.stopReason = ev.stop_reason ?? null;
      state.terminalReason = ev.terminal_reason ?? null;
      state.isError = ev.is_error === true;
      state.finalText = typeof ev.result === "string" ? ev.result : "";

      const usage = ev.usage || {};
      state.inputTokens = usage.input_tokens || 0;
      state.outputTokens = usage.output_tokens || 0;
      state.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      state.cacheReadTokens = usage.cache_read_input_tokens || 0;
      if (usage.server_tool_use) {
        state.webSearchRequests = usage.server_tool_use.web_search_requests || 0;
      }
      return;
    }
  }

  /**
   * Feed a chunk of stdout (Buffer or string). Splits on newlines, parses
   * each complete line as JSON, buffers the trailing partial line.
   */
  function feed(chunk) {
    buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        handleEvent(ev);
      } catch {
        state.parseErrors++;
      }
    }
  }

  /**
   * Flush any trailing buffered content that didn't end in a newline.
   * Called once after the child process closes.
   */
  function end() {
    const tail = buffer.trim();
    buffer = "";
    if (!tail) return;
    try {
      handleEvent(JSON.parse(tail));
    } catch {
      state.parseErrors++;
    }
  }

  /**
   * Build an aggregate summary object suitable for logging or JSON export.
   */
  function getSummary() {
    // Per-tool timings
    const toolStats = {};
    let totalToolMs = 0;
    for (const t of state.tools) {
      const k = t.name || "unknown";
      if (!toolStats[k]) {
        toolStats[k] = { count: 0, totalMs: 0, errors: 0 };
      }
      toolStats[k].count++;
      toolStats[k].totalMs += t.durationMs || 0;
      if (t.isError) toolStats[k].errors++;
      totalToolMs += t.durationMs || 0;
    }

    // Any tool calls that never got a result (child died mid-call)
    const orphanedTools = [];
    for (const [id, open] of state._openTools.entries()) {
      orphanedTools.push({ ...open, id });
    }

    const wallClockMs =
      state.durationMs != null
        ? state.durationMs
        : state.endedAtMs != null && state.startedAtMs != null
          ? state.endedAtMs - state.startedAtMs
          : null;

    // In Claude Code's architecture, tool time is *inside* API time (the LLM
    // waits synchronously on tool results as part of its API turn). So:
    //   wall_clock  = api_time + node_overhead (startup/teardown, non-API)
    //   api_time    = llm_thinking_ms + total_tool_ms
    //   llm_thinking_ms = api_time - total_tool_ms
    const llmThinkingMs = state.durationApiMs != null
      ? Math.max(0, state.durationApiMs - totalToolMs)
      : null;
    const nodeOverheadMs = wallClockMs != null && state.durationApiMs != null
      ? Math.max(0, wallClockMs - state.durationApiMs)
      : null;

    return {
      session_id: state.sessionId,
      model: state.model,
      wall_clock_ms: wallClockMs,
      duration_api_ms: state.durationApiMs,
      total_tool_ms: totalToolMs,
      llm_thinking_ms: llmThinkingMs,
      node_overhead_ms: nodeOverheadMs,
      num_turns: state.numTurns,
      tool_call_count: state.tools.length,
      tool_stats: toolStats,
      orphaned_tool_calls: orphanedTools.length,
      tokens: {
        input: state.inputTokens,
        output: state.outputTokens,
        cache_creation: state.cacheCreationTokens,
        cache_read: state.cacheReadTokens,
      },
      web_search_requests: state.webSearchRequests,
      total_cost_usd: state.totalCostUsd,
      stop_reason: state.stopReason,
      terminal_reason: state.terminalReason,
      is_error: state.isError,
      rate_limit_events: state.rateLimitEvents,
      parse_errors: state.parseErrors,
    };
  }

  /** Return the raw parsed events (for writing to trace.jsonl). */
  function getRawEvents() {
    return rawEvents;
  }

  /** Return the agent's final text response (from result.result). */
  function getFinalText() {
    return state.finalText;
  }

  /** Return closed tool-call records (each with durationMs, isError, previews). */
  function getToolCalls() {
    return [...state.tools];
  }

  return {
    feed,
    end,
    getSummary,
    getRawEvents,
    getFinalText,
    getToolCalls,
  };
}

/**
 * Format a summary object into human-readable lines suitable for a log file.
 * Returns an array of strings, one per line.
 */
function formatSummaryLines(summary) {
  const lines = [];
  const fmtMs = (ms) =>
    ms == null ? "?" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const fmtUsd = (u) => (u == null ? "?" : `$${u.toFixed(4)}`);

  lines.push(`Wall clock:   ${fmtMs(summary.wall_clock_ms)}`);
  if (summary.node_overhead_ms != null) {
    lines.push(`  Node setup: ${fmtMs(summary.node_overhead_ms)}  (wall - api)`);
  }
  if (summary.duration_api_ms != null) {
    lines.push(`  API time:   ${fmtMs(summary.duration_api_ms)}`);
  }
  if (summary.llm_thinking_ms != null) {
    lines.push(`    thinking: ${fmtMs(summary.llm_thinking_ms)}  (api - tools)`);
  }
  if (summary.total_tool_ms != null) {
    lines.push(`    tool wait: ${fmtMs(summary.total_tool_ms)}`);
  }
  if (summary.num_turns != null) {
    lines.push(`Turns:        ${summary.num_turns}`);
  }
  lines.push(`Tool calls:   ${summary.tool_call_count}`);
  const toolNames = Object.keys(summary.tool_stats || {}).sort();
  for (const name of toolNames) {
    const s = summary.tool_stats[name];
    const errSuffix = s.errors > 0 ? ` (${s.errors} err)` : "";
    lines.push(`  ${name.padEnd(12)} ${String(s.count).padStart(3)}x  ${fmtMs(s.totalMs).padStart(8)}${errSuffix}`);
  }
  if (summary.orphaned_tool_calls > 0) {
    lines.push(`  Orphaned:   ${summary.orphaned_tool_calls} (child died mid-call)`);
  }
  const tk = summary.tokens || {};
  lines.push(`Tokens:       in=${tk.input || 0} out=${tk.output || 0} cache_create=${tk.cache_creation || 0} cache_read=${tk.cache_read || 0}`);
  if (summary.web_search_requests > 0) {
    lines.push(`Web searches: ${summary.web_search_requests}`);
  }
  lines.push(`Cost:         ${fmtUsd(summary.total_cost_usd)}`);
  if (summary.stop_reason) {
    lines.push(`Stop reason:  ${summary.stop_reason}`);
  }
  if (summary.terminal_reason && summary.terminal_reason !== "completed") {
    lines.push(`Terminal:     ${summary.terminal_reason}`);
  }
  if (summary.is_error) {
    lines.push(`Error:        yes`);
  }
  if (summary.rate_limit_events && summary.rate_limit_events.length > 0) {
    lines.push(`Rate limit:   ${summary.rate_limit_events.length} non-allowed event(s)`);
    for (const rl of summary.rate_limit_events) {
      lines.push(`  - status=${rl.status} type=${rl.rate_limit_type}`);
    }
  }
  if (summary.parse_errors > 0) {
    lines.push(`Parse errors: ${summary.parse_errors} (stream lines that failed JSON.parse)`);
  }

  return lines;
}

module.exports = { createTraceParser, formatSummaryLines };
