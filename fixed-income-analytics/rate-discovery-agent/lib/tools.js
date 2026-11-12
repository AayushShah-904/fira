/**
 * Tool definitions and implementations for the Azure OpenAI agent.
 *
 * Each tool has an OpenAI function-calling schema and a local implementation.
 * The agent loop calls executeTool(name, args, context) to dispatch.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
// M2.5 (sprint-004 2026-05-21): per-URL extraction-hint resolver shared
// with the orchestrator path (lib/actions/extract_pdf_table.js).
const { resolveExtractionHint } = require("./extraction-hint");
const http = require("http");
const { spawnSync } = require("child_process");

const { slugify: canonicalSlugify } = require("../scripts/utils/slugify");
const { safeWriteArtifact } = require("./safe-write");

/**
 * Map a per-bank artifact filename to a safe-write `kind`.
 *
 * Mirrors the helper in `lib/slug-guard.js` and `run-discovery.js` — the same
 * routing rule applied at every writer site so per-bank artifacts (config /
 * rates / summary) consistently flow through safe-write while
 * non-per-bank aggregator outputs (e.g., `_batch_results_*.json`,
 * `_run_analysis.json`, ad-hoc files) fall through to a direct write.
 *
 * Returns one of `'config' | 'rates' | 'summary' | null`. `null` means the
 * caller should NOT route through safeWriteArtifact (ADR-012 explicitly
 * excludes aggregator/batch outputs).
 */
function inferArtifactKind(filename) {
  if (filename.endsWith("_config.json")) return "config";
  if (filename.endsWith("_rates.json")) return "rates";
  if (filename.endsWith(".summary.json")) return "summary";
  return null;
}

// ── Tool Definitions (OpenAI function-calling schema) ──────────────

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web using Bing. Returns top results with title, URL, and snippet. Use for finding bank websites and rate pages.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch a web page via HTTP GET. Returns cleaned HTML with scripts/styles stripped, truncated to fit context. Use for static HTML pages. For JS-rendered pages, use run_playwright instead.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the local filesystem. Path is relative to the project root.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "File path (relative to project root)" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file. Path must be within the output directory. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "File path (must be within the output directory)" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_playwright",
      description:
        "Fetch a page using headless Playwright/Chromium. Use this IMMEDIATELY when fetch_url returns HTTP 403/429 (bot protection) or empty HTML (JS-rendered page). This is the fallback for WAF/Cloudflare/reCAPTCHA-protected sites and React/Angular/Vue apps. Returns rendered HTML tables as JSON. Try this before classifying any bank as manual. When data/bank-domains.json has `extraction.<rate_page_key>` hints for this bank+URL, the tool automatically applies them (wait_for_selector / click_to_reveal / extract_selector / tab_selector) — you don't need to read or pass them manually.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to render" },
          scroll: { type: "boolean", description: "Scroll to bottom to trigger lazy-loaded content" },
          tabs: { type: "boolean", description: "Click tab elements and extract per-tab data" },
          accordions: { type: "boolean", description: "Expand all accordion/collapsible sections before extracting" },
          selects: { type: "boolean", description: "Iterate <select> dropdown options" },
          intercept: { type: "boolean", description: "Monitor XHR/fetch for JSON rate data" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "slugify",
      description:
        "Convert a full bank (or entity) name into the canonical slug used as bank_code throughout the system. Always use this when you need a slug derived from a name — do NOT compose the slug manually. Returns the exact value the orchestrator expects in filenames and JSON `bank_code` fields. The slug for the CURRENT bank is already provided in the prompt, but use this tool when you encounter another bank's name (e.g., a parent bank for an IBU, or a redirect target).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full bank or entity name as it appears in the master list (do not abbreviate)." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_pdf",
      description:
        "Download a PDF file and extract its text content. Use this when fetch_url or run_playwright report a PDF URL. Returns the extracted text with table-like content preserved. Works for bank rate card PDFs. Optionally pass `referer` (the page the PDF was linked from) so the bank CDN sees a realistic Referer header — required by some CDNs (e.g. Axis Bank).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL of the PDF to download and parse" },
          referer: {
            type: "string",
            description: "Optional. URL of the page the PDF was linked from. Pass this when known — some bank CDNs reject requests without a same-origin Referer header.",
          },
        },
        required: ["url"],
      },
    },
  },
];

// ── Tool Implementations ───────────────────────────────────────────

/**
 * Execute a tool by name.
 * @param {string} name - Tool function name
 * @param {object} args - Parsed arguments from the model
 * @param {object} context - { projectRoot, outputDir, logger, storage? }
 *   When `storage` (a Storage adapter instance) is provided, read_file and
 *   write_file route through it for paths under output/ and data/. Without
 *   `storage`, they fall back to direct fs (legacy local-only mode).
 * @returns {Promise<string>} Result string for the model
 */
async function executeTool(name, args, context) {
  switch (name) {
    case "web_search":
      return webSearch(args.query, context);
    case "fetch_url":
      return fetchUrl(args.url, context);
    case "read_file":
      return readFile(args.file_path, context);
    case "write_file":
      return writeFile(args.file_path, args.content, context);
    case "run_playwright":
      return runPlaywright(args, context);
    case "fetch_pdf":
      return fetchPdf(args.url, context, { referer: args.referer });
    case "slugify":
      return slugifyTool(args.name);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ── web_search ─────────────────────────────────────────────────────

async function webSearch(query, context) {
  // Strategy 1: Bing Search API (if configured)
  const bingKey = process.env.BING_SEARCH_API_KEY;
  if (bingKey) {
    return bingSearch(query, bingKey);
  }

  // Strategy 2: Azure OpenAI Responses API with built-in web_search
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) {
    return responsesApiSearch(query, context);
  }

  // Strategy 3: No search available — guide the agent to try other approaches
  return [
    "Web search is not available (no search API configured).",
    "",
    "Alternative approaches:",
    "1. The bank's domain may already be provided in the pre-looked-up domain info above.",
    "2. Try fetching https://<bank-name-slug>.bank.in directly — most Indian banks use .bank.in per RBI directive.",
    "3. Try common domain patterns: <bankname>.bank.in, <bankabbrev>.bank.in, www.<bankname>.co.in",
    "4. If the bank domain is known, fetch the homepage and look for rate page links.",
    "",
    "Do NOT give up — try the fetch_url tool with a guessed bank.in URL before marking as manual.",
  ].join("\n");
}

/** Bing Search API v7 (requires BING_SEARCH_API_KEY). */
async function bingSearch(query, apiKey) {
  const endpoint = process.env.BING_SEARCH_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("mkt", "en-IN");
  url.searchParams.set("responseFilter", "Webpages");

  try {
    const response = await httpGet(url.toString(), {
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
      timeoutMs: 15000,
    });

    const data = JSON.parse(response.body);
    const results = (data.webPages?.value || []).map((r, i) => (
      `${i + 1}. ${r.name}\n   ${r.url}\n   ${r.snippet || ""}`
    ));

    if (results.length === 0) return "No search results found.";
    return results.join("\n\n");
  } catch (err) {
    return JSON.stringify({ error: `Bing search failed: ${err.message}` });
  }
}

/** Azure OpenAI Responses API web_search (no separate Bing resource needed). */
async function responsesApiSearch(query, context) {
  try {
    const { createResponsesClient, searchWithResponses } = require("./azure-openai-responses");
    const client = createResponsesClient();
    const result = await searchWithResponses(client, query, {
      country: "IN",
      logger: context.logger ? context.logger.warn.bind(context.logger) : undefined,
    });

    if (!result.text) return "No search results found.";

    // Format citations as a numbered list for the agent
    let output = result.text;
    if (result.citations.length > 0) {
      output += "\n\nSources:\n";
      output += result.citations.map((c, i) => `${i + 1}. ${c.title}\n   ${c.url}`).join("\n");
    }
    return output;
  } catch (err) {
    return JSON.stringify({ error: `Responses API search failed: ${err.message}` });
  }
}

// ── fetch_url ──────────────────────────────────────────────────────

const MAX_FETCH_CHARS = 80000;

async function fetchUrl(url, context) {
  const { logger } = context;
  // Sprint 009 Phase 9.5 (2026-06-05): per-bank tls_skip_verify flag.
  // Some bank sites (e.g., aprb.bank.in, amco.bank.in) serve valid rate
  // pages behind expired or self-signed TLS certificates. The local dev
  // environment masks this via Norton Safe Web's MITM CA; the cloud
  // Container Apps runtime has a strict trust store and rejects. When
  // the operator declares `tls_skip_verify: true` in bank-domains, fetch
  // bypasses cert verification — opt-in, per-bank, security trade-off
  // surfaced in the flag name.
  const { overrides } = getPlaywrightOverrides(context.projectRoot, context.bankCode);
  const tlsSkipVerify = overrides && overrides.tls_skip_verify === true;
  if (tlsSkipVerify) {
    console.log(`[METRIC] tls_skip_verify bank=${context.bankCode} url=${url} — using insecure HTTPS agent (operator opt-in).`);
  }
  try {
    const { body, contentType } = await httpGet(url, {
      timeoutMs: 30000,
      maxBytes: 2_000_000,
      rejectUnauthorized: !tlsSkipVerify,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
      },
    });

    // Detect PDF/binary — don't send raw bytes to the model
    const isPdf = (contentType && contentType.includes("application/pdf")) || url.toLowerCase().endsWith(".pdf");
    if (isPdf) {
      return JSON.stringify({
        info: "This URL points to a PDF file. Use run_playwright to extract tables, or note the PDF URL in the config for later processing.",
        pdf_url: url,
        content_type: contentType || "application/pdf",
      });
    }

    // Detect other binary content types
    if (contentType && !contentType.includes("text/") && !contentType.includes("html") &&
        !contentType.includes("json") && !contentType.includes("xml")) {
      return JSON.stringify({
        info: `Binary content (${contentType}). Cannot extract rate data from this URL.`,
        url,
      });
    }

    const cleaned = truncateHtml(body, MAX_FETCH_CHARS);
    if (logger && cleaned.length < body.length) {
      logger.warn(`HTML truncated from ${body.length} to ${cleaned.length} chars for ${url}`);
    }
    return cleaned;
  } catch (err) {
    return JSON.stringify({ error: `Fetch failed: ${err.message}` });
  }
}

// ── read_file ──────────────────────────────────────────────────────

/**
 * Derive a Storage key (forward slashes, lowercase, project-root-relative)
 * from an absolute filesystem path. Returns null if the path is outside
 * the project root or contains characters incompatible with the key
 * conventions (caller falls back to fs in that case).
 */
function deriveStorageKey(absolutePath, projectRoot) {
  const rel = path.relative(projectRoot, absolutePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  // Normalize Windows backslashes; lowercase per key conventions
  const key = rel.split(path.sep).join("/").toLowerCase();
  // Storage keys forbid trailing slash and various special chars; readFile/writeFile
  // are file paths so trailing slash shouldn't appear, but bail out if anything looks off.
  if (key.endsWith("/") || /[?#\\\x00-\x1f\x7f]/.test(key) || /\/\//.test(key)) return null;
  return key;
}

async function readFile(filePath, context) {
  const resolved = path.resolve(context.projectRoot, filePath);

  // Security: must be within project root
  if (!resolved.startsWith(context.projectRoot)) {
    return JSON.stringify({ error: "Path escapes project root" });
  }

  // Storage adapter path (cloud mode or any caller that wires one up)
  if (context.storage) {
    const key = deriveStorageKey(resolved, context.projectRoot);
    if (key) {
      try {
        const content = await context.storage.readText(key);
        if (content.length > 100_000) {
          return content.slice(0, 100_000) + "\n... (truncated at 100KB)";
        }
        return content;
      } catch (err) {
        // Bubble StorageNotFoundError as a clean "not found" message; otherwise stringify
        return JSON.stringify({ error: `Read failed: ${err.message}` });
      }
    }
    // If the key couldn't be derived (path outside project, weird chars), fall through to fs.
  }

  // Legacy / fallback: direct fs
  try {
    const content = fs.readFileSync(resolved, "utf-8");
    if (content.length > 100_000) {
      return content.slice(0, 100_000) + "\n... (truncated at 100KB)";
    }
    return content;
  } catch (err) {
    return JSON.stringify({ error: `Read failed: ${err.message}` });
  }
}

// ── write_file ─────────────────────────────────────────────────────

async function writeFile(filePath, content, context) {
  let resolved = path.resolve(context.outputDir, filePath);

  // Security: must be within output dir or project output/
  const outputBase = path.resolve(context.projectRoot, "output");
  if (!resolved.startsWith(context.outputDir) && !resolved.startsWith(outputBase)) {
    return JSON.stringify({ error: "Path must be within the output directory" });
  }

  const basename = path.basename(resolved);

  // ADR-012: the registry file is NEVER written via the LLM's write_file tool.
  // bank-domains.json mutations go through `updateDomainEntry` (lib/domain-cache.js)
  // which does the per-entry merge + safe-write atomic rewrite. The LLM tool
  // hijacking this path would bypass the merge and silently drop curated fields.
  const dataBase = path.resolve(context.projectRoot, "data");
  if (
    resolved.startsWith(dataBase) &&
    (basename === "bank-domains.json" || basename === "bank-domains-pending.json")
  ) {
    return JSON.stringify({
      error:
        "Refusing to write the registry file directly. " +
        "Use updateDomainEntry / the registry update flow rather than write_file.",
    });
  }

  // Storage adapter path (cloud mode or any caller that wires one up)
  if (context.storage) {
    const key = deriveStorageKey(resolved, context.projectRoot);
    if (key) {
      try {
        await context.storage.writeText(key, content);
        return `Wrote ${content.length} bytes to ${basename}`;
      } catch (err) {
        return JSON.stringify({ error: `Write failed: ${err.message}` });
      }
    }
    // If the key couldn't be derived, fall through to fs.
  }

  // ADR-012: per-bank artifacts route through safe-write so curated targets
  // are preserved (incoming routed to <path>.pending.json) and writes are
  // atomic. Non-per-bank outputs (aggregator/batch indexes, ad-hoc files)
  // fall through to a direct fs.writeFileSync as before — those are
  // explicitly out of scope for ADR-012.
  const kind = inferArtifactKind(basename);
  if (kind) {
    let incoming = content;
    // safe-write does extraction_method validation + lazy-tagging when given
    // an object. The LLM hands us a serialized JSON string; parse if possible
    // so safe-write can inspect it. If parsing fails (truncation, bad JSON),
    // pass the raw string through — safe-write will write it verbatim and
    // skip the extraction_method check (writing-as-string path).
    if (typeof content === "string") {
      try {
        incoming = JSON.parse(content);
      } catch (_) {
        // leave incoming as raw string
      }
    }

    // Variant-naming guardrail (sprint-004 2026-05-23): when the LLM
    // writes a rate file whose payload declares variant=nre/nro/fcnr/gift,
    // the filename MUST match `<bank_code>_<variant>_rates.json`. The
    // prompt instructs this, but observed in the IDBI-IBU May 20 cohort
    // run that the LLM wrote `variant: "gift"` content to `_rates.json`
    // (regular). Pack-builder reads by filename → 0 GIFT slabs reported.
    // Auto-redirect to the correct filename instead of writing wrong path.
    if (kind === 'rates' && typeof incoming === 'object' && incoming !== null
        && typeof incoming.variant === 'string' && typeof incoming.bank_code === 'string') {
      const v = incoming.variant;
      const bc = incoming.bank_code;
      if (v !== 'regular' && (v === 'nre' || v === 'nro' || v === 'fcnr' || v === 'gift')) {
        const expectedSuffix = `${bc}_${v}_rates.json`;
        if (!basename.endsWith(expectedSuffix)) {
          // Rewrite the destination to the variant-suffixed path
          const correctedPath = path.resolve(path.dirname(resolved), expectedSuffix);
          if (context.logger?.warn) {
            context.logger.warn(`write_file variant-naming guardrail: payload.variant="${v}" but filename was "${basename}"; redirecting to "${expectedSuffix}"`);
          }
          // Mutate the local `resolved` (declared `let` above) so safe-write
          // writes to the corrected variant-suffixed path. basename is
          // recomputed for the success message below.
          resolved = correctedPath;
        }
      }
    }

    try {
      const result = safeWriteArtifact({
        path: resolved,
        incoming,
        kind,
        source: "agent",
        logger: context.logger,
      });

      if (result.deferredToPending) {
        return JSON.stringify({
          deferred_to_pending: true,
          pending_path: result.pendingPath,
          note: "Existing target is operator-curated; your write was preserved in the pending sidecar.",
        });
      }
      return `Wrote ${content.length} bytes to ${basename}`;
    } catch (err) {
      return JSON.stringify({ error: `Write failed: ${err.message}` });
    }
  }

  // Non-per-bank artifact (aggregator/batch output, ad-hoc file): direct fs.
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    // safe-write-exempt: aggregator/batch/ad-hoc output (no kind match from inferArtifactKind); ADR-012 explicitly excludes non-per-bank artifacts.
    fs.writeFileSync(resolved, content, "utf-8");
    return `Wrote ${content.length} bytes to ${basename}`;
  } catch (err) {
    return JSON.stringify({ error: `Write failed: ${err.message}` });
  }
}

// ── run_playwright ─────────────────────────────────────────────────

/**
 * Build the argv passed to scripts/fetch_rates_playwright.js. Extracted so
 * the default-on flag behaviour can be unit-tested without spawning a
 * subprocess. Sprint 4 Track A (2026-05-20).
 */
function buildPlaywrightCmdArgs(scriptPath, args, innerTimeoutMs, perBankOverrides, extractionHint) {
  const cmdArgs = [scriptPath, args.url];
  // Default --scroll/--tabs/--selects to ON unless the LLM explicitly passes
  // false. AU SFB cloud regression showed the LLM stopping at the first
  // amount-tier table when these flags weren't set; the flags no-op on
  // pages without tabs/selects/lazy-load, so the safe default is "always
  // sweep" — cost is one extra Playwright pass at most.
  //
  // Per-bank `playwright_skip` (array) suppresses specific actions for banks
  // where the default sweep is harmful (e.g. SBI's page has many <select>
  // dropdowns that triggered combinatorial re-renders past any reasonable
  // timeout). `playwright_skip: ["selects","tabs"]` turns those flags off
  // regardless of what the LLM asked for. Accepts any of:
  //   "scroll" | "tabs" | "accordions" | "selects" | "intercept"
  const skip = new Set(Array.isArray(perBankOverrides?.playwright_skip) ? perBankOverrides.playwright_skip : []);
  const scrollOn = args.scroll !== false && !skip.has("scroll");
  const tabsOn = args.tabs !== false && !skip.has("tabs");
  const selectsOn = args.selects !== false && !skip.has("selects");
  const accordionsOn = args.accordions && !skip.has("accordions");
  const interceptOn = args.intercept && !skip.has("intercept");
  if (scrollOn) cmdArgs.push("--scroll");
  if (tabsOn) cmdArgs.push("--tabs");
  if (accordionsOn) cmdArgs.push("--accordions");
  if (selectsOn) cmdArgs.push("--selects");
  if (interceptOn) cmdArgs.push("--intercept");
  if (innerTimeoutMs) cmdArgs.push("--timeout", String(innerTimeoutMs));
  // Per-bank engine/stealth overrides from bank-domains.json. Default
  // (chromium, no stealth) keeps the 500+ working banks on their current
  // code path; only the slugs that need it pay the stealth/Firefox cost.
  const browser = perBankOverrides?.playwright_browser;
  if (browser && browser !== "chromium") cmdArgs.push("--browser", browser);
  if (perBankOverrides?.playwright_stealth) cmdArgs.push("--stealth");
  // Sprint 009 Phase 9.5 (2026-06-05): per-bank tls_skip_verify flag,
  // honored by Playwright via browser.newContext({ ignoreHTTPSErrors: true }).
  // Same opt-in security trade-off as fetchUrl's parallel path. See
  // design/phase-9-5-9-6-alternative-fixes.md.
  if (perBankOverrides?.tls_skip_verify) cmdArgs.push("--ignore-https-errors");
  // M2.2 (sprint-004): per-URL extraction hints. Threaded only when the
  // resolver in resolveExtractionHint matched this URL against the bank's
  // registry rate_pages.* entries.
  if (extractionHint && extractionHint.type === "html") {
    if (extractionHint.wait_for_selector) cmdArgs.push("--wait-for-selector", extractionHint.wait_for_selector);
    if (extractionHint.click_to_reveal) cmdArgs.push("--click-to-reveal", extractionHint.click_to_reveal);
    if (extractionHint.extract_selector) cmdArgs.push("--extract-selector", extractionHint.extract_selector);
    if (extractionHint.tab_selector) cmdArgs.push("--tab-selector", extractionHint.tab_selector);
  }
  return cmdArgs;
}

// M2.2 → M2.5: resolveExtractionHint extracted to ./extraction-hint.js so
// the orchestrator path (lib/actions/extract_pdf_table.js) can reuse it
// without dragging the LLM tooling chain in. Imported at the top of this
// file.

// Per-bank Playwright overrides from `data/bank-domains.json`.
// Supported fields (all optional):
//   playwright_timeout_ms : page.goto inner timeout (default 60s)
//   playwright_browser    : "chromium" | "firefox" | "webkit" (default chromium)
//   playwright_stealth    : true to load playwright-extra + stealth plugin
// Returns the full override object plus computed { innerMs, outerMs }.
// Outer is the spawnSync hard kill (inner + 30s buffer + 30s padding for
// Firefox/stealth cold-start).
const PLAYWRIGHT_DEFAULT_INNER_MS = 60_000;
const PLAYWRIGHT_OUTER_BUFFER_MS = 30_000;
let _bankDomainsCache = null;
function getPlaywrightOverrides(projectRoot, bankCode) {
  const empty = {};
  if (!bankCode) return { overrides: empty, innerMs: PLAYWRIGHT_DEFAULT_INNER_MS, outerMs: PLAYWRIGHT_DEFAULT_INNER_MS + 60_000 };
  if (!_bankDomainsCache) {
    const p = path.join(projectRoot, "data", "bank-domains.json");
    try {
      _bankDomainsCache = JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      _bankDomainsCache = {};
    }
  }
  const overrides = _bankDomainsCache[bankCode] || empty;
  const timeoutOverride = overrides.playwright_timeout_ms;
  const innerMs = Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : PLAYWRIGHT_DEFAULT_INNER_MS;
  return { overrides, innerMs, outerMs: innerMs + PLAYWRIGHT_OUTER_BUFFER_MS + 30_000 };
}

function runPlaywright(args, context) {
  const scriptPath = path.join(context.projectRoot, "scripts", "fetch_rates_playwright.js");
  const { overrides, innerMs, outerMs } = getPlaywrightOverrides(context.projectRoot, context.bankCode);

  // Sprint 009 cloud-validation-3 (2026-06-04): per-bank Playwright kill-switch.
  // SBI and BoI-IBU consistently exhibited 120s spawnSync ETIMEDOUT on the
  // Azure→{sbi,boi}.bank.in network path — not resource pressure (preflight
  // launches chromium in 11s, BoB/PNB Playwright calls work fine). When the
  // operator declares `playwright_disabled: true` on the bank-domains entry,
  // skip the spawn entirely so the LLM picks an HTML/PDF/fetch_url fallback
  // instead of burning 7 × 120s in spawn-timeout loops.
  if (overrides && overrides.playwright_disabled === true) {
    console.log(`[METRIC] playwright_disabled bank=${context.bankCode} url=${args.url} — returning fast-fail to LLM so it can pick fetch_url / extract_pdf_table fallback.`);
    return JSON.stringify({
      error: "Playwright is disabled for this bank (playwright_disabled=true in bank-domains.json). Use fetch_url for static HTML pages, fetch_pdf for PDF URLs, or note the URL in the config without attempting JS rendering.",
      playwright_disabled: true,
    });
  }

  // M2.2: auto-resolve URL → extraction.<key> hint from the registry. The
  // LLM passes only the URL; the hints are applied transparently. A telemetry
  // line lets us measure adoption.
  const extractionHint = resolveExtractionHint(overrides, args.url);
  if (extractionHint) {
    console.log(`[METRIC] hint_applied bank=${context.bankCode} key=${extractionHint.key} type=${extractionHint.type || "html"}`);
  }
  const cmdArgs = buildPlaywrightCmdArgs(scriptPath, args, innerMs, overrides, extractionHint);

  const result = spawnSync(process.execPath, cmdArgs, {
    cwd: context.projectRoot,
    timeout: outerMs,
    maxBuffer: 5 * 1024 * 1024,
    encoding: "utf-8",
  });

  if (result.error) {
    return JSON.stringify({ error: `Playwright spawn failed: ${result.error.message}` });
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").slice(0, 500);
    return JSON.stringify({ error: `Playwright exited ${result.status}: ${stderr}` });
  }

  // Extract JSON after the JSON_OUTPUT: marker
  const stdout = result.stdout || "";
  const marker = "JSON_OUTPUT:";
  const markerIdx = stdout.indexOf(marker);
  if (markerIdx >= 0) {
    return stdout.slice(markerIdx + marker.length).trim();
  }

  // No JSON marker — return raw output (truncated)
  if (stdout.length > MAX_FETCH_CHARS) {
    return stdout.slice(0, MAX_FETCH_CHARS) + "\n... (truncated)";
  }
  return stdout;
}

// ── fetch_pdf ─────────────────────────────────────────────────────

function fetchPdf(url, context, opts = {}) {
  const scriptPath = path.join(context.projectRoot, "scripts", "extract_rates_pdf.mjs");
  // M1 sprint-004: thread `referer` to the child script so bank CDNs that
  // require a same-origin Referer (Axis, others) accept the request. Spawn
  // timeout raised to 130s — child's read-timeout is 90s plus 30s connect
  // plus parse overhead.
  const cliArgs = [scriptPath, url];
  if (opts.referer) cliArgs.push("--referer", opts.referer);

  // M2.3 (sprint-004 2026-05-21): auto-resolve per-URL PDF column hint.
  // When bank-domains.json#<bank>.extraction.<key> has type="pdf" and the
  // URL matches, write the hint to a temp file and pass --hint to the
  // child. Cleanup the temp file after spawnSync returns.
  const { overrides } = getPlaywrightOverrides(context.projectRoot, context.bankCode);
  const extractionHint = resolveExtractionHint(overrides, url);
  let tmpHintPath = null;
  if (extractionHint && extractionHint.type === "pdf") {
    try {
      tmpHintPath = path.join(os.tmpdir(), `rdai-pdf-hint-${context.bankCode || "unknown"}-${process.pid}-${Date.now()}.json`);
      // safe-write-exempt: ephemeral OS-tmpdir hint file used as subprocess input, unlinked in finally.
      fs.writeFileSync(tmpHintPath, JSON.stringify(extractionHint), "utf-8");
      cliArgs.push("--hint", tmpHintPath);
      console.log(`[METRIC] hint_applied bank=${context.bankCode} key=${extractionHint.key} type=pdf`);
    } catch (err) {
      // Hint write failed — fall back to no-hint parse. Not fatal.
      console.warn(`Failed to write PDF hint tmp file: ${err.message}`);
      tmpHintPath = null;
    }
  }

  const result = spawnSync(process.execPath, cliArgs, {
    cwd: context.projectRoot,
    timeout: 130_000,
    maxBuffer: 5 * 1024 * 1024,
    encoding: "utf-8",
  });

  // M2.3: clean up the hint tmp file regardless of outcome.
  if (tmpHintPath) {
    try { fs.unlinkSync(tmpHintPath); } catch (_) { /* best-effort */ }
  }

  if (result.error) {
    return JSON.stringify({ error: `PDF extraction failed: ${result.error.message}` });
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").slice(0, 500);
    return JSON.stringify({ error: `PDF extraction exited ${result.status}: ${stderr}` });
  }

  const stdout = result.stdout || "";
  // extract_rates_pdf.mjs uses "=== JSON_OUTPUT ===" marker (with spaces)
  const marker = "JSON_OUTPUT";
  const markerIdx = stdout.indexOf(marker);
  if (markerIdx >= 0) {
    // Find the start of JSON after the marker line
    const afterMarker = stdout.slice(markerIdx + marker.length);
    const jsonStart = afterMarker.indexOf("{");
    if (jsonStart >= 0) {
      return afterMarker.slice(jsonStart).trim();
    }
  }

  // No JSON marker — return raw text (truncated)
  if (stdout.length > MAX_FETCH_CHARS) {
    return stdout.slice(0, MAX_FETCH_CHARS) + "\n... (truncated)";
  }
  return stdout;
}

// ── HTTP helper ────────────────────────────────────────────────────

function httpGet(url, { headers = {}, timeoutMs = 30000, maxBytes = 2_000_000, rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const reqOpts = { headers, timeout: timeoutMs };
    // rejectUnauthorized only applies to https.request — http ignores it.
    // Setting it to false enables the lax-TLS path used by tls_skip_verify
    // banks (Sprint 009 Phase 9.5).
    if (proto === https) reqOpts.rejectUnauthorized = rejectUnauthorized;
    const req = proto.get(url, reqOpts, (res) => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.resume();
        return httpGet(redirectUrl, { headers, timeoutMs, maxBytes, rejectUnauthorized }).then(resolve, reject);
      }

      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const contentType = res.headers["content-type"] || "";
      const chunks = [];
      let totalBytes = 0;
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes <= maxBytes) chunks.push(chunk);
      });
      res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf-8"), contentType }));
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

// ── HTML truncation ────────────────────────────────────────────────

function truncateHtml(html, maxChars = MAX_FETCH_CHARS) {
  // Strip elements that never contain rate data
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxChars) return cleaned;

  // If still too large, try extracting only <table> elements + surrounding context
  const tables = [];
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  let match;
  while ((match = tableRegex.exec(cleaned)) !== null) {
    // Include 200 chars before and after each table for context
    const start = Math.max(0, match.index - 200);
    const end = Math.min(cleaned.length, match.index + match[0].length + 200);
    tables.push(cleaned.slice(start, end));
  }

  if (tables.length > 0) {
    const tableContent = tables.join("\n\n--- TABLE BOUNDARY ---\n\n");
    if (tableContent.length <= maxChars) return tableContent;
    return tableContent.slice(0, maxChars) + "\n... TRUNCATED ...";
  }

  // No tables found — hard truncate
  return cleaned.slice(0, maxChars) + "\n... TRUNCATED ...";
}

// ── slugify ─────────────────────────────────────────────────────────

function slugifyTool(name) {
  if (typeof name !== "string" || !name.trim()) {
    return JSON.stringify({ error: "name must be a non-empty string" });
  }
  return JSON.stringify({ slug: canonicalSlugify(name) });
}

module.exports = { TOOL_DEFINITIONS, executeTool, truncateHtml, inferArtifactKind, _buildPlaywrightCmdArgs: buildPlaywrightCmdArgs, _resolveExtractionHint: resolveExtractionHint };
