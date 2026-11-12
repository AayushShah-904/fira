/**
 * Azure OpenAI client wrapper with retry logic.
 *
 * Wraps the `openai` npm package's AzureOpenAI class with exponential
 * backoff on 429 (rate limit) and 500/503 (transient server errors).
 */

const { AzureOpenAI } = require("openai");

/**
 * Create a configured AzureOpenAI client from environment variables.
 *
 * Auth precedence:
 *   1. AZURE_OPENAI_API_KEY (local dev convenience; .env-style)
 *   2. Managed Identity via DefaultAzureCredential (cloud; requires the
 *      caller principal to have 'Cognitive Services OpenAI User' on the
 *      AOAI account — Bicep grants this to the Job MI).
 *
 * AZURE_CLIENT_ID, when present, hints DefaultAzureCredential to use a
 * specific user-assigned MI (Bicep sets this to the Job MI's clientId).
 *
 * @returns {AzureOpenAI}
 */
function createClient() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview";

  if (!endpoint) throw new Error("Missing AZURE_OPENAI_ENDPOINT env var");

  if (apiKey) {
    return new AzureOpenAI({ endpoint, apiKey, apiVersion });
  }

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
 * Call chat completions with automatic retry on transient errors.
 *
 * @param {AzureOpenAI} client
 * @param {object} params - Parameters for chat.completions.create()
 * @param {object} [options]
 * @param {number} [options.maxRetries=3] - Max retries on 429/5xx
 * @param {Function} [options.logger] - logger.warn for retry logging
 * @returns {Promise<object>} Chat completion response
 */
async function chatCompletion(client, params, options = {}) {
  const { maxRetries = 3, logger, model } = options;
  const deployment = model || process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1";

  const requestParams = {
    model: deployment,
    temperature: 0.1,
    ...params,
  };

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.chat.completions.create(requestParams);
    } catch (err) {
      lastError = err;
      const status = err.status || err.statusCode || 0;
      const retryable = status === 429 || status === 500 || status === 503;

      if (!retryable || attempt === maxRetries) throw err;

      // Exponential backoff: 1s, 2s, 4s (or use Retry-After header)
      const retryAfter = err.headers?.["retry-after"];
      const delayMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
        : Math.pow(2, attempt) * 1000;

      if (logger) {
        logger(`API ${status} on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${delayMs}ms`);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

module.exports = { createClient, chatCompletion };
