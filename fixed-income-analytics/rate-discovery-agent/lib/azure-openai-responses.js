/**
 * Azure OpenAI Responses API client for web search.
 *
 * Uses the built-in web_search tool in the Responses API to discover
 * bank domains and rate page URLs. No separate Bing Search resource needed.
 *
 * This is separate from the Chat Completions API used by the main agent
 * loop (lib/agent.js). The Responses API is used specifically for domain
 * and page discovery where web search is required.
 *
 * API: POST /openai/v1/responses
 * Docs: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/web-search
 */

const { AzureOpenAI } = require("openai");

/**
 * Create an Azure OpenAI client configured for the Responses API.
 * @returns {AzureOpenAI}
 */
function createResponsesClient() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  // Responses API requires 2025-03-01-preview or later
  const apiVersion = process.env.AZURE_OPENAI_RESPONSES_API_VERSION || "2025-03-01-preview";

  if (!endpoint) throw new Error("Missing AZURE_OPENAI_ENDPOINT env var");

  if (apiKey) {
    return new AzureOpenAI({ endpoint, apiKey, apiVersion });
  }

  // Managed Identity path — see lib/azure-openai-client.js for the
  // auth-precedence rationale.
  const { DefaultAzureCredential, getBearerTokenProvider } = require("@azure/identity");
  const managedIdentityClientId = process.env.AZURE_CLIENT_ID;
  const credential = new DefaultAzureCredential(
    managedIdentityClientId ? { managedIdentityClientId } : undefined
  );
  const azureADTokenProvider = getBearerTokenProvider(
    credential,
    "https://cognitiveservices.azure.com/.default"
  );
  return new AzureOpenAI({ endpoint, azureADTokenProvider, apiVersion });
}

/**
 * Run a web search query via the Responses API.
 *
 * @param {AzureOpenAI} client
 * @param {string} input - The prompt / question to answer with web search
 * @param {object} [options]
 * @param {string} [options.model] - Deployment name (default: AZURE_OPENAI_DEPLOYMENT_FULL or gpt-4.1)
 * @param {string[]} [options.allowedDomains] - Restrict search to these domains (max 100)
 * @param {string} [options.country] - ISO country code for localization (default: "IN")
 * @param {Function} [options.logger] - Logger warn function for retries
 * @returns {Promise<{text: string, citations: Array<{url: string, title: string}>, searchQueries: string[]}>}
 */
async function searchWithResponses(client, input, options = {}) {
  const {
    model = process.env.AZURE_OPENAI_DEPLOYMENT_FULL || "gpt-4.1",
    allowedDomains,
    country = "IN",
    logger,
  } = options;

  const webSearchTool = {
    type: "web_search",
    user_location: {
      type: "approximate",
      country,
    },
  };

  // Add domain filtering if specified
  if (allowedDomains && allowedDomains.length > 0) {
    webSearchTool.filters = {
      allowed_domains: allowedDomains,
    };
  }

  const maxRetries = 3;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.responses.create({
        model,
        tools: [webSearchTool],
        input,
      });

      // Parse the response
      const result = { text: "", citations: [], searchQueries: [] };

      for (const item of response.output || []) {
        if (item.type === "web_search_call" && item.action) {
          if (item.action.query) {
            result.searchQueries.push(item.action.query);
          }
        }
        if (item.type === "message" && item.content) {
          for (const content of item.content) {
            if (content.type === "output_text") {
              result.text += content.text || "";
              // Extract citations
              for (const ann of content.annotations || []) {
                if (ann.type === "url_citation") {
                  result.citations.push({
                    url: ann.url,
                    title: ann.title || "",
                  });
                }
              }
            }
          }
        }
      }

      // Also handle the simpler output_text accessor
      if (!result.text && response.output_text) {
        result.text = response.output_text;
      }

      return result;
    } catch (err) {
      lastError = err;
      const status = err.status || err.statusCode || 0;
      const retryable = status === 429 || status === 500 || status === 503;

      if (!retryable || attempt === maxRetries) throw err;

      const delayMs = Math.pow(2, attempt) * 1000;
      if (logger) logger(`Responses API ${status} on attempt ${attempt + 1}, retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Discover bank domains and rate page URLs via web search.
 *
 * @param {AzureOpenAI} client
 * @param {Array<{name: string, category: string}>} banks - Banks to discover
 * @param {object} [options]
 * @param {string} [options.model] - Deployment name
 * @param {Function} [options.logger] - Logger warn function
 * @returns {Promise<object>} Map of bank_slug → { domain, rate_pages, notes }
 */
async function discoverDomains(client, banks, options = {}) {
  const bankList = banks.map((b) => {
    let line = `- ${b.name}`;
    if (b.category) line += ` (${b.category})`;
    return line;
  }).join("\n");

  const prompt = `Find the official website for each of these Indian banks. For each bank:
1. Search site:bank.in first — per RBI directive, all Indian banks must use .bank.in domains.
2. If no .bank.in found, search for the bank's official website.
3. Also identify the FD interest rates page URL if visible in search results.
4. Look for separate pages for: domestic FD, NRE deposits, NRO deposits, FCNR deposits, savings rates.

Banks to discover:
${bankList}

Respond with a JSON object (and nothing else before or after it) in this exact format:
{
  "bank-slug-here": {
    "domain": "bankname.bank.in",
    "rate_pages": {
      "fd": "/interest-rates",
      "fd_nre": "/nri/nre-deposits",
      "savings": "/savings-rates"
    },
    "notes": "Optional notes about the bank"
  }
}

Rules:
- bank_code key: lowercase full bank name, hyphens instead of spaces, no abbreviation
- domain: bare hostname without https:// or www. Prefer .bank.in when available.
- rate_pages: include only paths you can identify from search results. Use keys: fd, fd_nre, fd_nro, fd_fcnr, fd_nri_combined, savings, rd
- If no website found: set "domain": null with a note explaining why
- Do NOT use aggregator sites (bankbazaar, paisabazaar, cleartax, groww)`;

  const result = await searchWithResponses(client, prompt, options);

  // Parse JSON from the response text
  try {
    // Extract JSON object from the response (may be wrapped in markdown code block)
    let jsonText = result.text;
    const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1].trim();
    } else {
      // Try to find raw JSON object
      const braceStart = jsonText.indexOf("{");
      const braceEnd = jsonText.lastIndexOf("}");
      if (braceStart >= 0 && braceEnd > braceStart) {
        jsonText = jsonText.slice(braceStart, braceEnd + 1);
      }
    }
    return JSON.parse(jsonText);
  } catch (err) {
    // Return raw text if JSON parsing fails
    return { _raw: result.text, _error: `JSON parse failed: ${err.message}` };
  }
}

module.exports = { createResponsesClient, searchWithResponses, discoverDomains };
