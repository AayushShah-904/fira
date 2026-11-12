'use strict';

/**
 * Action: classify_rate_page — Sprint 003 A2b contract.
 *
 * Given a rate-page URL, classify its rendering kind:
 *   - html_static — table data present in the raw HTML response
 *   - html_js     — React/Angular/Vue scaffolding; rates not in raw HTML
 *   - pdf         — Content-Type application/pdf or .pdf extension
 *   - image       — Content-Type image/* or recognised image extension
 *
 * Operates deterministically; no LLM. Mode parameter (per Q4 answer) lets
 * the orchestrator skip the HEAD fetch on recheck when a cached kind is
 * still trustworthy.
 *
 * Input:
 *   {
 *     url: string,
 *     mode: "discover" | "recheck",
 *     hints?: { cached_kind?: "html_static"|"html_js"|"pdf"|"image" },
 *   }
 *
 * Output (success):
 *   {
 *     ok: true,
 *     kind: "html_static"|"html_js"|"pdf"|"image",
 *     confidence: "high"|"medium"|"low",
 *     evidence: string,
 *     mode_used: "discover"|"recheck_hit"|"recheck_invalidated",
 *   }
 *
 * Output (failure):
 *   { ok: false, error_class: "fetch_failed"|"ambiguous_after_full_fetch"|"tool_error", error_message: string }
 */

const { httpRequest } = require('./_http');

const VALID_MODES = new Set(['discover', 'recheck']);
const VALID_KINDS = new Set(['html_static', 'html_js', 'pdf', 'image']);

/** HEAD request limit (bytes) for content sniff after a non-conclusive HEAD. */
const FIRST_FETCH_BYTES = 4096;
const FULL_FETCH_BYTES = 32 * 1024;

async function classifyRatePage(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('classifyRatePage: input must be an object');
  }
  const { url, mode, session } = input;
  let { hints } = input;
  if (!url || typeof url !== 'string') throw new Error('classifyRatePage: input.url is required');
  if (!VALID_MODES.has(mode)) {
    throw new Error(`classifyRatePage: input.mode must be one of ${[...VALID_MODES].join(', ')} (got "${mode}")`);
  }
  // hints.cached_kind comes from bank-domains.json `scraper_type`, which is a
  // bank-level rollup. Values like "mixed" / "government" / "manual" describe
  // the *bank* (different products use different renderers), not a single URL.
  // Since classify_rate_page operates per-URL, an unrecognised cached_kind
  // means "no useful hint" — drop it and proceed with live discovery rather
  // than aborting the whole step.
  if (hints?.cached_kind && !VALID_KINDS.has(hints.cached_kind)) {
    hints = { ...hints, cached_kind: null };
  }

  // Quick-win short-circuits on URL alone.
  const lower = url.toLowerCase();
  if (lower.endsWith('.pdf') || /\.pdf(?:\?|$)/i.test(url)) {
    return { ok: true, kind: 'pdf', confidence: 'high', evidence: 'URL ends with .pdf', mode_used: 'discover' };
  }
  if (/\.(jpg|jpeg|png|webp|gif|bmp)(?:\?|$)/i.test(url)) {
    return { ok: true, kind: 'image', confidence: 'high', evidence: 'URL has image extension', mode_used: 'discover' };
  }

  // Phase 4 cached_body path: the orchestrator prefetched the page via the
  // per-bank Playwright session and is handing us the rendered HTML + the
  // observed Content-Type. Skip the HEAD/GET sniffs entirely and classify
  // from what we already have. This eliminates 1-2 redundant fetches per
  // (bank, product) and reuses the same body downstream in extract.
  if (typeof hints?.cached_body === 'string' && hints.cached_body.length > 0) {
    const ct = String(hints.cached_content_type || '').toLowerCase();
    // Content-Type wins immediately for binary formats.
    if (ct.includes('application/pdf')) {
      return finalize(mode, hints, { kind: 'pdf', confidence: 'high', evidence: `cached Content-Type: ${ct}` });
    }
    if (ct.startsWith('image/')) {
      return finalize(mode, hints, { kind: 'image', confidence: 'high', evidence: `cached Content-Type: ${ct}` });
    }
    if (mode === 'recheck' && hints.cached_kind) {
      if (cachedKindMatchesContentType(hints.cached_kind, ct)) {
        return {
          ok: true,
          kind: hints.cached_kind,
          confidence: 'high',
          evidence: `recheck cached_body; Content-Type=${ct || 'unspecified'} consistent with cached kind`,
          mode_used: 'recheck_hit',
        };
      }
    }
    const verdict = sniffHtml(hints.cached_body);
    if (verdict.kind) {
      return finalize(mode, hints, { ...verdict, evidence: `cached_body: ${verdict.evidence}` });
    }
    // Body present but sniff inconclusive. Prefer trusting cached_kind when
    // we have one (e.g., html_js page where the rate widget didn't make it
    // into the static `<table>` heuristic). Otherwise fall through to the
    // live-fetch path as a safety net.
    if (hints.cached_kind) {
      return finalize(mode, hints, {
        kind: hints.cached_kind,
        confidence: 'medium',
        evidence: `cached_body inconclusive; trusting cached_kind="${hints.cached_kind}"`,
      });
    }
    // Fall through to the live-fetch path. Unlikely on real bank pages
    // but covers truncated/empty cached_body edge cases.
  }

  // recheck mode: HEAD only; trust cached_kind if URL still resolves and Content-Type doesn't contradict.
  if (mode === 'recheck' && hints?.cached_kind) {
    try {
      const head = await httpRequest(url, 'HEAD', { tolerant: true, session });
      if (head.statusCode >= 200 && head.statusCode < 400) {
        const ct = (head.headers['content-type'] || '').toLowerCase();
        // If Content-Type confirms or is ambiguous (text/html), trust the cached kind.
        if (cachedKindMatchesContentType(hints.cached_kind, ct)) {
          return {
            ok: true,
            kind: hints.cached_kind,
            confidence: 'high',
            evidence: `recheck HEAD ${head.statusCode}; Content-Type=${ct || 'unspecified'} consistent with cached kind`,
            mode_used: 'recheck_hit',
          };
        }
        // Otherwise fall through to discover semantics; tag mode_used appropriately.
      }
    } catch {
      // HEAD failures fall through to discover.
    }
  }

  // discover (or recheck-invalidated): GET with byte limit and sniff.
  let body;
  let contentType;
  try {
    const res = await httpRequest(url, 'GET', { maxBytes: FIRST_FETCH_BYTES, tolerant: true, session });
    body = res.body;
    contentType = (res.headers['content-type'] || '').toLowerCase();
    if (res.statusCode >= 400) {
      // WAF / bot-protection often returns 403 to bare Node GETs even when
      // the page works fine in a browser. If the caller already provided a
      // cached_kind from bank-domains.json, trust it — downstream extraction
      // (Playwright for html_js) will succeed via the browser stack.
      if (hints?.cached_kind) {
        return finalize(mode, hints, {
          kind: hints.cached_kind,
          confidence: 'medium',
          evidence: `HTTP ${res.statusCode}; trusting hints.cached_kind="${hints.cached_kind}" from bank-domains.json (likely WAF rejecting Node UA)`,
        });
      }
      return { ok: false, error_class: 'fetch_failed', error_message: `HTTP ${res.statusCode}` };
    }
  } catch (err) {
    if (hints?.cached_kind) {
      return finalize(mode, hints, {
        kind: hints.cached_kind,
        confidence: 'medium',
        evidence: `fetch threw "${err.message}"; trusting hints.cached_kind="${hints.cached_kind}" from bank-domains.json`,
      });
    }
    return { ok: false, error_class: 'fetch_failed', error_message: err.message };
  }

  // Content-Type wins immediately for binary formats.
  if (contentType.includes('application/pdf')) {
    return finalize(mode, hints, { kind: 'pdf', confidence: 'high', evidence: `Content-Type: ${contentType}` });
  }
  if (contentType.startsWith('image/')) {
    return finalize(mode, hints, { kind: 'image', confidence: 'high', evidence: `Content-Type: ${contentType}` });
  }

  // HTML body — sniff for rate-bearing <table> vs JS scaffolding.
  const verdict = sniffHtml(body);
  if (verdict.kind) {
    return finalize(mode, hints, verdict);
  }

  // Ambiguous in 4KB — fetch a bigger window and re-sniff.
  try {
    const res = await httpRequest(url, 'GET', { maxBytes: FULL_FETCH_BYTES, tolerant: true, session });
    const verdict2 = sniffHtml(res.body);
    if (verdict2.kind) {
      return finalize(mode, hints, verdict2);
    }
    return { ok: false, error_class: 'ambiguous_after_full_fetch', error_message: `no rate-table or JS root after ${FULL_FETCH_BYTES} bytes` };
  } catch (err) {
    return { ok: false, error_class: 'tool_error', error_message: err.message };
  }
}

function finalize(mode, hints, verdict) {
  const mode_used = mode === 'recheck' && hints?.cached_kind && hints.cached_kind !== verdict.kind
    ? 'recheck_invalidated'
    : 'discover';
  return { ok: true, mode_used, ...verdict };
}

/**
 * Decide whether a cached_kind is plausible given an observed Content-Type.
 * Conservative: only confirm if explicit; ambiguous Content-Type (e.g.,
 * text/html when cached_kind is html_js) doesn't disqualify.
 */
function cachedKindMatchesContentType(cachedKind, contentType) {
  if (!contentType) return true;
  if (cachedKind === 'pdf') return contentType.includes('application/pdf');
  if (cachedKind === 'image') return contentType.startsWith('image/');
  // html_static / html_js — both report text/html
  if (cachedKind === 'html_static' || cachedKind === 'html_js') {
    return contentType.includes('text/html') || contentType.includes('application/xhtml');
  }
  return false;
}

/**
 * Sniff an HTML chunk for evidence of static vs JS-rendered rates.
 * Returns { kind, confidence, evidence } or {} if inconclusive.
 */
function sniffHtml(html) {
  const lower = html.toLowerCase();

  // html_static signal: <table>...<tr>...<td>...<digits>.<digits>...
  const tableMatch = /<table[^>]*>[\s\S]{0,8000}?<tr[^>]*>[\s\S]{0,2000}?<td[^>]*>[\s\S]{0,800}?\d+\.\d/i.test(html);
  if (tableMatch) {
    return { kind: 'html_static', confidence: 'high', evidence: '<table> with <tr><td> containing rate-shaped digits' };
  }

  // html_js signal: framework markers — React root, ng-app, Vue mount, Next.js __next
  const jsMarkers = [
    /<div\s+id=["']?root["']?/i,        // React
    /<div\s+id=["']?__next["']?/i,       // Next.js
    /<div\s+id=["']?app["']?/i,          // Vue
    /\bng-app=/i,                        // Angular 1.x
    /\bdata-reactroot\b/i,
    /\bwindow\.__NEXT_DATA__\b/i,
  ];
  for (const re of jsMarkers) {
    if (re.test(html)) {
      return { kind: 'html_js', confidence: 'medium', evidence: `JS framework marker matched (${re.source.slice(0, 40)})` };
    }
  }

  // Heuristic: low text-density HTML with many <script> tags and no <table>
  const scriptCount = (lower.match(/<script[^>]*>/g) || []).length;
  const tableCount = (lower.match(/<table[^>]*>/g) || []).length;
  if (tableCount === 0 && scriptCount >= 3) {
    return { kind: 'html_js', confidence: 'low', evidence: `no <table>; ${scriptCount} <script> tags suggest JS-rendered page` };
  }

  return {};
}

module.exports = {
  classifyRatePage,
  // Exposed for unit testing.
  _sniffHtml: sniffHtml,
  _cachedKindMatchesContentType: cachedKindMatchesContentType,
};
