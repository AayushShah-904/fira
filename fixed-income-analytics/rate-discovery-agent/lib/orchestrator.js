'use strict';

/**
 * Per-bank rate-discovery orchestrator — Sprint 003 #1c.
 *
 * Per Q13 (operator-answered): deterministic Node code that walks a fixed
 * action sequence. LLM is invoked only INSIDE specific actions
 * (`find_website`, A2's anchor-link interpretation when configured, and a
 * future LLM-fallback path in `extract_html_table`). The orchestrator
 * itself makes no LLM calls.
 *
 * Sequence (per action-contracts.md "Orchestrator shape"):
 *   1. find_website(bank_name, bank_type, state, hints)
 *   2. on success → commit_to_registry({ domain, confidence })
 *   3. for each applicable product (regular always; NRE/NRO/FCNR if eligible):
 *      a. find_rate_page(domain, product, mode)
 *      b. classify_rate_page(url, mode)
 *      c. extract via the kind-appropriate action:
 *         - html_static / html_js → extract_html_table
 *         - pdf                   → extract_pdf_table
 *         - image                 → extract_via_vision
 *      d. on slabs → commit_rates(bank_code, variant, payload, extraction_method)
 *   4. classify_outcome(bank_code, run_dir, signals)
 *
 * Returns a per-bank summary the caller can persist into a summary.json.
 *
 * The orchestrator is "good citizen": every action call is wrapped, errors
 * become structured `phase_events`, and a missing/disabled action (e.g.,
 * vision without AOAI configured) returns null cleanly and the flow
 * continues to the next variant without halting.
 */

const path = require('node:path');

const { findWebsite }        = require('./actions/find_website');
const { findRatePage }       = require('./actions/find_rate_page');
const { fetchPage }          = require('./actions/fetch_page');
const { classifyRatePage }   = require('./actions/classify_rate_page');
const { extractHtmlTable }   = require('./actions/extract_html_table');
const { extractPdfTable }    = require('./actions/extract_pdf_table');
const { extractViaVision }   = require('./actions/extract_via_vision');
const { extractViaOcr }      = require('./actions/extract_via_ocr');
const { classifyOutcome }    = require('./actions/classify_outcome');
const { commitToRegistry }   = require('./actions/commit_to_registry');
const { commitConfig }       = require('./actions/commit_config');
const { commitRates }        = require('./actions/commit_rates');
const { createSession }      = require('./actions/_playwright_session');

const { slugify: canonicalSlugify } = require('../scripts/utils/slugify');
// M2.6 (sprint-004 2026-05-21): per-URL hint resolver. When a bank's
// extraction.<key> declares fulfills_product, use that PDF URL instead
// of the HTML landing page for the relevant product.
const { findHintedPdfUrl, findHintedHtmlUrl, findHintedOcrUrl } = require('./extraction-hint');
// Phase 2 (production-pipeline-architecture 2026-10-03): dynamic PDF discovery.
// When a bank's extraction.<key>.pdf_discovery block is present, the pre-flight
// module scans the HTML landing page at runtime to find the live PDF URL —
// instead of relying on a hardcoded date-stamped filename in the registry.
const { discoverPdfUrl } = require('./preflight-pdf-finder');
// Phase 3 (production-pipeline-architecture 2026-10-03): custom parser adapters.
// Strategy pattern: when a bank's extraction hint declares "custom_parser": "<key>",
// the orchestrator routes the HTML to lib/parsers/<key>-parser.js instead of the
// generic extract_html_table action.
const { runCustomParser, hasCustomParser } = require('./parsers/index');



/**
 * Default action bindings. Tests may override any subset via `input.actions`.
 * Useful for: (a) mocked unit tests of the orchestrator's sequencing logic
 * without spinning up real HTML fetches / LLM calls, (b) future selective
 * substitution (e.g., swap extract_via_vision for a cheaper variant during
 * cost experiments). Production callers omit `input.actions` and get the
 * defaults below.
 */
const DEFAULT_ACTIONS = {
  findWebsite,
  findRatePage,
  fetchPage,
  classifyRatePage,
  extractHtmlTable,
  extractPdfTable,
  extractViaVision,
  extractViaOcr,
  classifyOutcome,
  commitToRegistry,
  commitConfig,
  commitRates,
  // Phase 3 of option A+C: a per-bank Playwright session whose `fetch` is
  // routed via `_http.js`'s `session` option. Tests substitute a mock via
  // `actions: { createSession: async () => mockSession() }`.
  createSession,
};

/** Banks eligible to be queried for retail NRI products (NRE/NRO/FCNR). */
const LARGE_SFBS = new Set(['au-small-finance-bank-limited', 'equitas-small-finance-bank-limited', 'ujjivan-small-finance-bank-limited', 'idfc-first-bank-limited', 'bandhan-bank-limited']);

function shouldQueryNri(bankType, bankCode) {
  if (['PSB', 'PVB', 'FB'].includes(bankType)) return true;
  if (bankType === 'SFB' && LARGE_SFBS.has(bankCode)) return true;
  return false;
}

/**
 * Decide which products this bank should be queried for.
 *
 * - IBU (IFSC Banking Unit in GIFT City): foreign-currency deposits only,
 *   no domestic FD and no retail NRE/NRO/FCNR. Single product `fd_gift`
 *   that produces `gift` variant slabs with `currency` per slab.
 * - PSB / PVB / FB / large SFB: domestic FD plus retail NRI variants.
 * - Co-op / RRB / PB / LAB / small SFB: domestic FD only.
 */
function productsForBank(bankType, bankCode) {
  if (bankType === 'IBU') return ['fd_gift'];
  const out = ['fd'];
  if (shouldQueryNri(bankType, bankCode)) out.push('fd_nre', 'fd_nro', 'fd_fcnr');
  return out;
}

const PRODUCT_TO_VARIANT = {
  fd: 'regular',
  fd_nre: 'nre',
  fd_nro: 'nro',
  fd_fcnr: 'fcnr',
  fd_gift: 'gift',
};

/**
 * Sprint 011 item 18 (2026-07-06): products explicitly configured in the
 * bank's registry entry — a truthy `rate_pages.<product>` URL, or an
 * `extraction.<key>` hint whose `fulfills_product` names the product.
 * Configured products are authoritative regardless of bank_type resolution:
 * the 2026-06-15 Axis FCNR miss happened because no registry entry carries
 * `category`, so a bare `--rates-only` run derived bank_type=UNKNOWN,
 * productsForBank returned ['fd'], and the curated fd_nre/fd_nro/fd_fcnr
 * URLs in bank-domains.json were never visited.
 */
function configuredProductsFromHints(hints) {
  const out = new Set();
  const rp = (hints && hints.cached_rate_pages) || {};
  for (const p of Object.keys(PRODUCT_TO_VARIANT)) {
    if (typeof rp[p] === 'string' && rp[p]) out.add(p);
  }
  const ex = (hints && hints.cached_extraction) || {};
  for (const hint of Object.values(ex)) {
    if (!hint || typeof hint !== 'object') continue;
    const fp = hint.fulfills_product;
    const list = Array.isArray(fp) ? fp : (typeof fp === 'string' ? [fp] : []);
    for (const p of list) {
      if (PRODUCT_TO_VARIANT[p]) out.add(p);
    }
  }
  return out;
}

/**
 * Orchestrate one bank end-to-end.
 *
 * @param {object} input
 * @param {string} input.bank_name             — full name from master list
 * @param {string} input.bank_type             — PSB/PVB/SFB/SUCB/...
 * @param {string} [input.state]
 * @param {string} [input.category]            — master-list category; inlined in LLM prompts
 * @param {string} input.output_dir            — output/latest/ for canonical writes
 * @param {string} input.run_dir               — output/runs/<label>/ for per-run summaries + _rejected/
 * @param {string} input.domains_file          — data/bank-domains.json
 * @param {object} [input.hints]               — { cached_domain?, cached_rate_pages?, prefer_llm? }
 * @param {"discover"|"recheck"} [input.mode]  — default "discover"; run-discovery
 *                                              also passes its CLI strings
 *                                              ("rates-only"/"expand-nri") which are
 *                                              normalised to "discover" at the action boundary
 * @param {string[]} [input.only_products]     — Sprint 011 item 18: allowlist of products
 *                                              (fd/fd_nre/fd_nro/fd_fcnr/fd_gift) for a
 *                                              targeted single-variant refresh (--variant)
 * @param {object} [input.actions]             — DI for testing: overrides any subset of DEFAULT_ACTIONS
 * @param {object} [input.logger]
 * @returns {Promise<object>} summary with phase_events, classification, and per-variant outcomes
 */
async function orchestrate(input) {
  if (!input || typeof input !== 'object') throw new Error('orchestrate: input must be an object');
  const {
    bank_name,
    state,
    output_dir,
    run_dir,
    domains_file,
    hints = {},
    mode = 'discover',
    logger,
    actions: actionOverrides,
  } = input;
  let { bank_type } = input;
  if (!bank_name) throw new Error('orchestrate: input.bank_name is required');
  if (!output_dir) throw new Error('orchestrate: input.output_dir is required');
  if (!run_dir) throw new Error('orchestrate: input.run_dir is required');
  if (!domains_file) throw new Error('orchestrate: input.domains_file is required');

  // Sprint 010 A2 (2026-06-09): defensive derivation of bank_type from the
  // registry when caller didn't pass one (e.g., a non-CLI caller, or a
  // cohort entry where category lookup failed). run-discovery.js does the
  // same derivation at the CLI layer; this is the safety net so a missing
  // bank_type never crashes the orchestrator. If we still can't derive,
  // we fall through to a sentinel ('UNKNOWN') which downstream actions
  // (find_website + commit_config) accept defensively in Sprint 010 A2.
  if (!bank_type) {
    try {
      const fs = require('node:fs');
      const domains = JSON.parse(fs.readFileSync(domains_file, 'utf-8'));
      const slug = canonicalSlugify(bank_name);
      const entry = domains[slug];
      const cat = entry && entry.category;
      const CATEGORY_TO_TYPE = {
        'Public Sector Bank': 'PSB',
        'Private Sector Bank (Indian)': 'PVB',
        'Private Sector Bank': 'PVB',
        'Small Finance Bank': 'SFB',
        'Payments Bank': 'PB',
        'Foreign Bank': 'FB',
        'Regional Rural Bank': 'RRB',
        'Scheduled Urban Co-operative Bank': 'SUCB',
        'Non-Scheduled Urban Co-operative Bank': 'NSUCB',
        'Scheduled State Co-operative Bank': 'SSCB',
        'Non-Scheduled State Co-operative Bank': 'NSSCB',
        'District Central Co-operative Bank': 'DCCB',
        'Local Area Bank': 'LAB',
        'Financial Institution': 'FI',
        'IFSC Banking Unit (IFSCA)': 'IBU',
        'IFSC Banking Unit': 'IBU',
        'Housing Finance Company': 'HFC',
      };
      bank_type = (cat && CATEGORY_TO_TYPE[cat]) || 'UNKNOWN';
    } catch (_) {
      bank_type = 'UNKNOWN';
    }
  }

  const actions = { ...DEFAULT_ACTIONS, ...(actionOverrides || {}) };
  const bank_code = canonicalSlugify(bank_name);
  const log = wrapLogger(logger);
  const phase_events = [];
  const rejected_dir = path.join(run_dir, '_rejected');
  // Collected AOAI usage records from LLM-using actions (extract_html_table,
  // extract_via_vision). Surfaced in the orchestrator return so run-discovery
  // can roll them into the per-bank cost tracker for total_cost_usd /
  // input_tokens / output_tokens in summary.json.
  const llm_usages = [];
  // Phase 2a: cumulative OCR pages across this run's variants. Returned in
  // the `signals` envelope so run-discovery.js can pass it to the cost-tracker.
  let ocrPagesTotal = 0;

  log.info(`[orchestrator] start bank=${bank_code} type=${bank_type} mode=${mode}`);

  // ── Phase 0: per-bank Playwright session (option A+C Phase 3) ──────
  // One session per orchestrate(), closed in the finally below. WAF-protected
  // sites (HDFC, AU SFB, BOI-IBU homepages) reject plain Node HTTP; routing
  // find_website/find_rate_page/classify_rate_page through a real browser
  // stack gets us past them. RDA_USE_PLAYWRIGHT_SESSION=0 bypasses for a
  // back-out without code revert.
  const useSession = process.env.RDA_USE_PLAYWRIGHT_SESSION !== '0';
  let session = null;
  if (useSession) {
    try {
      session = await actions.createSession({ logger: log });
      log.info('[orchestrator] playwright session created');
    } catch (err) {
      log.warn(`[orchestrator] createSession failed: ${err.message}; continuing with Node HTTP only`);
      session = null;
    }
  }

  try {
  // ── Phase 1: find_website ──────────────────────────────────────────
  const websiteResult = await runStep('find_website', () => actions.findWebsite({
    bank_name, bank_type, state,
    hints: { cached_domain: hints.cached_domain },
    logger: log,
    session,
  }), phase_events, log);

  if (!websiteResult || !websiteResult.ok) {
    log.warn(`[orchestrator] website discovery failed: ${websiteResult?.error_message || 'unknown'}`);
    return await finish(bank_code, run_dir, phase_events, { website_found: false, rate_page_found: false, slabs_extracted_count: 0 }, log, {}, actions);
  }

  const homepage = websiteResult.url;
  log.info(`[orchestrator] website ${homepage} (${websiteResult.confidence})`);

  // ── Phase 2: commit_to_registry (domain) ───────────────────────────
  await runStep('commit_to_registry:domain', () => actions.commitToRegistry({
    bank_code,
    updates: { domain: homepage, confidence: websiteResult.confidence },
    domains_file,
    logger: log,
  }), phase_events, log);

  // ── Phase 3: per-product discovery + extraction + commit ───────────
  // Sprint 011 item 18 (2026-07-06): bank-type defaults alone under-covered
  // multi-URL banks — union in registry-configured products (see
  // configuredProductsFromHints). IBUs excepted: they must stay
  // fd_gift-only per policy even if a stray domestic key exists in the
  // registry; conversely non-IBU banks never pick up fd_gift (GIFT pages
  // belong to the IBU child entry).
  let products = productsForBank(bank_type, bank_code);
  if (bank_type !== 'IBU') {
    const configured = configuredProductsFromHints(hints);
    for (const p of Object.keys(PRODUCT_TO_VARIANT)) {
      if (p !== 'fd_gift' && configured.has(p) && !products.includes(p)) products.push(p);
    }
  }
  // Sprint 011 item 18 (2026-07-06): --variant plumbs a product allowlist
  // through input.only_products for targeted refreshes. Operator intent
  // overrides bank-type policy, so the allowlist is taken verbatim
  // (filtered to known products).
  if (Array.isArray(input.only_products) && input.only_products.length > 0) {
    products = input.only_products.filter((p) => PRODUCT_TO_VARIANT[p]);
    log.info(`[orchestrator] only_products allowlist active: ${products.join(',') || '(none valid)'}`);
  }

  // Sprint 011 item 18 (2026-07-06): run-discovery passes its CLI mode
  // string through verbatim ("rates-only" / "expand-nri"), but
  // find_rate_page and classify_rate_page validate mode against
  // {discover, recheck} and THROW on anything else. runStep swallowed the
  // throw into a failed phase event, so any product without a cached
  // path/kind silently died as rate_page_not_found. Normalise once here:
  // only "recheck" passes through; everything else behaves as "discover".
  const actionMode = mode === 'recheck' ? 'recheck' : 'discover';

  const variantSummary = {};
  let totalSlabs = 0;
  let anyRatePageFound = false;
  // Collected as the variant loop progresses; fed into commit_config below.
  const ratePageUrls = {};
  let scraperTypeForConfig = null;
  // Sprint 011 item 18 (2026-07-06): coverage-guarantee bookkeeping.
  // committedVariants = variants that landed ≥1 slab through commit_rates;
  // mainLoopExtractions = what the main loop already tried per product, so
  // the coverage loop never re-runs a deterministic extractor on the same
  // URL that already yielded zero slabs (same input → same output).
  const committedVariants = new Set();
  const mainLoopExtractions = new Map();

  // Loop-invariant registry view for the per-URL hint resolver (was
  // recomputed per iteration before Sprint 011 item 18; hoisted so the
  // coverage loop below can reuse it).
  const bankEntryForHint = hints.cached_extraction || hints.cached_rate_pages
    ? { domain: hints.cached_domain, rate_pages: hints.cached_rate_pages, extraction: hints.cached_extraction }
    : null;

  // Per-URL response cache shared across the variant loop. Banks like AU SFB
  // map fd/fd_nre/fd_nro to the SAME URL — re-fetching it via Playwright in
  // a tight loop produced flaky empty bodies, which made classify_rate_page
  // fall back to a stale cached scraper_type and extract_html_table fail
  // instantly. Caching the first successful fetch keeps every variant using
  // identical bytes and saves N-1 Playwright navigations per shared URL.
  const fetchedBodyByUrl = new Map();

  // Sprint 011 hint-fallback (2026-07-07): products run through a small work
  // queue instead of a plain for-of so a hinted attempt that dies on a
  // FETCH-class failure (dated PDF URL rolled → HTTP 404) can re-enqueue the
  // same product ONCE with suppress_hint=true — the un-hinted default-rate-
  // page path, exactly as if the registry hint didn't exist. Registry stays
  // untouched; this is runtime-only.
  const productQueue = products.map((product) => ({ product, suppress_hint: false }));
  while (productQueue.length > 0) {
    const { product, suppress_hint } = productQueue.shift();
    const variant = PRODUCT_TO_VARIANT[product];
    let cachedPath = hints.cached_rate_pages?.[product];

    // ── Phase 1: Manual Lock Guard ────────────────────────────────────────
    // If the registry marks this product as extraction_mode=manual_locked,
    // skip automated scraping entirely. The URL is kept in the registry for
    // human reference but the on-disk file is treated as operator-authoritative.
    const extractionMode = hints.cached_extraction_modes?.[product];
    if (extractionMode === 'manual_locked') {
      log.info(`[orchestrator] product=${product} (${variant}): extraction_mode=manual_locked — skipping automated scrape; on-disk data is operator-authoritative`);
      variantSummary[variant] = { status: 'manual_locked', reason: 'extraction_mode=manual_locked in registry' };
      continue;
    }

    // M2.6 (sprint-004 2026-05-21): if the bank declares a PDF hint that
    // fulfills this product (extraction.<key>.fulfills_product === product),
    // prefer the PDF URL over the HTML landing page. This unlocks the
    // multi-column PDF parser (extract_pdf_table + scripts/utils/parse-pdf-rate-lines.js)
    // for banks like Axis where the canonical rate data lives in a 3-page
    // PDF and the HTML landing page is mostly JS shell with sparse rates.
    // Orch-2 (sprint-004 2026-05-21): HTML companion — extends the same
    // fulfills_product mechanism to HTML rate pages, so one HTML URL can
    // fulfill domestic + NRE + NRO when the page itself carries rates for
    // all three (HDFC's /fixed-deposit/fd-interest-rate). PDF wins if both
    // are declared (PDFs are deterministic; HTML can be flaky).
    // Sprint 011 hint-fallback (2026-07-07): a suppress_hint re-run resolves
    // no hints at all — the finders see a null registry entry.
    const hintSource = suppress_hint ? null : bankEntryForHint;

    // ── Phase 2: Dynamic PDF Pre-flight ──────────────────────────────────────
    // If the matched extraction hint declares a `pdf_discovery` block, run the
    // pre-flight scanner to discover the live PDF URL from the HTML landing page
    // at runtime — instead of using a potentially stale hardcoded filename.
    // A successfully discovered URL overrides the registry's static URL so the
    // orchestrator never fetches a renamed/404 PDF.
    if (!suppress_hint && hintSource) {
      const ex = hintSource.extraction || {};
      for (const [hintKey, hint] of Object.entries(ex)) {
        if (!hint || typeof hint !== 'object' || !hint.pdf_discovery) continue;
        const fp = hint.fulfills_product;
        const fulfills = Array.isArray(fp) ? fp : (typeof fp === 'string' ? [fp] : []);
        if (!fulfills.includes(product)) continue;
        // Found a pdf_discovery config that applies to this product — run it
        const liveUrl = await discoverPdfUrl(hint.pdf_discovery, { logger: log });
        if (liveUrl) {
          log.info(`[orchestrator] product=${product}: pre-flight discovered live PDF → ${liveUrl} (key=${hintKey})`);
          cachedPath = liveUrl; // orchestrator will use this instead of any stale registry URL
        } else {
          log.warn(`[orchestrator] product=${product}: pre-flight PDF discovery failed for key=${hintKey} — falling back to static registry URL`);
        }
        break; // only one pdf_discovery block per product
      }
    }

    const hintedPdf = findHintedPdfUrl(hintSource, product);
    const hintedHtml = !hintedPdf ? findHintedHtmlUrl(hintSource, product) : null;
    // M3 (sprint-004 2026-05-22): OCR hint for image-based rate cards
    // (scanned JPGs, image-only PDFs). Routes the extraction through
    // Azure Document Intelligence Layout API.
    const hintedOcr = (!hintedPdf && !hintedHtml) ? findHintedOcrUrl(hintSource, product) : null;
    const hinted = hintedPdf || hintedHtml || hintedOcr;
    if (hinted) {
      const hintKind = hintedPdf ? 'PDF' : (hintedHtml ? 'HTML' : 'OCR');
      log.info(`[orchestrator] product=${product}: using hinted ${hintKind} URL ${hinted.url} (extraction.${hinted.key}) — overriding default rate page`);
      // Only use the static hinted URL if pre-flight didn't already set a live URL
      if (!cachedPath || cachedPath === hinted.url) cachedPath = hinted.url;
    }

    // 3a: find_rate_page. If we already have a cached rate_page URL from
    // bank-domains.json, switch to recheck mode for THIS product so
    // find_rate_page tries the cached path first (HEAD-confirm) before
    // anchor crawl. Critical for WAF-protected sites where plain HTTP
    // anchor crawl gets aborted — the cached URL is authoritative.
    const effectiveMode = cachedPath ? 'recheck' : actionMode;
    const rpResult = await runStep(`find_rate_page:${product}`, () => actions.findRatePage({
      domain: homepage,
      product,
      mode: effectiveMode,
      hints: { cached_path: cachedPath, bank_type },
      session,
    }), phase_events, log);

    if (!rpResult || !rpResult.ok) {
      variantSummary[variant] = { status: 'rate_page_not_found', reason: rpResult?.error_class };
      ratePageUrls[product] = null;
      // Record in registry as explicit null so future passes don't re-attempt
      if (rpResult?.error_class === 'not_applicable' || rpResult?.error_class === 'no_link_found') {
        await runStep(`commit_to_registry:rate_page_null:${product}`, () => actions.commitToRegistry({
          bank_code,
          updates: { rate_pages: { [product]: null } },
          domains_file,
          logger: log,
        }), phase_events, log);
      }
      continue;
    }

    anyRatePageFound = true;
    ratePageUrls[product] = rpResult.url;

    // 3a.5: fetch_page — one full-quality session fetch per (bank, product).
    // The returned body is plumbed into classify (sniff) and extract
    // (cheerio Path A + LLM-fallback bodyForFallback). Phase 4 of option A+C.
    // Skip the prefetch for URLs that classify will short-circuit on
    // extension (PDF, image). For other URLs, even a failed prefetch is
    // tolerable — classify retains its own GET-and-sniff path.
    let cachedBody = null;
    let cachedContentType = null;
    const skipPrefetch = /\.(pdf|jpg|jpeg|png|webp|gif|bmp)(?:\?|$)/i.test(rpResult.url);
    if (!skipPrefetch) {
      // Sprint 4 systemic fix: reuse the body if we already fetched this URL
      // for a previous variant. Same URL → same bytes, no flaky re-fetch.
      const memoised = fetchedBodyByUrl.get(rpResult.url);
      if (memoised) {
        cachedBody = memoised.body;
        cachedContentType = memoised.content_type;
        log.debug?.(`[orchestrator] fetch_page:${product} reused cached body for ${rpResult.url} (${cachedBody.length} bytes)`);
      } else {
        const fetched = await runStep(`fetch_page:${product}`, () => actions.fetchPage({
          url: rpResult.url,
          session,
          logger: log,
        }), phase_events, log);
        if (fetched && fetched.ok && typeof fetched.body === 'string' && fetched.body.length > 0) {
          cachedBody = fetched.body;
          cachedContentType = fetched.content_type || null;
          fetchedBodyByUrl.set(rpResult.url, { body: cachedBody, content_type: cachedContentType });
        }
      }
    }

    // 3b: classify_rate_page. Pass cached scraper_type if bank-domains.json
    // has it — WAF-protected sites abort plain HTTP, so a sniff-fetch fails,
    // but the cache tells us the page kind from a prior successful discovery.
    // When fetch_page populated cachedBody, classify uses it directly and
    // skips its own GET sniffs.
    const cachedKind = hints.cached_scraper_type || null;
    const clsEffectiveMode = cachedKind ? 'recheck' : actionMode;
    const clsResult = await runStep(`classify_rate_page:${product}`, () => actions.classifyRatePage({
      url: rpResult.url,
      mode: clsEffectiveMode,
      hints: {
        cached_kind: cachedKind,
        ...(cachedBody ? { cached_body: cachedBody, cached_content_type: cachedContentType } : {}),
      },
      session,
    }), phase_events, log);

    if (!clsResult || !clsResult.ok) {
      variantSummary[variant] = { status: 'classify_failed', reason: clsResult?.error_class };
      continue;
    }

    // Record the first non-null kind we see — banks use one scraper_type
    // across all variants (e.g., SBI is html_js for fd/fd_nre/fd_nro/fd_fcnr).
    if (!scraperTypeForConfig && clsResult.kind) scraperTypeForConfig = clsResult.kind;

    // Bank-context hints forwarded into LLM-using extractors. The CLAUDE.md
    // path always seeds the model with this; the orchestrator previously
    // dropped it at the action boundary, leaving the model to disambiguate
    // multi-table pages and section headings without knowing what bank it
    // was looking at. See audit 2026-05-17.
    const bankContextHints = {
      bank_name,
      bank_type,
      bank_code,
      state,
      category: input.category,
      scraper_notes: hints.cached_scraper_notes,
      expected_slab_count: hints.cached_expected_slab_count,
      column_mapping: bankEntryForHint?.column_mapping,
      selectors: bankEntryForHint?.selectors,
    };

    // Sprint 011 Fix A follow-on (2026-07-07): per-bank expected-currency
    // override from the registry (extraction.<product>.expected_currencies).
    // emirates-nbd publishes FCNR in USD only — the fleet default of 6
    // currencies made the chunk filter and tagging guards reject a page
    // that is complete for this bank. Registry declares the bank's real
    // currency menu; fleet defaults below remain the fallback.
    const expectedCurrenciesOverride = (() => {
      const o = bankEntryForHint?.extraction?.[product]?.expected_currencies;
      return Array.isArray(o) && o.length > 0 ? o : null;
    })();

    // 3c: extract per kind
    let extraction = null;
    // Sprint 011 item 18 (2026-07-06): which deterministic engine ran, for
    // the coverage loop's duplicate-attempt check ('ocr'|'html'|'pdf'|'vision').
    let extractorUsed = null;
    // M3 (sprint-004 2026-05-22): explicit OCR-hint path. When the registry
    // declares extraction.<key>.type === "image_ocr" for this product, route
    // straight to Azure Document Intelligence Layout regardless of what the
    // classifier returned. Image rate cards may classify as html_static
    // (the page that embeds them) or pdf (image-only PDFs); the hint is
    // authoritative.
    if (hintedOcr) {
      extractorUsed = 'ocr';
      extraction = await runStep(`extract_via_ocr:${product}`, () => actions.extractViaOcr({
        url: rpResult.url,
        product_type: 'FD',
        variant,
        hints: bankContextHints,
        logger: log,
      }), phase_events, log);
    } else if (clsResult.kind === 'html_static' || clsResult.kind === 'html_js') {
      extractorUsed = 'html';

      // ── Phase 3: Custom Parser Adapter check ────────────────────────────
      // If the bank's hint (or its extraction block) declares a custom_parser
      // key, route to the specific parser instead of the generic table reader.
      const customParserKey = hintSource?.extraction?.[hinted?.key]?.custom_parser
        || hintSource?.custom_parser;

      if (customParserKey && hasCustomParser(customParserKey) && cachedBody) {
        log.info(`[orchestrator] product=${product}: using custom parser="${customParserKey}"`);
        const customResult = await runStep(`custom_parser:${customParserKey}:${product}`, async () => {
          const r = await runCustomParser(customParserKey, cachedBody, {
            variant,
            url: rpResult.url,
            logger: log,
          });
          if (!r) return null;
          return { ok: r.slabs.length > 0, slabs: r.slabs, effective_date: r.effective_date, warnings: r.warnings, extraction_method: `custom_parser_${customParserKey}` };
        }, phase_events, log);

        if (customResult && customResult.ok && customResult.slabs.length > 0) {
          extraction = customResult;
          log.info(`[orchestrator] custom parser "${customParserKey}" succeeded: ${customResult.slabs.length} slabs`);
        } else {
          log.warn(`[orchestrator] custom parser "${customParserKey}" returned 0 slabs — falling back to generic extractor`);
          // Fall through to generic extractor below
        }
      }

      // Generic extractor — runs if no custom parser, or if custom parser returned 0 slabs
      if (!extraction || !extraction.ok) {
        extraction = await runStep(`extract_html_table:${product}`, () => actions.extractHtmlTable({
          url: rpResult.url,
          kind: clsResult.kind,
          product_type: 'FD',
          variant,
          // FCNR/GIFT slabs are per-currency; without expected_currencies the
          // extractor refuses to commit (missing_currency rejection). Standard
          // Indian-bank FCNR menu: USD/GBP/EUR/JPY/CAD/AUD. GIFT IBUs are
          // mostly USD-denominated with occasional EUR/GBP.
          hints: {
            ...bankContextHints,
            prefer_llm: !!hints.prefer_llm,
            // Phase 4: re-use the body fetched in 3a.5 to skip the subprocess
            // dispatcher (Path B). HDFC's 1.2 MB pages crash the subprocess;
            // cached_body routes through cheerio Path A AND populates
            // bodyForFallback so the LLM fallback can fire.
            ...(cachedBody ? { cached_body: cachedBody } : {}),
            ...(variant === 'fcnr' ? { expected_currencies: expectedCurrenciesOverride || ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD'] } : {}),
            ...(variant === 'gift' ? { expected_currencies: expectedCurrenciesOverride || ['USD', 'EUR', 'GBP'] } : {}),
          },
          logger: log,
        }), phase_events, log);
      }
    } else if (clsResult.kind === 'pdf') {
      // M2.6 (sprint-004 2026-05-21): when the hint declares a multi-variant
      // PDF (fulfills_product is an array — e.g., NRE+NRO in a single NRI
      // PDF), pass ALL declared variants in `expected.variants` so
      // extract_pdf_table doesn't collapse to the single iteration variant
      // and let the heading-based `variant_inferred` govern per-page.
      // Without this, fd_nre iteration would force-label every page (incl.
      // the NRO page) as nre, and fd_nro iteration would do the same in
      // reverse → both files end up with the union of pages.
      const fp = hinted?.hint?.fulfills_product;
      const expectedVariants = Array.isArray(fp)
        ? fp.map((p) => PRODUCT_TO_VARIANT[p]).filter(Boolean)
        : [variant];
      extractorUsed = 'pdf';
      extraction = await runStep(`extract_pdf_table:${product}`, () => actions.extractPdfTable({
        url: rpResult.url,
        expected: { variants: expectedVariants },
        hints: { ...bankContextHints, bank_code },
        session,
        logger: log,
      }), phase_events, log);
    } else if (clsResult.kind === 'image') {
      extractorUsed = 'vision';
      extraction = await runStep(`extract_via_vision:${product}`, () => actions.extractViaVision({
        url: rpResult.url,
        product_type: 'FD',
        variant,
        hints: {
          ...bankContextHints,
          ...(variant === 'fcnr' ? { expected_currencies: expectedCurrenciesOverride || ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD'] } : {}),
          ...(variant === 'gift' ? { expected_currencies: expectedCurrenciesOverride || ['USD', 'EUR', 'GBP'] } : {}),
        },
        logger: log,
      }), phase_events, log);
    }

    // Sprint 011 item 18 (2026-07-06): record the attempt (even a null one)
    // so the coverage loop can tell "already tried this URL with this engine
    // and got N slabs" apart from "never attempted".
    // Sprint 011 hint-fallback (2026-07-07): first attempt wins — when a
    // fetch-failed hinted attempt re-runs un-hinted, keep the hinted record
    // so the coverage loop's duplicate-attempt guard still matches the
    // hinted URL (its resolveCoverageTarget is hint-first) and doesn't
    // re-download a URL we already saw 404.
    if (extractorUsed && !mainLoopExtractions.has(product)) {
      mainLoopExtractions.set(product, {
        url: rpResult.url,
        extractor: extractorUsed,
        slabs: countExtractionSlabs(extraction),
      });
    }

    // Sprint 011 hint-fallback (2026-07-07): banks roll dated PDF filenames
    // (Axis: /docs/…/domestic-fixed-deposits-<date>.pdf) so a registry hint
    // can 404 while the default rate page is alive and links the current
    // file. On a FETCH-class hinted failure (HTTP 4xx/5xx, empty body,
    // network error — extract_pdf_table's { ok:false, failure_class:'fetch' }
    // envelope), re-enqueue the product with the hint suppressed. A hint
    // that downloads fine but parses to 0 slabs returns null, never this
    // envelope — so it does NOT trigger the fallback (re-extracting would
    // cost a second pass and risk duplicate commits for no new information).
    if (isFetchClassFailure(extraction)) {
      if (hinted) {
        const defaultPath = hints.cached_rate_pages?.[product];
        log.info(`[orchestrator] product=${product}: hinted URL failed (${fetchFailureLabel(extraction)}) — falling back to default rate page ${defaultPath || `(none cached — rediscovering from ${homepage})`}`);
        productQueue.unshift({ product, suppress_hint: true });
        continue;
      }
      // Un-hinted (or already-fallback) attempt fetch-failed: terminal for
      // this product, same summary shape as the null-extraction path.
      variantSummary[variant] = { status: 'extraction_failed', kind: clsResult.kind, reason: 'fetch_failed' };
      continue;
    }

    if (!extraction) {
      variantSummary[variant] = { status: 'extraction_failed', kind: clsResult.kind };
      continue;
    }

    // Drain any AOAI usages the extractor accumulated. extract_html_table's
    // LLM fallback may call AOAI 0-1 times per variant; extract_via_vision
    // exactly once when it runs.
    if (Array.isArray(extraction.llm_usages)) {
      llm_usages.push(...extraction.llm_usages);
    }
    // Phase 2a (sprint-004 2026-05-22): drain Azure DI Layout page count from
    // extract_via_ocr. The cost-tracker translates pages to USD at the per-
    // page rate ($0.01 at S0). Surfaces in the per-bank summary as
    // ocr_cost_usd alongside the existing LLM token cost.
    if (Number.isFinite(extraction.cost_pages) && extraction.cost_pages > 0) {
      ocrPagesTotal += extraction.cost_pages;
    }

    // 3d: commit_rates — shape varies by extraction action.
    const variantPages = extraction.pages || null; // PDF returns pages[]; HTML/vision return single payload
    if (variantPages && Array.isArray(variantPages)) {
      // M2.6 (sprint-004 2026-05-21): aggregate pages by variant before
      // commit. Each commitRates call writes to <bank>_<variant>_rates.json
      // and overwrites if called multiple times for the same variant.
      // Previously the loop committed once per page, so Axis's 3 PDF pages
      // (all variant=regular under inferPageVariant — none have NRI keywords
      // in their headings) overwrote each other and only the last page's
      // slabs survived. Group first, then commit once per variant with the
      // concatenated slab list. effective_date and source page metadata
      // come from the first page of each variant group.
      const byVariant = new Map();
      for (const page of variantPages) {
        if (!byVariant.has(page.variant)) byVariant.set(page.variant, { slabs: [], effective_date: null, pageNumbers: [] });
        const acc = byVariant.get(page.variant);
        acc.slabs.push(...page.slabs);
        if (!acc.effective_date) acc.effective_date = page.effective_date || extraction.effective_date || null;
        acc.pageNumbers.push(page.page_number);
      }
      let pageSlabsCommitted = 0;
      for (const [pVariant, acc] of byVariant.entries()) {
        // Sprint 011 A2 (item 19, 2026-07-06): forward regulatory footnotes
        // captured by extract_via_ocr so they land in the written rates JSON.
        const payload = buildRatesPayload(bank_code, pVariant, acc.slabs, acc.effective_date, rpResult.url, { pages: acc.pageNumbers, regulatory_constraints: extraction.regulatory_constraints });
        const result = await runStep(`commit_rates:${pVariant}@pages[${acc.pageNumbers.join(',')}]`, () => actions.commitRates({
          bank_code,
          variant: pVariant,
          payload,
          extraction_method: extraction.extraction_method,
          output_dir,
          rejected_dir,
          logger: log,
        }), phase_events, log);
        if (result?.wrote) {
          pageSlabsCommitted += acc.slabs.length;
          // Sprint 011 item 18 (2026-07-06): a page group may commit a
          // DIFFERENT variant than the iteration product (multi-variant NRI
          // PDFs) — mark whichever variant actually landed slabs.
          if (acc.slabs.length > 0) committedVariants.add(pVariant);
        }
      }
      variantSummary[variant] = { status: 'committed_multi_page', slabs: pageSlabsCommitted, pages: variantPages.length };
      totalSlabs += pageSlabsCommitted;
      // Persist PDF structure_hint for future-pass optimization
      if (extraction.structure_hint) {
        await runStep(`commit_to_registry:pdf_structure:${product}`, () => actions.commitToRegistry({
          bank_code,
          updates: { discovery_metadata: { pdf_structure: extraction.structure_hint } },
          domains_file,
          logger: log,
        }), phase_events, log);
      }
    } else {
      // HTML or vision: single payload
      const payload = buildRatesPayload(bank_code, variant, extraction.slabs, extraction.effective_date, rpResult.url, extraction);
      const result = await runStep(`commit_rates:${variant}`, () => actions.commitRates({
        bank_code,
        variant,
        payload,
        extraction_method: extraction.extraction_method,
        output_dir,
        rejected_dir,
        logger: log,
      }), phase_events, log);
      if (result?.wrote) {
        variantSummary[variant] = { status: 'committed', slabs: extraction.slabs.length, kind: clsResult.kind };
        totalSlabs += extraction.slabs.length;
        if (extraction.slabs.length > 0) committedVariants.add(variant); // Sprint 011 item 18
      } else if (result?.deferred_to_pending) {
        variantSummary[variant] = { status: 'deferred_to_pending', pending_path: result.pending_path };
      } else if (result?.validation && !result.validation.passed) {
        variantSummary[variant] = { status: 'validation_failed', critical: result.validation.critical_count };
      } else if (result && result.ok === false && result.error_class === 'slug_mismatch') {
        variantSummary[variant] = { status: 'slug_mismatch' };
      } else {
        variantSummary[variant] = { status: 'commit_failed' };
      }
    }

    // Update the registry's rate_pages entry for this product so future
    // recheck-mode runs can short-circuit.
    await runStep(`commit_to_registry:rate_page:${product}`, () => actions.commitToRegistry({
      bank_code,
      updates: {
        rate_pages: { [product]: rpResult.url },
        scraper_type: clsResult.kind,
      },
      domains_file,
      logger: log,
    }), phase_events, log);
  }

  // ── Phase 3.5: variant coverage guarantee (Sprint 011 item 18, 2026-07-06) ──
  // Belt-and-braces post-check: every product this run was supposed to cover
  // must have committed ≥1 slab. For each miss whose resolved URL is a PDF
  // or image, invoke the deterministic extractor directly (mirrors
  // scripts/recovery/axis-fcnr-direct-2026-06-15.js) and commit through the
  // same safe-write-protected commitRates path. HTML misses are left to the
  // main loop's failure record — re-running a flaky HTML extraction here
  // would duplicate work without new information. OCR hints take precedence
  // over PDF hints in this loop (inverse of the main loop): when both are
  // declared and the main loop's PDF pass didn't land slabs, the OCR engine
  // is the alternative worth trying, not a second identical PDF pass.
  for (const product of products) {
    const variant = PRODUCT_TO_VARIANT[product];
    if (committedVariants.has(variant)) continue;
    if (variantSummary[variant]?.status === 'deferred_to_pending') continue; // curated target; re-extracting would just re-defer

    const target = resolveCoverageTarget(product, bankEntryForHint, ratePageUrls, homepage);
    if (!target) {
      log.info(`[variant-coverage] product=${product} variant=${variant} missing but no PDF/image URL resolvable — leaving status=${variantSummary[variant]?.status || 'not_attempted'}`);
      continue;
    }
    const prior = mainLoopExtractions.get(product);
    if (prior && prior.url === target.url && prior.extractor === target.extractor && prior.slabs === 0) {
      // Deterministic engine, same input → same output; nothing to recover.
      log.info(`[variant-coverage] product=${product} variant=${variant}: main loop already ran ${target.extractor} on ${target.url} with 0 slabs — skipping duplicate attempt`);
      continue;
    }

    log.info(`[variant-coverage] product=${product} variant=${variant} uncovered — attempting direct ${target.extractor} extraction of ${target.url}`);
    const coverageContextHints = { bank_name, bank_type, bank_code, state, category: input.category };
    let extraction = null;
    if (target.extractor === 'ocr') {
      extraction = await runStep(`variant-coverage:extract_via_ocr:${product}`, () => actions.extractViaOcr({
        url: target.url,
        product_type: 'FD',
        variant,
        hints: coverageContextHints,
        logger: log,
      }), phase_events, log);
    } else {
      extraction = await runStep(`variant-coverage:extract_pdf_table:${product}`, () => actions.extractPdfTable({
        url: target.url,
        expected: { variants: [variant] },
        hints: coverageContextHints,
        session,
        logger: log,
      }), phase_events, log);
    }

    if (Array.isArray(extraction?.llm_usages)) llm_usages.push(...extraction.llm_usages);
    if (Number.isFinite(extraction?.cost_pages) && extraction.cost_pages > 0) ocrPagesTotal += extraction.cost_pages;

    const pages = extraction?.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      log.warn(`[variant-coverage] product=${product} variant=${variant}: direct ${target.extractor} extraction yielded no pages — variant stays uncovered`);
      continue;
    }
    // Same aggregate-by-variant-then-commit-once shape as the main loop.
    // Pages without a variant label default to the target variant.
    const byVariant = new Map();
    for (const page of pages) {
      const pVariant = page.variant || variant;
      if (!byVariant.has(pVariant)) byVariant.set(pVariant, { slabs: [], effective_date: null, pageNumbers: [] });
      const acc = byVariant.get(pVariant);
      acc.slabs.push(...(page.slabs || []));
      if (!acc.effective_date && page.effective_date) acc.effective_date = page.effective_date;
      acc.pageNumbers.push(page.page_number);
    }
    for (const [pVariant, acc] of byVariant.entries()) {
      if (acc.slabs.length === 0) continue;
      if (committedVariants.has(pVariant)) continue; // never overwrite a variant the main loop already landed
      const payload = buildRatesPayload(bank_code, pVariant, acc.slabs, acc.effective_date, target.url, { pages: acc.pageNumbers, regulatory_constraints: extraction.regulatory_constraints });
      const result = await runStep(`variant-coverage:commit_rates:${pVariant}`, () => actions.commitRates({
        bank_code,
        variant: pVariant,
        payload,
        extraction_method: extraction.extraction_method,
        output_dir,
        rejected_dir,
        logger: log,
      }), phase_events, log);
      if (result?.wrote) {
        committedVariants.add(pVariant);
        totalSlabs += acc.slabs.length;
        variantSummary[pVariant] = { status: 'committed_via_coverage_loop', slabs: acc.slabs.length, extractor: target.extractor };
        if (!ratePageUrls[product]) ratePageUrls[product] = target.url;
        anyRatePageFound = true;
        log.info(`[variant-coverage] recovered variant=${pVariant} slabs=${acc.slabs.length} via ${target.extractor} from ${target.url}`);
      } else {
        log.warn(`[variant-coverage] commit failed for variant=${pVariant} (wrote=false${result?.deferred_to_pending ? ', deferred_to_pending' : ''}) — variant stays uncovered`);
      }
    }
  }

  // ── Phase 4: commit_config ──────────────────────────────────────────
  // Writes <bank_code>_config.json to output_dir so downstream tools
  // (packages/scraper, pack/build-pack) have the canonical config artifact.
  // The LLM-prompt path produces this via docs/agent/schemas.md (Config File Schema); orchestrator emits
  // it explicitly with extraction_method='automatic_orchestrator'.
  await runStep('commit_config', () => actions.commitConfig({
    bank_code,
    bank_name,
    bank_type,
    category: input.category,
    state,
    website: homepage,
    scraper_type: scraperTypeForConfig,
    rate_page_urls: ratePageUrls,
    output_dir,
    confidence: websiteResult.confidence,
    logger: log,
  }), phase_events, log);

  // ── Phase 5: classify_outcome ───────────────────────────────────────
  const signals = {
    website_found: !!homepage,
    rate_page_found: anyRatePageFound,
    slabs_extracted_count: totalSlabs,
  };
  return await finish(bank_code, run_dir, phase_events, signals, log, { variantSummary, homepage, websiteConfidence: websiteResult.confidence, llm_usages, ocr_pages: ocrPagesTotal }, actions);
  } finally {
    if (session) {
      try {
        await session.close();
        log.debug('[orchestrator] playwright session closed');
      } catch (err) {
        log.warn(`[orchestrator] session.close failed: ${err.message}`);
      }
    }
  }
}

async function finish(bank_code, run_dir, phase_events, signals, log, extra = {}, actions = DEFAULT_ACTIONS) {
  const classification = await runStep('classify_outcome', () => actions.classifyOutcome({
    bank_code,
    run_dir,
    agent_result: { success: signals.slabs_extracted_count > 0 || signals.rate_page_found },
    domain_was_known: false,
    initial_tier: 1,
    retry_attempted: false,
  }), phase_events, log).catch(() => null);

  return {
    ok: signals.slabs_extracted_count > 0,
    bank_code,
    run_dir,
    phase_events,
    signals,
    classification: classification || null,
    ...extra,
  };
}

/** Wrap an action call so a throw becomes a structured phase event. */
async function runStep(name, fn, phase_events, log) {
  const t0 = Date.now();
  try {
    const result = await fn();
    phase_events.push({
      step: name,
      ok: !!(result && (result.ok === true || result.wrote === true || Array.isArray(result.slabs))),
      ms: Date.now() - t0,
      summary: summarize(result),
    });
    return result;
  } catch (err) {
    log.warn(`[orchestrator] step ${name} threw: ${err.message}`);
    phase_events.push({ step: name, ok: false, ms: Date.now() - t0, error: err.message });
    return null;
  }
}

function summarize(result) {
  if (!result) return null;
  if (typeof result !== 'object') return String(result).slice(0, 80);
  const out = {};
  if (result.url) out.url = result.url;
  if (result.kind) out.kind = result.kind;
  if (result.confidence) out.confidence = result.confidence;
  if (Array.isArray(result.slabs)) out.slabs = result.slabs.length;
  if (Array.isArray(result.pages)) out.pages = result.pages.length;
  if (result.failure_class) out.failure_class = result.failure_class;
  if (result.wrote != null) out.wrote = result.wrote;
  if (result.deferred_to_pending) out.deferred_to_pending = true;
  if (result.error_class) out.error_class = result.error_class;
  if (result.reason) out.reason = result.reason;
  return out;
}

function buildRatesPayload(bank_code, variant, slabs, effective_date, sourceUrl, ctx) {
  const payload = {
    bank_code,
    bank_name: ctx?.bank_name || undefined,
    product_type: 'FD',
    variant,
    effective_date: effective_date || null,
    source_url: sourceUrl,
    scraped_at: new Date().toISOString(),
    extraction_confidence: ctx?.confidence || 'high',
    rate_slabs: slabs,
    special_schemes: [],
    warnings: Array.isArray(ctx?.warnings) ? ctx.warnings : [],
    errors: [],
  };
  // Sprint 011 A2 (item 19, 2026-07-06): additive field — regulatory
  // footnotes (e.g. RBI FCNR lock-in window 8 Jun–30 Sep 2026) captured by
  // extract_via_ocr from DI paragraphs. Omitted entirely when absent so
  // existing consumers see an unchanged payload shape.
  if (Array.isArray(ctx?.regulatory_constraints) && ctx.regulatory_constraints.length > 0) {
    payload.regulatory_constraints = ctx.regulatory_constraints;
  }
  return payload;
}

function wrapLogger(logger) {
  return {
    info: (msg) => logger?.info ? logger.info(msg) : undefined,
    warn: (msg) => logger?.warn ? logger.warn(msg) : undefined,
    debug: (msg) => logger?.debug ? logger.debug(msg) : undefined,
  };
}

/**
 * Total slab count across an extraction result's shapes: `pages[]` (PDF/OCR)
 * or flat `slabs[]` (HTML/vision). 0 for null/failed extractions.
 * Sprint 011 item 18 (2026-07-06).
 */
function countExtractionSlabs(extraction) {
  if (!extraction) return 0;
  if (Array.isArray(extraction.pages)) {
    return extraction.pages.reduce((n, p) => n + ((p && Array.isArray(p.slabs)) ? p.slabs.length : 0), 0);
  }
  if (Array.isArray(extraction.slabs)) return extraction.slabs.length;
  return 0;
}

/**
 * Sprint 011 hint-fallback (2026-07-07): true when an extraction action
 * reported a FETCH-class failure — it never obtained the document bytes
 * (HTTP 4xx/5xx, empty body, network error). extract_pdf_table returns
 * `{ ok: false, failure_class: 'fetch', http_status?, error_message? }` for
 * exactly these cases and null for parse-stage failures, so a hint that
 * downloads fine but yields 0 slabs can never masquerade as fetch-failed.
 */
function isFetchClassFailure(extraction) {
  return !!(extraction && typeof extraction === 'object' && extraction.ok === false && extraction.failure_class === 'fetch');
}

/** Human-readable cause for the hint-fallback log line. */
function fetchFailureLabel(extraction) {
  if (Number.isFinite(extraction?.http_status)) return `HTTP ${extraction.http_status}`;
  return extraction?.error_message || 'download failed';
}

/** URL extension sniffs for the coverage loop — mirror classify_rate_page's short-circuits. */
const PDF_URL_RE = /\.pdf(?:\?|$)/i;
const IMAGE_URL_RE = /\.(jpg|jpeg|png|webp|gif|bmp)(?:\?|$)/i;

/**
 * Sprint 011 item 18 (2026-07-06): resolve the deterministic-extractor
 * target for an uncovered product. Order of authority:
 *   1. extraction.<key> OCR hint (image_ocr) — the operator's routing signal
 *      for files the PDF text engine can't read;
 *   2. extraction.<key> PDF hint;
 *   3. the URL the main loop discovered (ratePageUrls) or the registry's
 *      rate_pages.<product> path, when its extension marks it PDF/image.
 * Returns { url, extractor: 'pdf'|'ocr' } or null when nothing PDF/image
 * shaped can be resolved (HTML pages are out of scope for the coverage loop).
 */
function resolveCoverageTarget(product, bankEntryForHint, ratePageUrls, homepage) {
  const hintedOcr = findHintedOcrUrl(bankEntryForHint, product);
  if (hintedOcr) return { url: hintedOcr.url, extractor: 'ocr' };
  const hintedPdf = findHintedPdfUrl(bankEntryForHint, product);
  if (hintedPdf) return { url: hintedPdf.url, extractor: 'pdf' };

  let url = ratePageUrls[product] || null;
  if (!url && bankEntryForHint?.rate_pages) {
    const raw = bankEntryForHint.rate_pages[product];
    if (raw && typeof raw === 'string') {
      try {
        // Relative registry paths resolve against the discovered homepage.
        url = new URL(raw, homepage).toString();
      } catch { url = null; }
    }
  }
  if (!url) return null;
  if (PDF_URL_RE.test(url)) return { url, extractor: 'pdf' };
  if (IMAGE_URL_RE.test(url)) return { url, extractor: 'ocr' };
  return null;
}

/**
 * Variant names that a bank of `bankType` is expected to produce. Same
 * policy as `productsForBank` but yields the variant string used in
 * rate-file naming (regular/nre/nro/fcnr/gift) so the drift gate in
 * lib/tier-router.js can express "expected to have ≥1 slab on each of
 * these variants by default".
 */
function expectedVariantsForBank(bankType, bankCode) {
  return productsForBank(bankType, bankCode).map((p) => PRODUCT_TO_VARIANT[p]).filter(Boolean);
}

module.exports = {
  orchestrate,
  _shouldQueryNri: shouldQueryNri,
  _productsForBank: productsForBank,
  expectedVariantsForBank,
  // Sprint 011 item 18 (2026-07-06): exposed for unit testing.
  _configuredProductsFromHints: configuredProductsFromHints,
  _resolveCoverageTarget: resolveCoverageTarget,
};
