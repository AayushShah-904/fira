'use strict';

/**
 * Action: find_rate_page — Sprint 003 A2 contract.
 *
 * Given a bank's homepage URL and a target product (fd / fd_nre / fd_nro /
 * fd_fcnr / savings / rd), locate the rate page URL by:
 *   1. NRI-eligibility check (cooperative banks / RRBs / Payments Banks
 *      don't offer NRI products per docs/agent/nri-gift-ibu.md).
 *   2. Trying `hints.cached_path` if provided (recheck mode).
 *   3. Fetching the homepage, parsing anchor links, ranking by product-name
 *      patterns.
 *   4. Falling back to common path patterns if anchor parsing fails.
 *
 * Returns URL only. Kind classification is the separate `classify_rate_page`
 * action (A2b) per Q3.
 *
 * Output (success):
 *   { ok: true, url, confidence, notes?, mode_used: "discover"|"recheck_hit"|"recheck_fell_back_to_discover" }
 * Output (failure):
 *   { ok: false, error_class: "no_link_found"|"not_applicable"|"fetch_failed"|"tool_error", error_message }
 */

const { httpRequest } = require('./_http');

const VALID_PRODUCTS = new Set(['fd', 'fd_nre', 'fd_nro', 'fd_fcnr', 'fd_nri_combined', 'fd_gift', 'savings', 'rd']);
const VALID_MODES = new Set(['discover', 'recheck']);

/** Bank types that don't offer NRI products (per docs/agent/nri-gift-ibu.md). */
const NO_NRI_BANK_TYPES = new Set([
  'SUCB', 'NSUCB', 'SSCB', 'NSSCB', 'DCCB',   // cooperative banks
  'RRB',                                       // regional rural banks
  'PB',                                        // payments banks
  'LAB',                                       // local area banks (mostly)
]);

const NRI_PRODUCTS = new Set(['fd_nre', 'fd_nro', 'fd_fcnr', 'fd_nri_combined']);

/** Patterns ranked by product. Each entry is { regex, score } — score breaks ties. */
const PRODUCT_PATTERNS = {
  fd: [
    { regex: /\b(fixed\s*deposit|fd|term\s*deposit|domestic\s*term\s*deposit|deposit\s*rates?)\b/i, score: 100 },
    { regex: /\binterest\s*rates?\b/i, score: 60 },
    { regex: /\brates?(?:[\-\s]+charges?)?\b/i, score: 40 },
  ],
  fd_nre: [
    { regex: /\bnre\s*(?:term\s*deposit|fd|deposit)?\b/i, score: 100 },
    { regex: /\bnon[\-\s]?resident\s*external\b/i, score: 90 },
    { regex: /\bnri\s*(?:term\s*deposit|fd|deposit)\b/i, score: 60 },
  ],
  fd_nro: [
    { regex: /\bnro\s*(?:term\s*deposit|fd|deposit)?\b/i, score: 100 },
    { regex: /\bnon[\-\s]?resident\s*(?:ordinary|rupee)\b/i, score: 90 },
  ],
  fd_fcnr: [
    { regex: /\bfcnr(?:[\-\s]?b)?\b/i, score: 100 },
    { regex: /\bforeign\s+currency\s+non[\-\s]?resident\b/i, score: 100 },
  ],
  fd_nri_combined: [
    { regex: /\bnri\s*(?:banking|deposits?|fixed\s*deposit)\b/i, score: 80 },
    { regex: /\bnon[\-\s]?resident\s+banking\b/i, score: 70 },
  ],
  fd_gift: [
    // IBU rate pages. GIFT City IFSC is the regulatory zone; "IFSC banking unit"
    // is the formal name. Foreign-currency deposits, no INR.
    { regex: /\bgift\s*(?:city|ifsc)\b/i, score: 100 },
    { regex: /\bifsc\s*banking\s*unit\b/i, score: 100 },
    { regex: /\bibu\b/i, score: 80 },
    { regex: /\binternational\s*banking\s*unit\b/i, score: 80 },
  ],
  savings: [
    { regex: /\bsavings?\s*(?:account|deposit|bank)\b/i, score: 100 },
    { regex: /\bsb\s*account\b/i, score: 60 },
  ],
  rd: [
    { regex: /\brecurring\s*deposit\b/i, score: 100 },
    { regex: /\brd\s*account\b/i, score: 60 },
  ],
};

/** Common URL path patterns for fallback when anchor parsing returns nothing. */
const PATH_PATTERNS = {
  fd: ['/interest-rates', '/interest-rate', '/fixed-deposit-rates', '/fd-rates', '/deposit-rates', '/rates-and-charges'],
  fd_nre: ['/nre-deposits', '/nre-fixed-deposit', '/nre-interest-rates', '/nri-banking/nre'],
  fd_nro: ['/nro-deposits', '/nro-fixed-deposit', '/nro-interest-rates', '/nri-banking/nro'],
  fd_fcnr: ['/fcnr-deposits', '/fcnr-rates', '/foreign-currency-deposits'],
  fd_nri_combined: ['/nri-deposits', '/nri-interest-rates', '/nri-banking'],
  fd_gift: ['/gift-ifsc/', '/ifsc-banking/', '/international-banking/gift-city/', '/ibu/deposit-rates', '/ibu/interest-rates'],
  savings: ['/savings-account', '/savings-deposit'],
  rd: ['/recurring-deposit', '/rd-rates'],
};

async function findRatePage(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('findRatePage: input must be an object');
  }
  const { domain, product, mode, hints, session } = input;
  if (!domain || typeof domain !== 'string') throw new Error('findRatePage: input.domain is required (homepage URL)');
  if (!VALID_PRODUCTS.has(product)) {
    throw new Error(`findRatePage: input.product must be one of ${[...VALID_PRODUCTS].join(', ')} (got "${product}")`);
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(`findRatePage: input.mode must be one of ${[...VALID_MODES].join(', ')} (got "${mode}")`);
  }

  // NRI-eligibility gate.
  if (NRI_PRODUCTS.has(product) && hints?.bank_type && NO_NRI_BANK_TYPES.has(hints.bank_type)) {
    return {
      ok: false,
      error_class: 'not_applicable',
      error_message: `bank_type "${hints.bank_type}" does not offer NRI products per docs/agent/nri-gift-ibu.md`,
    };
  }

  // recheck mode: try the cached path first
  if (mode === 'recheck' && hints?.cached_path) {
    const cachedFull = absoluteUrl(domain, hints.cached_path);
    let headStatus = null;
    try {
      const res = await httpRequest(cachedFull, 'HEAD', { tolerant: true, session });
      headStatus = res.statusCode;
      if (res.statusCode >= 200 && res.statusCode < 400) {
        return {
          ok: true,
          url: cachedFull,
          confidence: 'high',
          notes: `recheck HEAD ${res.statusCode} on cached_path`,
          mode_used: 'recheck_hit',
        };
      }
    } catch (err) {
      headStatus = `error:${err.message}`;
    }
    // HEAD failed (403, ECONNRESET, etc.) — WAF-protected sites commonly
    // reject bare Node requests. The cached_path is hand-curated authoritative
    // data; trust it with medium confidence so downstream Playwright fetch
    // gets a chance at the real page.
    return {
      ok: true,
      url: cachedFull,
      confidence: 'medium',
      notes: `recheck HEAD failed (${headStatus}); trusting cached_path from bank-domains.json. Downstream Playwright should fetch successfully.`,
      mode_used: 'recheck_cache_only',
    };
  }

  // discover: fetch homepage, parse anchors.
  let homepageHtml;
  try {
    // No `tolerant: true` here — we want session to take over on WAF-protected
    // homepages (HDFC, AU SFB, BOI-IBU). If TLS-chain issues bite a small
    // cooperative bank, the auto-fallback in _http.js retries on Node HTTP
    // (without tolerant); the cached_path branch above is the primary
    // safety net for such banks anyway.
    //
    // Sprint 4 A7: bumped 200KB → 2MB to match _http.js DEFAULT_MAX_BYTES.
    // Equitas (539 KB) and Citi (2.7 MB) homepages had rate-page anchors
    // past 200 KB, so the discover pass returned 0 candidates and every
    // variant fell through to "rate_page_not_found". A larger cap is
    // safe — rankAnchors is score-based and the top-scoring anchor at
    // 200 KB stays the top-scoring anchor at 2 MB on banks that already
    // worked (smoke-a123 baseline holds 4/5 banks exactly).
    const res = await httpRequest(domain, 'GET', { maxBytes: 2 * 1024 * 1024, session });
    if (res.statusCode >= 400) {
      return { ok: false, error_class: 'fetch_failed', error_message: `HTTP ${res.statusCode} on homepage` };
    }
    homepageHtml = res.body;
  } catch (err) {
    return { ok: false, error_class: 'fetch_failed', error_message: err.message };
  }

  const anchors = extractAnchors(homepageHtml);
  const ranked = rankAnchors(anchors, product);

  if (ranked.length > 0) {
    const top = ranked[0];
    const fullUrl = absoluteUrl(domain, top.href);
    return {
      ok: true,
      url: fullUrl,
      confidence: top.score >= 100 ? 'high' : (top.score >= 60 ? 'medium' : 'low'),
      notes: `anchor "${top.text}" matched pattern (score=${top.score})`,
      mode_used: mode === 'recheck' ? 'recheck_fell_back_to_discover' : 'discover',
    };
  }

  // Fallback: try common path patterns. HEAD-check each; first 2xx wins.
  for (const path of (PATH_PATTERNS[product] || [])) {
    const candidate = absoluteUrl(domain, path);
    try {
      const res = await httpRequest(candidate, 'HEAD', { tolerant: true, session });
      if (res.statusCode >= 200 && res.statusCode < 400) {
        return {
          ok: true,
          url: candidate,
          confidence: 'low',
          notes: `path-pattern fallback (anchor parsing found no match)`,
          mode_used: mode === 'recheck' ? 'recheck_fell_back_to_discover' : 'discover',
        };
      }
    } catch {
      // Try the next pattern.
    }
  }

  return {
    ok: false,
    error_class: 'no_link_found',
    error_message: `no anchor matched product "${product}" patterns and no path-pattern returned 2xx`,
  };
}

/**
 * Extract <a href="..."> ... </a> pairs from raw HTML. Returns
 * [{ href, text }] with text whitespace-collapsed and HTML-stripped.
 */
function extractAnchors(html) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    const text = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (href && text) out.push({ href, text });
  }
  return out;
}

/**
 * Rank anchors by how well they match the product's regex patterns.
 * Returns sorted [{ href, text, score }] best-first. Empty array if nothing matches.
 */
function rankAnchors(anchors, product) {
  const patterns = PRODUCT_PATTERNS[product] || [];
  if (patterns.length === 0) return [];
  const scored = [];
  for (const a of anchors) {
    let bestScore = 0;
    for (const p of patterns) {
      if (p.regex.test(a.text) || p.regex.test(a.href)) {
        if (p.score > bestScore) bestScore = p.score;
      }
    }
    if (bestScore > 0) scored.push({ ...a, score: bestScore });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Resolve a possibly-relative href against a base URL. */
function absoluteUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

module.exports = {
  findRatePage,
  // Exposed for unit testing.
  _extractAnchors: extractAnchors,
  _rankAnchors: rankAnchors,
  _absoluteUrl: absoluteUrl,
  NO_NRI_BANK_TYPES,
  PRODUCT_PATTERNS,
};
