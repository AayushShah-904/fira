'use strict';

/**
 * Action: find_website — Sprint 003 A1 contract.
 *
 * Discover a bank's official website. Deterministic-first strategy:
 *   1. If hints.cached_domain is supplied (recheck), HEAD-confirm and return.
 *   2. Try `https://<slug>.bank.in` (RBI mandates .bank.in for Indian banks).
 *   3. Fall back to web search (Bing or Azure OpenAI Responses API).
 *   4. Rank candidates by docs/agent/discovery-workflow.md priority (.bank.in > .co.in > .com),
 *      reject aggregator sites.
 *
 * Q1: returns single best `url` PLUS `candidates_considered[]` metadata.
 * Q2: fails fast (ok:false) below confidence threshold; never returns a
 *     low-confidence guess.
 *
 * Output (success):
 *   { ok: true, url, confidence, candidates_considered: [...], notes? }
 * Output (failure):
 *   { ok: false, error_class, error_message, candidates_considered? }
 */

const { httpRequest, headCheck } = require('./_http');
const { slugify: canonicalSlugify } = require('../../scripts/utils/slugify');

const VALID_CONFIDENCE = ['high', 'medium', 'low'];

/** Aggregator / non-official domains to reject. Per docs/agent/discovery-workflow.md (Find the Official Website). */
const AGGREGATOR_DOMAINS = new Set([
  'bankbazaar.com', 'paisabazaar.com', 'cleartax.in', 'groww.in',
  'moneycontrol.com', 'economictimes.indiatimes.com', 'business-standard.com',
  'thehindubusinessline.com', 'livemint.com', 'businesstoday.in',
  'wikipedia.org', 'en.wikipedia.org',
  'crisil.com', 'icra.in', 'careratings.com',
  'rbi.org.in', 'sebi.gov.in',  // regulators, not banks
  'glassdoor.com', 'glassdoor.co.in', 'naukri.com', 'indeed.com',
  'linkedin.com',
]);

/** Domain TLD priority for ranking candidates. */
const TLD_PRIORITY = [
  { suffix: '.bank.in', score: 100, reason: 'RBI-mandated .bank.in' },
  { suffix: '.co.in',   score: 80,  reason: 'Indian commercial domain' },
  { suffix: '.com',     score: 60,  reason: 'commercial domain' },
  { suffix: '.org',     score: 50,  reason: 'organisation domain' },
  { suffix: '.in',      score: 40,  reason: 'Indian domain' },
];

/** Minimum score for confidence='high' OR 'medium'. */
const HIGH_CONFIDENCE_THRESHOLD = 100;  // .bank.in confirmed
const MEDIUM_CONFIDENCE_THRESHOLD = 60; // .co.in / .com confirmed
const LOW_CONFIDENCE_THRESHOLD = 40;    // .in fallback

async function findWebsite(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('findWebsite: input must be an object');
  }
  const { bank_name, state, hints, logger, session } = input;
  let { bank_type } = input;
  if (!bank_name || typeof bank_name !== 'string') {
    throw new Error('findWebsite: input.bank_name is required');
  }
  // Sprint 010 A2 (2026-06-09): tolerate missing bank_type — fall back to
  // 'UNKNOWN' (matches orchestrator.js A2 sentinel) so a registry-less
  // discovery run still completes website search. The downstream confidence
  // heuristic (domain-pattern matching) doesn't depend on bank_type; only
  // the LLM probe in step 4 uses it for prompt grounding, and 'UNKNOWN'
  // is acceptable there.
  if (!bank_type || typeof bank_type !== 'string') {
    bank_type = 'UNKNOWN';
  }

  const candidates_considered = [];

  // ── Step 1: recheck with cached domain ─────────────────────────────
  // The cache (data/bank-domains.json) is hand-curated and authoritative.
  // Many Indian bank sites serve incomplete TLS chains (.bank.in domains
  // especially — the agent-learnings.md flags this for amcobank, dcbagra,
  // and others). Strict TLS would mark them broken. We HEAD-check the
  // cached URL strictly first; on TLS failure we retry with relaxed
  // verification (still record the laxity in the candidate trail).
  if (hints?.cached_domain) {
    const cachedUrl = ensureScheme(hints.cached_domain);
    let ok = await headCheck(cachedUrl, { session });
    let tlsRelaxed = false;
    if (!ok) {
      // Retry with relaxed TLS for cached domains (pre-trusted). When `session`
      // is in use the first headCheck already exercised it; this Node-HTTP
      // retry is for the non-session path (RDA_USE_PLAYWRIGHT_SESSION=0) or
      // when session.fetch threw and we already auto-fell-back inside _http.js.
      ok = await headCheck(cachedUrl, { tolerant: true });
      if (ok) tlsRelaxed = true;
    }
    candidates_considered.push({ url: cachedUrl, source: 'cached_domain', http_ok: ok, tls_relaxed: tlsRelaxed });
    if (ok) {
      return {
        ok: true,
        url: cachedUrl,
        confidence: 'high',
        candidates_considered,
        notes: tlsRelaxed
          ? 'recheck: cached_domain returned 2xx/3xx with relaxed TLS (cert chain incomplete — bank-domains.json cache is authoritative)'
          : 'recheck: cached_domain returned 2xx/3xx',
      };
    }
    // HEAD/GET failed. WAF-protected bank sites (au.bank.in, bankofindia.bank.in,
    // hdfc.bank.in homepage, etc.) reject HEAD with 403 and abort GET with
    // ECONNRESET when invoked from Node's http client. The cached_domain is
    // hand-curated and authoritative, so trust it anyway — Playwright will
    // do the actual fetch downstream with a real browser stack.
    return {
      ok: true,
      url: cachedUrl,
      confidence: 'medium',
      candidates_considered,
      notes: 'cached_domain HEAD failed (likely WAF rejection of Node UA); trusting bank-domains.json cache. Downstream Playwright fetches should succeed with browser stack.',
    };
  }

  // ── Step 2: try <slug>.bank.in ─────────────────────────────────────
  const slug = canonicalSlugify(bank_name);
  const bankInCandidates = bankInVariants(slug, bank_name);
  for (const url of bankInCandidates) {
    const ok = await headCheck(url, { session });
    candidates_considered.push({ url, source: 'bank-in-construction', http_ok: ok });
    if (ok) {
      return {
        ok: true,
        url,
        confidence: 'high',
        candidates_considered,
        notes: `constructed from canonical slug + .bank.in TLD (RBI-mandated)`,
      };
    }
  }

  // ── Step 3: web search fallback ────────────────────────────────────
  let searchResults = [];
  try {
    searchResults = await webSearchCandidates(`"${bank_name}" official website india${state ? ' ' + state : ''}`, logger);
  } catch (err) {
    candidates_considered.push({ url: null, source: 'web_search', error: err.message });
  }

  for (const r of searchResults) {
    candidates_considered.push({ url: r.url, source: 'web_search', snippet: r.snippet?.slice(0, 100) });
  }

  // ── Step 4: rank ───────────────────────────────────────────────────
  const ranked = rankCandidates(searchResults, bank_name, slug);
  if (ranked.length === 0) {
    return {
      ok: false,
      error_class: 'no_candidates_found',
      error_message: `no .bank.in construction, no web-search results, no cached domain for "${bank_name}"`,
      candidates_considered,
    };
  }

  const top = ranked[0];
  const ok = await headCheck(top.url, { session });
  if (!ok) {
    return {
      ok: false,
      error_class: 'all_candidates_rejected',
      error_message: `top-ranked candidate ${top.url} did not return 2xx on HEAD; refused to return as low-confidence guess`,
      candidates_considered,
    };
  }

  const confidence =
    top.score >= HIGH_CONFIDENCE_THRESHOLD ? 'high' :
    top.score >= MEDIUM_CONFIDENCE_THRESHOLD ? 'medium' :
    top.score >= LOW_CONFIDENCE_THRESHOLD ? 'low' : null;

  if (!confidence) {
    return {
      ok: false,
      error_class: 'all_candidates_rejected',
      error_message: `top-ranked candidate ${top.url} scored ${top.score}; below confidence threshold (Q2: fail rather than guess)`,
      candidates_considered,
    };
  }

  return {
    ok: true,
    url: top.url,
    confidence,
    candidates_considered,
    notes: `${top.tld_reason}; name-match score ${top.score}`,
  };
}

/**
 * Construct plausible .bank.in URLs from the bank's canonical slug + name.
 * Returns most-likely first.
 */
function bankInVariants(slug, bankName) {
  const out = [];
  // 1. Full slug — most common for explicitly RBI-aligned banks
  out.push(`https://${slug}.bank.in`);
  // 2. Common abbreviations: drop -limited, -ltd, -bank, -co-operative suffixes
  const stripped = slug
    .replace(/-bank-limited$/, '')
    .replace(/-bank-ltd\.?$/, '')
    .replace(/-bank$/, '')
    .replace(/-limited$/, '')
    .replace(/-ltd\.?$/, '');
  if (stripped !== slug && stripped.length > 2) {
    out.push(`https://${stripped}.bank.in`);
  }
  // 3. First-word abbreviation. "State Bank of India" → "sbi" (Bank is meaningful
  // here). HDFC Bank Limited → "hbl" too, but acronym tries are only candidates
  // — head-check will filter out the wrong ones.
  const acronym = bankName
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !['limited', 'ltd', 'of', 'and', 'the', 'co', 'operative'].includes(w.toLowerCase()))
    .map((w) => w[0].toLowerCase())
    .join('');
  if (acronym.length >= 2 && acronym.length <= 6) {
    out.push(`https://${acronym}.bank.in`);
  }
  return out;
}

/**
 * Rank web-search candidates. Score = TLD score + name-match score.
 * Rejects aggregator domains outright.
 */
function rankCandidates(searchResults, bankName, slug) {
  const out = [];
  for (const r of searchResults) {
    let url;
    try { url = new URL(r.url); }
    catch { continue; }
    const host = url.hostname.replace(/^www\./, '');

    if (isAggregator(host)) continue;

    let score = 0;
    let tld_reason = 'unknown TLD';
    for (const t of TLD_PRIORITY) {
      if (host.endsWith(t.suffix)) {
        score = t.score;
        tld_reason = t.reason;
        break;
      }
    }
    // Bonus: hostname contains the slug or a substring of it
    const hostNoTld = host.replace(/\.(bank\.in|co\.in|com|org|in)$/, '');
    if (hostNoTld === slug) score += 30;
    else if (slug.includes(hostNoTld) && hostNoTld.length >= 3) score += 20;
    else if (bankName.toLowerCase().includes(hostNoTld) && hostNoTld.length >= 3) score += 15;

    out.push({ url: `https://${host}`, host, score, tld_reason });
  }
  // Dedup by host, keeping highest score.
  const dedup = new Map();
  for (const c of out) {
    const prev = dedup.get(c.host);
    if (!prev || c.score > prev.score) dedup.set(c.host, c);
  }
  return [...dedup.values()].sort((a, b) => b.score - a.score);
}

function isAggregator(host) {
  if (AGGREGATOR_DOMAINS.has(host)) return true;
  // Catch subdomains of aggregators (e.g., m.bankbazaar.com)
  for (const a of AGGREGATOR_DOMAINS) {
    if (host.endsWith('.' + a)) return true;
  }
  return false;
}

/**
 * Web-search via Bing (if BING_SEARCH_API_KEY) or Azure OpenAI Responses
 * (if AZURE_OPENAI_ENDPOINT). Falls through to empty results when neither
 * is configured.
 */
async function webSearchCandidates(query, logger) {
  const bingKey = process.env.BING_SEARCH_API_KEY;
  if (bingKey) {
    return bingSearchCandidates(query, bingKey);
  }
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) {
    return responsesSearchCandidates(query, logger);
  }
  return [];
}

async function bingSearchCandidates(query, apiKey) {
  const endpoint = process.env.BING_SEARCH_ENDPOINT || 'https://api.bing.microsoft.com/v7.0/search';
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('count', '10');
  url.searchParams.set('mkt', 'en-IN');
  url.searchParams.set('responseFilter', 'Webpages');
  const res = await httpRequest(url.toString(), 'GET', {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    timeoutMs: 15000,
  });
  const data = JSON.parse(res.body);
  return (data.webPages?.value || []).map((v) => ({ url: v.url, snippet: v.snippet || '', source: 'bing' }));
}

async function responsesSearchCandidates(query, logger) {
  try {
    const { createResponsesClient, searchWithResponses } = require('../azure-openai-responses');
    const client = createResponsesClient();
    const result = await searchWithResponses(client, query, {
      country: 'IN',
      logger: logger ? (logger.warn ? logger.warn.bind(logger) : undefined) : undefined,
    });
    return (result.citations || []).map((c) => ({ url: c.url, snippet: c.title || '', source: 'aoai-responses' }));
  } catch (err) {
    if (logger?.warn) logger.warn(`find_website: Responses API search failed: ${err.message}`);
    return [];
  }
}

function ensureScheme(domainOrUrl) {
  if (domainOrUrl.startsWith('http://') || domainOrUrl.startsWith('https://')) return domainOrUrl;
  return 'https://' + domainOrUrl;
}

module.exports = {
  findWebsite,
  _bankInVariants: bankInVariants,
  _rankCandidates: rankCandidates,
  _isAggregator: isAggregator,
  AGGREGATOR_DOMAINS,
  TLD_PRIORITY,
};
