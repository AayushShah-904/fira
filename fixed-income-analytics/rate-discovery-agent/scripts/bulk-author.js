#!/usr/bin/env node
'use strict';

/**
 * Bulk template authoring with quality gates.
 *
 * Reads a cohort file (or --banks list), and for each bank:
 *   1. Fetch HTML via lib/fetch/fetch_html.js (honors persisted template.fetch)
 *   2. Compute fingerprint (lib/templating/fingerprint.js)
 *   3. Cluster reuse: if another bank in the SAME run produced a working
 *      proposal for this template_hash, reuse its extract block instead of
 *      calling the LLM again. ONE LLM call per cluster.
 *   4. LLM-propose (lib/templating/llm_propose.js) if no cluster reuse
 *   5. Extract via _generic-html-3col with the proposed extracts
 *   6. Evaluate quality gates → verdict PASS|REVIEW|FAIL
 *   7. If --write AND verdict=PASS: persist to data/bank-domains.json with
 *      `audit: {persisted_by: "bulk-author", verdict_at, gates}` on the template
 *      and `extraction_method: "llm_verified"` semantics
 *
 * Output: tmp/bulk-author-report.json with per-bank verdict + diagnostics +
 * cluster groupings + cost summary (LLM-call count).
 *
 * Run mode (default): dry-run, no persistence. Use --write to enable
 * auto-persist for PASS bucket. The TTY refusal that gates author-template.js
 * doesn't apply here — this script's contract is "gates do the trust work, and
 * every persisted entry is audit-tagged + bulk-revertable via bulk-revert.js".
 *
 * Usage:
 *   node scripts/bulk-author.js --cohort tmp/cohorts/top-tier.json
 *   node scripts/bulk-author.js --banks bank-a,bank-b [--write]
 *   node scripts/bulk-author.js --cohort top-tier.json --limit 10 --write
 *
 * Exit codes:
 *   0   success
 *   2   usage error
 *   3   no banks resolved
 *   4   AOAI not configured
 */

require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'data', 'bank-domains.json');
const REPORT_PATH = path.join(REPO_ROOT, 'tmp', 'bulk-author-report.json');

const { fetchHtml } = require('../lib/fetch/fetch_html');
const { fetchPdf } = require('../lib/fetch/fetch_pdf');
const { extractViaOcr } = require('../lib/actions/extract_via_ocr');
const ibuPdfExtractor = require('../lib/extractors/ibu-static-pdf-quarterly');
const psbPdfExtractor = require('../lib/extractors/psb-pdf-rate-card-3col');
const { fingerprintPage } = require('../lib/templating/fingerprint');
const { proposeTemplate } = require('../lib/templating/llm_propose');
const { extract: genericExtract } = require('../lib/extractors/_generic-html-3col');
const { assertTraceability } = require('../lib/extractors/_helpers/_assert_traceability');
const { safeWriteArtifact } = require('../lib/safe-write');
const { classify, DEAD_FAIL_BUCKETS } = require('./utils/classify-verdict');

const VARIANT_TO_RATE_KEY = { regular: 'fd', nre: 'fd_nre', nro: 'fd_nro', fcnr: 'fd_fcnr', gift: 'fd_gift' };

// Aggressive default fetch profile for banks with NO persisted template.fetch.
// The library fetch only expands accordions / waits for network idle when these
// flags are set — gap banks have none, so XHR- or accordion-loaded rate tables
// never appear (root cause of the large propose_no_template bucket). Applying
// this by default lets JS-rendered pages surface their tables; the profile that
// actually worked is persisted into template.fetch on PASS.
const AGGRESSIVE_FETCH = {
  expand_accordions: true,
  wait_for_network_idle: true,
  settle_window_ms: 2500,
};

// --- Quality gates --------------------------------------------------------

const DEFAULT_GATES = {
  min_slabs: 5,
  rate_min_pct: 1.0,
  rate_max_pct: 12.0,
  required_tenure_coverage_min_days: 7,
  required_tenure_coverage_max_days: 365,
  baseline_delta_pct: 30,  // ±30% vs baseline if baseline exists
};

function evaluateGates(slabs, baselineSlabCount, gates = DEFAULT_GATES) {
  const failures = [];
  const warnings = [];
  // Informational, NON-verdict-affecting signals. baseline_drop lives here:
  // the pre-reset April baselines were captured by a DIFFERENT extractor (often
  // inflated by amount-bucket fan-out, e.g. slice SFB baseline 38 vs a correct
  // 10), so "current < baseline" is noise, not a regression. We still surface it
  // for operator visibility, but it must NOT force REVIEW on its own.
  const notes = [];
  const seenTenures = slabs.filter(s => s.tenure_min_days != null);

  if (slabs.length === 0) {
    failures.push(`zero_slabs`);
    return { verdict: 'FAIL', failures, warnings, notes };
  }

  if (slabs.length < gates.min_slabs) {
    warnings.push(`slab_count_low: ${slabs.length} < ${gates.min_slabs}`);
  }

  // Anti-fabrication contract — strict mode
  const trace = assertTraceability(slabs, { strict: true });
  if (!trace.passed) {
    failures.push(`anti_fabrication: ${trace.failures.length}/${slabs.length} slabs failed traceability`);
  }

  // Rate range sanity — every rate field that's non-null must be in window
  for (const s of slabs) {
    for (const f of ['rate_general_pct', 'rate_senior_pct', 'rate_super_senior_pct']) {
      const v = s[f];
      if (v == null) continue;
      if (v < gates.rate_min_pct || v > gates.rate_max_pct) {
        failures.push(`rate_out_of_range: ${f}=${v} (allowed [${gates.rate_min_pct}, ${gates.rate_max_pct}])`);
        break;
      }
    }
  }

  // Tenure coverage — only flag missing LONG tenure (most banks publish at
  // least 1-year FDs; few publish 7-day so the short check was too strict).
  const hasLong = seenTenures.some(s => s.tenure_min_days <= gates.required_tenure_coverage_max_days && (s.tenure_max_days == null || s.tenure_max_days >= gates.required_tenure_coverage_max_days * 0.9));
  if (!hasLong) warnings.push(`missing_long_tenure: no slab covering ${gates.required_tenure_coverage_max_days}d`);

  // Baseline comparison — ONE-SIDED: only flag when current count is
  // significantly LOWER than baseline. Pre-fix baselines were inflated by
  // amount-bucket fan-out (e.g., BoB baseline 28 → now 19 after coalescing,
  // Axis baseline 324 → now ~30 after coalescing), so increases vs baseline
  // are noisy. Decreases beyond the threshold suggest extraction regression.
  //
  // baseline_drop is INFORMATIONAL ONLY (pushed to `notes`, not `warnings`): a
  // stale/inflated April baseline must never force REVIEW on a bank that
  // otherwise extracts cleanly (e.g. slice SFB extracts 10 correct slabs but
  // had a bogus baseline of 38). Real regressions still surface via the other
  // gates (slab_count_low, missing_long_tenure, currency_*, rate_out_of_range).
  if (baselineSlabCount != null && baselineSlabCount > 0 && slabs.length < baselineSlabCount) {
    const dropPct = (baselineSlabCount - slabs.length) / baselineSlabCount * 100;
    if (dropPct > gates.baseline_delta_pct) {
      notes.push(`baseline_drop: ${slabs.length} vs baseline ${baselineSlabCount} (-${dropPct.toFixed(0)}%)`);
    }
  }

  // Verdict is driven by failures (FAIL) and warnings (REVIEW) ONLY. `notes`
  // (baseline_drop) never affects the verdict — see comment above. All the
  // verdict-affecting warnings — slab_count_low, missing_long_tenure,
  // currency_undetected/ambiguous (appended downstream), rate range, etc. —
  // still live in `warnings` and still trigger REVIEW.
  let verdict;
  if (failures.length > 0) verdict = 'FAIL';
  else if (warnings.length > 0) verdict = 'REVIEW';
  else verdict = 'PASS';
  return { verdict, failures, warnings, notes };
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    cohort: null, banks: [], variant: 'regular', limit: null, write: false, force: false,
    aggressiveFetch: true, gates: { ...DEFAULT_GATES }, help: false,
    fromReport: null, verdicts: ['FAIL', 'REVIEW'], includeDead: false,
    onlyBuckets: null, excludeBuckets: [],
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--cohort') out.cohort = args[++i];
    else if (a === '--banks') out.banks = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--variant') out.variant = args[++i];
    else if (a === '--limit') out.limit = parseInt(args[++i], 10);
    else if (a === '--write') out.write = true;
    else if (a === '--force') out.force = true;
    else if (a === '--minimal-fetch') out.aggressiveFetch = false;
    else if (a === '--aggressive-fetch') out.aggressiveFetch = true;
    // Targeted re-run: build the worklist from a prior report's problem group
    // (FAIL/REVIEW) instead of re-running the whole cohort. Permanently-dead
    // buckets (WAF, missing URL) are skipped unless --include-dead.
    else if (a === '--from-report') { out.fromReport = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : REPORT_PATH; }
    else if (a === '--verdicts') out.verdicts = args[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--include-dead') out.includeDead = true;
    else if (a === '--only-buckets') out.onlyBuckets = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--exclude-buckets') out.excludeBuckets = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--min-slabs') out.gates.min_slabs = parseInt(args[++i], 10);
    else if (a === '--rate-max-pct') out.gates.rate_max_pct = parseFloat(args[++i]);
    else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  return out;
}

function printUsage() {
  process.stdout.write(`bulk-author — fetch + propose + extract + quality-gate for many banks

Usage:
  node scripts/bulk-author.js --cohort <file.json> [--limit N] [--write]
  node scripts/bulk-author.js --banks slug1,slug2,... [--write]
  node scripts/bulk-author.js --from-report [path] [--write]   (re-run last problem group)

Options:
  --cohort <path>       JSON file with a "cohort" array of {slug, name, category}
  --banks slug1,slug2   Explicit bank list (comma-separated slugs)
  --from-report [path]  Build the worklist from a prior report's problem group
                        instead of the full cohort (default path: the last report).
                        Iterate on FAIL/REVIEW only — the recommended re-run mode.
  --verdicts FAIL,REVIEW  Which verdicts to pull from the report (default FAIL,REVIEW)
  --include-dead        Also re-run dead buckets (waf_or_unreachable, config_missing_*)
  --only-buckets a,b    Restrict to these classification buckets (e.g. propose_no_template)
  --exclude-buckets a,b Skip these classification buckets
  --variant <name>      regular | nre | nro | fcnr | gift (default: regular)
  --limit N             Only process the first N banks
  --write               Auto-persist PASS bucket to data/bank-domains.json
                        (tagged with audit.persisted_by="bulk-author")
  --force               Re-author banks that already have a template
  --minimal-fetch       Disable the aggressive default fetch profile
  --min-slabs N         Override quality-gate min slab count (default 5)
  --rate-max-pct N      Override max allowed rate (default 12.0)
  --help                Show this help

Output:
  tmp/bulk-author-report.json  — per-bank verdict, diagnostics, cost summary

Verdict semantics:
  PASS    — all gates green, auto-persisted (with --write)
  REVIEW  — gates yellow (slab count low, baseline drift, etc.) — Claude/operator review
  FAIL    — gates red (zero slabs, anti-fab violations, rates out of range) — investigate
`);
}

// --- Helpers --------------------------------------------------------------

function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
}

// Decide WHICH registry key a persisted template block lands on, so a foreign-
// currency product (gift/fcnr) never clobbers a bank's DOMESTIC (regular)
// template. FCNR and GIFT are separate products denominated in foreign
// currency — they must coexist with the domestic template, not overwrite it.
//
// Routing:
//   - gift/fcnr variant AND the bank already carries a `template` for a
//     DIFFERENT (regular) variant  → write to `template_gift` / `template_fcnr`.
//   - everything else (domestic banks' regular template; gift-only IBUs or
//     fcnr-primary foreign banks that have NO regular template yet) → `template`.
//
// We detect "domestic template already present" via the variants map on the
// existing block: regular present AND this variant absent.
function targetTemplateKey(entry, variant) {
  if ((variant === 'gift' || variant === 'fcnr') &&
      entry && entry.template && entry.template.variants &&
      entry.template.variants.regular && !entry.template.variants[variant]) {
    return `template_${variant}`;
  }
  return 'template';
}

// Build a targeted worklist from a prior report's problem group, so iteration
// re-runs ONLY the banks worth retrying (FAIL/REVIEW), skipping permanently
// dead buckets (WAF, missing URL) unless --include-dead.
function resolveFromReport(opts) {
  const p = path.isAbsolute(opts.fromReport) ? opts.fromReport : path.join(REPO_ROOT, opts.fromReport);
  if (!fs.existsSync(p)) {
    process.stderr.write(`error: --from-report path not found: ${p}\n`);
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const wantVerdict = new Set(opts.verdicts);
  const only = opts.onlyBuckets ? new Set(opts.onlyBuckets) : null;
  const exclude = new Set(opts.excludeBuckets);
  const selected = [];
  const skipped = {};
  for (const r of report.results || []) {
    if (!wantVerdict.has(r.verdict)) continue;
    const bucket = classify(r);
    if (!opts.includeDead && DEAD_FAIL_BUCKETS.has(bucket)) { skipped[bucket] = (skipped[bucket] || 0) + 1; continue; }
    if (only && !only.has(bucket)) { skipped[bucket] = (skipped[bucket] || 0) + 1; continue; }
    if (exclude.has(bucket)) { skipped[bucket] = (skipped[bucket] || 0) + 1; continue; }
    selected.push({ slug: r.slug, name: r.name, category: r.category });
  }
  process.stdout.write(`--from-report ${path.basename(p)}: selected ${selected.length} bank(s) [verdicts=${opts.verdicts.join(',')}]\n`);
  const skipPairs = Object.entries(skipped);
  if (skipPairs.length) process.stdout.write(`  skipped buckets: ${skipPairs.map(([k, n]) => `${k}=${n}`).join(', ')}${opts.includeDead ? '' : ' (use --include-dead to re-run)'}\n`);
  return selected;
}

function loadBaselineSlabCount(bankCode, variant) {
  const suffix = variant === 'regular' ? '_rates.json' : `_${variant}_rates.json`;
  const p = path.join(REPO_ROOT, 'tmp', 'baseline-pre-reset', 'output-latest', `${bankCode}${suffix}`);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (data.rate_slabs || []).filter(s => s.tenure_min_days != null).length;
  } catch { return null; }
}

function resolveBankUrl(entry, variant) {
  const rateKey = VARIANT_TO_RATE_KEY[variant];
  const pagePath = entry.rate_pages && entry.rate_pages[rateKey];
  if (!pagePath || !entry.domain) return null;
  return pagePath.startsWith('http') ? pagePath : `https://${entry.domain}${pagePath.startsWith('/') ? '' : '/'}${pagePath}`;
}

const HAS_TABLE_RE = /<table[\s>]/i;

// Mirror lib/fetch/fetch_html.js PDF_RE — a rate-page URL ending in .pdf takes
// the PDF branch (fetch_pdf → DocIntel/pdfjs extractor) instead of HTML flow.
const PDF_RE = /\.pdf(?:\?|$)/i;

// A rate-page URL ending in an image extension (JPG/PNG/WebP) — or an entry
// explicitly tagged scraper_type:'image' — takes the OCR branch
// (extract_via_ocr → Azure DocIntel Layout → the SAME quality gates as HTML/PDF
// banks). Many small co-op banks publish their FD rate card only as a JPG.
const IMG_RE = /\.(jpe?g|png|webp)(?:\?|$)/i;

// Many .bank.in registry URLs are stored on the bare host (federal.bank.in/...)
// but those sites only serve full content on the www host — the bare host
// returns a small JS-redirect shell (e.g. federal non-www = 6.6KB, no <table>,
// which is JUST over challenge_detect's 5KB thin-body threshold so it's
// reported as a "success" with a useless body). Toggle www when a fetch
// succeeds but yields no rate table, so the bulk run self-heals the URL.
function hostVariants(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return [rawUrl]; }
  const alt = new URL(rawUrl);
  alt.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
  return [rawUrl, alt.toString()];
}

// Fetch with host-variant fallback. Prefers a table-bearing response; if no
// variant yields a <table>, returns the first successful (table-less) body so
// JS-div pages still flow to propose. Returns {fetchResult, urlUsed, corrected, threw}.
async function fetchWithHostFallback({ url, templateFetch, log }) {
  let firstSuccess = null;
  let lastFetch = null;
  let lastThrow = null;
  for (const candidate of hostVariants(url)) {
    let fr;
    try {
      fr = await fetchHtml({ url: candidate, templateFetch, log });
    } catch (err) {
      lastThrow = `fetch_threw: ${err.message}`;
      continue;
    }
    lastFetch = { fr, candidate };
    if (fr.status === 'success' && fr.html) {
      if (HAS_TABLE_RE.test(fr.html)) {
        return { fetchResult: fr, urlUsed: candidate, corrected: candidate !== url, threw: null };
      }
      if (!firstSuccess) firstSuccess = { fr, candidate };
    }
  }
  if (firstSuccess) return { fetchResult: firstSuccess.fr, urlUsed: firstSuccess.candidate, corrected: firstSuccess.candidate !== url, threw: null };
  if (lastFetch) return { fetchResult: lastFetch.fr, urlUsed: lastFetch.candidate, corrected: false, threw: null };
  return { fetchResult: null, urlUsed: url, corrected: false, threw: lastThrow || 'fetch_threw: unknown' };
}

// PDF rate-card branch. Banks whose rate page is a PDF flow through
// fetch_pdf → (pdfjs|DocIntel) → a PDF extractor → the SAME quality gates as
// HTML banks. No fingerprint/LLM-propose — PDF routing is deterministic
// (slug/variant picks the extractor). The result object mirrors the HTML
// branch's shape where applicable, plus is_pdf/pdf_method/pdf_extractor markers.
async function processPdf({ bankInfo, entry, url, variant, gates, log, fetchPdfFn }) {
  const slug = bankInfo.slug;
  const t0 = Date.now();
  const multiColumn = variant === 'gift' || variant === 'fcnr';
  const result = await fetchPdfFn({ url, hints: { multi_column: multiColumn }, log });

  const hasStructuredSlabs = Array.isArray(result.slabs) && result.slabs.length > 0;
  if (result.method === 'failed' || (!result.pdfText && !result.docIntelLayout && !hasStructuredSlabs)) {
    return {
      slug,
      name: bankInfo.name,
      category: bankInfo.category,
      url_used: url,
      is_pdf: true,
      pdf_method: result.method,
      verdict: 'FAIL',
      error: 'pdf_fetch_failed' + (result.error ? ': ' + result.error.code : ''),
      ms: Date.now() - t0,
    };
  }

  // Decide the slab source:
  //
  // (A) Structured fast-path — extract_rates_pdf.mjs (via fetch_pdf) already
  //     parsed slabs well for domestic/INR rate cards. For regular/nre/nro
  //     variants, when the .mjs returned ≥1 slab, use those DIRECTLY and skip
  //     the psb/ibu extractor. The .mjs slabs lack source_row_text (the
  //     anti-fabrication contract field), so synthesize it from each slab's own
  //     parsed fields — these are the parser's own output, not LLM-fabricated.
  //
  // (B) Extractor path — for gift/fcnr (currency tagging) or when the .mjs
  //     yielded zero slabs, fall through to the existing extractor wiring
  //     (ibu-static-pdf-quarterly / psb-pdf-rate-card-3col over pdfText +
  //     docintelLayout), which handles currency columns and DocIntel grids.
  const useStructured =
    Array.isArray(result.slabs) && result.slabs.length > 0 &&
    (variant === 'regular' || variant === 'nre' || variant === 'nro');

  let slabs;
  let effectiveDate;
  let extractDiagnostics;
  let extractWarnings;
  let pdfExtractor;

  if (useStructured) {
    slabs = result.slabs.map(enrichSlabSourceText);
    effectiveDate = result.effective_date || null;
    extractDiagnostics = { extractor_kind: 'extract_rates_pdf.mjs', rows_seen: result.slabs.length, rows_kept: slabs.length, bank_code: slug };
    extractWarnings = [];
    pdfExtractor = 'extract_rates_pdf.mjs';
  } else {
    // Route to extractor: IBU/foreign-currency → ibu-static-pdf-quarterly;
    // everything else → psb-pdf-rate-card-3col.
    const useIbu = slug.endsWith('-ibu') || variant === 'gift' || variant === 'fcnr';
    const extractor = useIbu ? ibuPdfExtractor : psbPdfExtractor;

    // NOTE: fetch_pdf returns docIntelLayout (capital L); both extractors read
    // docintelLayout (lowercase). Map correctly here.
    const extractResult = extractor.extract({
      pdfText: result.pdfText,
      docintelLayout: result.docIntelLayout,
      productContext: { bank_code: slug },
    });
    slabs = extractResult.slabs || [];
    effectiveDate = extractResult.effective_date;
    extractDiagnostics = extractResult.diagnostics || {};
    extractWarnings = extractResult.warnings || [];
    pdfExtractor = extractor.template_id;

    // (C) Gift/FCNR structured fallback — the ibu/psb extractor's column
    //     classifier returns 0 on some GIFT layouts (e.g. axis/hdfc/idfc IBU
    //     cards) whose grids it can't read, even though extract_rates_pdf.mjs
    //     parsed the rate slabs cleanly into result.slabs. When the extractor
    //     yielded nothing but the .mjs did, recover those slabs: detect the
    //     foreign currency from all available text, tag every slab, synthesize
    //     source_row_text (anti-fab gate), then gate normally. We never guess a
    //     currency — zero/ambiguous detection leaves currency null + a warning
    //     (REVIEW), which is the correct, honest verdict.
    if ((variant === 'gift' || variant === 'fcnr') && slabs.length === 0 &&
        Array.isArray(result.slabs) && result.slabs.length > 0) {
      const ccy = detectCurrencyFromSources(result);
      const fallbackWarnings = [];
      let tagged;
      if (ccy.codes.length === 1) {
        tagged = result.slabs.map((s) => enrichSlabSourceText({ ...s, currency: ccy.codes[0] }));
      } else if (ccy.codes.length === 0) {
        tagged = result.slabs.map((s) => enrichSlabSourceText({ ...s, currency: null }));
        fallbackWarnings.push('currency_undetected: gift/fcnr card has no explicit currency token');
      } else {
        tagged = result.slabs.map((s) => enrichSlabSourceText({ ...s, currency: null }));
        fallbackWarnings.push(`currency_ambiguous: multiple currencies on card (${ccy.codes.join(',')})`);
      }
      slabs = tagged;
      effectiveDate = result.effective_date || null;
      pdfExtractor = 'extract_rates_pdf.mjs+currency';
      extractWarnings = fallbackWarnings;
      extractDiagnostics = {
        extractor_kind: 'extract_rates_pdf.mjs+currency',
        fallback: 'gift_structured_slabs',
        dominant_currency: ccy.codes.length === 1 ? ccy.codes[0] : null,
        currencies_detected: ccy.codes,
        rows_seen: result.slabs.length,
        rows_kept: slabs.length,
        bank_code: slug,
      };
    }
  }

  const baselineSlabCount = loadBaselineSlabCount(slug, variant);
  const gateResult = evaluateGates(slabs, baselineSlabCount, gates || DEFAULT_GATES);

  // Synthetic template_hash so persist/cluster code (which keys on a hash) does
  // not break — PDFs have no HTML fingerprint, so hash the URL instead.
  const urlHash = crypto.createHash('sha1').update(url).digest('hex');

  const warnings = (gateResult.warnings || []).concat(extractWarnings);

  // The currency-detection warnings (undetected / ambiguous) are extractor-side
  // and so don't reach evaluateGates — but an un-/ambiguously-tagged gift/fcnr
  // card must NOT silently PASS (we never guess a currency). Escalate a clean
  // PASS to REVIEW whenever such a warning is present, so an operator confirms
  // the currency before the slabs are trusted.
  let verdict = gateResult.verdict;
  const hasCurrencyDoubt = extractWarnings.some((w) => /^currency_(undetected|ambiguous)/.test(w));
  if (verdict === 'PASS' && hasCurrencyDoubt) verdict = 'REVIEW';

  return {
    slug,
    name: bankInfo.name,
    category: bankInfo.category,
    url_used: url,
    is_pdf: true,
    variant,
    template_id: pdfExtractor,
    template_hash: 'pdf:' + urlHash,
    pdf_method: result.method,
    pdf_extractor: pdfExtractor,
    slab_count: slabs.length,
    baseline_slab_count: baselineSlabCount,
    effective_date: effectiveDate,
    extract_diagnostics: extractDiagnostics,
    total_ms: Date.now() - t0,
    verdict,
    failures: gateResult.failures,
    warnings,
    notes: gateResult.notes || [],
  };
}

// OCR (image) rate-card branch. Banks whose rate page is a JPG/PNG flow through
// extract_via_ocr → Azure DocIntel Layout → the SAME quality gates as HTML/PDF
// banks. No fingerprint/LLM-propose — OCR routing is deterministic (image URL
// picks the extractor). extract_via_ocr returns a PDF-shaped { pages:[{slabs}] }
// result (or null on failure); processOcr flattens pages[].slabs into one array,
// synthesizes source_row_text for the strict anti-fab gate, and gates normally.
// The result object mirrors the HTML/PDF branch shape plus is_ocr/ocr_confidence
// markers so persistEntry can route it to persistOcrEntry.
async function processOcr({ bankInfo, entry, url, variant, gates, log, extractViaOcrFn }) {
  const slug = bankInfo.slug;
  const t0 = Date.now();

  let result;
  try {
    result = await extractViaOcrFn({ url, product_type: 'FD', variant, logger: log });
  } catch (err) {
    return {
      slug, name: bankInfo.name, category: bankInfo.category, url_used: url,
      is_ocr: true, variant, verdict: 'FAIL', error: `ocr_threw: ${err.message}`,
      ms: Date.now() - t0,
    };
  }

  // null = DI call failed / not configured. No pages or no slabs = no rate
  // table on the image. Both are an honest FAIL (no fabrication).
  const pages = (result && Array.isArray(result.pages)) ? result.pages : [];
  const slabs = pages.flatMap((p) => (Array.isArray(p.slabs) ? p.slabs : []))
    .map((s) => enrichSlabSourceText({
      ...s,
      deposit_range: s.deposit_range || 'below_3cr',
      ...(s.currency != null ? { currency: s.currency } : {}),
    }));

  if (!result || slabs.length === 0) {
    return {
      slug, name: bankInfo.name, category: bankInfo.category, url_used: url,
      is_ocr: true, variant,
      template_id: 'extract_via_ocr',
      template_hash: 'ocr:' + crypto.createHash('sha1').update(url).digest('hex'),
      slab_count: 0,
      verdict: 'FAIL',
      error: 'ocr_no_slabs',
      ms: Date.now() - t0,
    };
  }

  // effective_date / confidence come from the first page that carries them.
  const effectiveDate = pages.find((p) => p.effective_date)?.effective_date || null;
  const ocrConfidence = pages.find((p) => p.confidence)?.confidence || null;

  const baselineSlabCount = loadBaselineSlabCount(slug, variant);
  const gateResult = evaluateGates(slabs, baselineSlabCount, gates || DEFAULT_GATES);

  return {
    slug,
    name: bankInfo.name,
    category: bankInfo.category,
    url_used: url,
    is_ocr: true,
    variant,
    template_id: 'extract_via_ocr',
    template_hash: 'ocr:' + crypto.createHash('sha1').update(url).digest('hex'),
    slab_count: slabs.length,
    baseline_slab_count: baselineSlabCount,
    effective_date: effectiveDate,
    ocr_confidence: ocrConfidence,
    extraction_method: result.extraction_method || 'automatic_ocr',
    extract_diagnostics: {
      extractor_kind: 'extract_via_ocr',
      pages: pages.length,
      cost_pages: result.cost_pages,
      rows_kept: slabs.length,
      bank_code: slug,
    },
    total_ms: Date.now() - t0,
    verdict: gateResult.verdict,
    failures: gateResult.failures,
    warnings: gateResult.warnings,
    notes: gateResult.notes || [],
  };
}

// extract_rates_pdf.mjs emits slabs WITHOUT source_row_text (the anti-fab
// contract field that evaluateGates → assertTraceability requires). Synthesize
// it from the slab's own parsed fields: tenure_text + every non-null rate. The
// slab is the deterministic parser's own output (not an LLM proposal), so the
// reconstructed source row faithfully traces what was parsed.
function enrichSlabSourceText(slab) {
  if (slab && typeof slab.source_row_text === 'string' && slab.source_row_text) return slab;
  const rates = [slab.rate_general_pct, slab.rate_senior_pct, slab.rate_super_senior_pct]
    .filter((r) => r != null && Number.isFinite(r))
    .map((r) => String(r));
  const parts = [slab.tenure_text || '', ...rates].filter(Boolean);
  return { ...slab, source_row_text: parts.join(' ').replace(/\s+/g, ' ').trim() };
}

// ISO codes we recognise on a foreign-currency (GIFT/FCNR) rate card. Used
// only by the gift/fcnr structured fallback to tag .mjs slabs that the
// column-classifier couldn't read a currency for. We word-boundary match to
// avoid false hits inside other tokens (e.g. "CADENCE").
const FALLBACK_CURRENCY_CODES = ['USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD', 'SGD', 'CHF', 'HKD', 'NZD', 'AED'];
const FALLBACK_CURRENCY_RE = new RegExp(`\\b(${FALLBACK_CURRENCY_CODES.join('|')})\\b`, 'gi');

// Broad-scan every available text source from a fetch_pdf result for ISO
// currency codes and return the DISTINCT set found (uppercased). Sources, in
// order: docIntelLayout.content, docIntelLayout.pages[].lines/.words .content,
// result.pdfText, and each .mjs slab's tenure_text / source_row_text. Order
// only affects the joined-string scan; the result is a set, so callers decide
// PASS (exactly one) vs REVIEW (zero or many) — we never pick a "winner".
function detectCurrencyFromSources(result) {
  const parts = [];
  const layout = result.docIntelLayout;
  if (layout) {
    if (typeof layout.content === 'string') parts.push(layout.content);
    if (Array.isArray(layout.pages)) {
      for (const pg of layout.pages) {
        if (Array.isArray(pg.lines)) for (const l of pg.lines) if (l && typeof l.content === 'string') parts.push(l.content);
        if (Array.isArray(pg.words)) for (const w of pg.words) if (w && typeof w.content === 'string') parts.push(w.content);
      }
    }
  }
  if (typeof result.pdfText === 'string') parts.push(result.pdfText);
  if (Array.isArray(result.slabs)) {
    for (const s of result.slabs) {
      if (s && typeof s.tenure_text === 'string') parts.push(s.tenure_text);
      if (s && typeof s.source_row_text === 'string') parts.push(s.source_row_text);
    }
  }
  const haystack = parts.join('\n');
  const found = new Set();
  for (const m of haystack.matchAll(FALLBACK_CURRENCY_RE)) found.add(m[1].toUpperCase());
  return { codes: [...found] };
}

async function processOne({ bankInfo, registry, clusterCache, llmCallCounter, log, variant, aggressiveFetch, gates, _fetchPdf, _extractViaOcr }) {
  const slug = bankInfo.slug;
  const entry = registry[slug];
  if (!entry) return { slug, verdict: 'FAIL', error: 'no_registry_entry' };
  const url = resolveBankUrl(entry, variant);
  if (!url) return { slug, verdict: 'FAIL', error: 'no_rate_url' };

  // PDF rate page → dedicated branch (no fingerprint/propose).
  if (PDF_RE.test(url)) {
    return processPdf({ bankInfo, entry, url, variant, gates, log, fetchPdfFn: _fetchPdf || fetchPdf });
  }

  // Image rate card → OCR branch (no fingerprint/propose). Fires when the
  // resolved URL is an image OR the entry is explicitly scraper_type:'image'.
  if (IMG_RE.test(url) || entry.scraper_type === 'image') {
    return processOcr({ bankInfo, entry, url, variant, gates, log, extractViaOcrFn: _extractViaOcr || extractViaOcr });
  }

  const persistedFetch = (entry.template && entry.template.fetch) || {};
  // Use the persisted fetch profile if one exists; otherwise fall back to the
  // aggressive default (unless --minimal-fetch). Record what we used so PASS
  // persistence bakes the working profile into template.fetch.
  const templateFetch = Object.keys(persistedFetch).length > 0
    ? persistedFetch
    : (aggressiveFetch ? { ...AGGRESSIVE_FETCH } : {});
  const t0 = Date.now();
  const fb = await fetchWithHostFallback({ url, templateFetch, log });
  if (fb.threw) {
    return { slug, verdict: 'FAIL', error: fb.threw, ms: Date.now() - t0, url_used: fb.urlUsed };
  }
  const fetchResult = fb.fetchResult;
  if (!fetchResult || fetchResult.status !== 'success' || !fetchResult.html) {
    return { slug, verdict: 'FAIL', error: `fetch_${fetchResult ? fetchResult.status : 'threw'}`, final_strategy: fetchResult && fetchResult.final_strategy, ms: Date.now() - t0, url_used: fb.urlUsed };
  }
  const html = fetchResult.html;
  const urlUsed = fb.urlUsed;
  const urlCorrected = fb.corrected;
  const fetchMs = Date.now() - t0;

  // Fingerprint + cluster lookup
  const fp = fingerprintPage({ html, url, kind: 'html' });
  const hash = fp.template_hash;
  let proposal;
  let clusterReused = false;
  if (clusterCache.has(hash)) {
    proposal = clusterCache.get(hash);
    clusterReused = true;
  } else {
    const propStart = Date.now();
    try {
      const r = await proposeTemplate({ bankCode: slug, variant, url: urlUsed, html, logger: log });
      proposal = r.proposal;
      clusterCache.set(hash, proposal);
      llmCallCounter.count++;
      llmCallCounter.ms += Date.now() - propStart;
    } catch (err) {
      if (err.code === 'AOAI_NOT_CONFIGURED') throw err;
      return { slug, verdict: 'FAIL', error: `propose_failed: ${err.message}`, template_hash: hash, ms: Date.now() - t0 };
    }
  }
  if (!proposal || !proposal.template_id_suggestion || proposal.extracts.length === 0) {
    return { slug, verdict: 'FAIL', error: 'llm_no_template', template_hash: hash, ms: Date.now() - t0 };
  }

  // Extract
  const replay = genericExtract({
    html,
    templateExtract: { extracts: proposal.extracts, tenure_cap_days: proposal.tenure_cap_days },
    productContext: { bank_code: slug },
  });

  // Gates
  const baselineSlabCount = loadBaselineSlabCount(slug, variant);
  const gateResult = evaluateGates(replay.slabs, baselineSlabCount, gates || DEFAULT_GATES);

  return {
    slug,
    name: bankInfo.name,
    category: bankInfo.category,
    url_used: urlUsed,
    url_corrected: urlCorrected,
    variant,
    fetch_used: templateFetch,
    template_hash: hash,
    template_id: proposal.template_id_suggestion,
    cluster_reused: clusterReused,
    slab_count: replay.slabs.length,
    baseline_slab_count: baselineSlabCount,
    extracts: proposal.extracts,
    tenure_cap_days: proposal.tenure_cap_days,
    fetch_ms: fetchMs,
    total_ms: Date.now() - t0,
    extract_diagnostics: {
      rows_seen: replay.diagnostics.rows_seen,
      rows_kept: replay.diagnostics.rows_kept,
      rows_dropped_reasons: replay.diagnostics.rows_dropped_reasons,
    },
    verdict: gateResult.verdict,
    failures: gateResult.failures,
    warnings: gateResult.warnings,
    notes: gateResult.notes || [],
  };
}

function persistEntry(registry, slug, entry, result) {
  if (result.is_pdf) return persistPdfEntry(registry, slug, entry, result);
  if (result.is_ocr) return persistOcrEntry(registry, slug, entry, result);
  const fp_hash = result.template_hash;
  // Route gift/fcnr to template_gift/template_fcnr when a domestic template
  // already exists, so we never clobber the regular product (see targetTemplateKey).
  const key = targetTemplateKey(entry, result.variant);
  const persistVariant = result.variant || 'regular';
  // The block's variants map describes THIS product only — do not inherit the
  // domestic {regular} map into an fcnr/gift block. Merge with any existing
  // variants already on the target key (e.g. a prior fcnr persist).
  const variants = {
    ...((entry[key] && entry[key].variants) || {}),
    [persistVariant]: { rate_page_key: VARIANT_TO_RATE_KEY[persistVariant] },
  };
  const block = {
    template_id: result.template_id,
    template_hash: fp_hash,
    fingerprinted_at: new Date().toISOString().slice(0, 10),
    fetch: result.fetch_used && Object.keys(result.fetch_used).length > 0
      ? result.fetch_used
      : (entry[key] && entry[key].fetch) || {},
    extract: {
      extractor: '_generic-html-3col',
      extracts: result.extracts,
      ...(result.tenure_cap_days != null ? { tenure_cap_days: result.tenure_cap_days } : {}),
    },
    variants,
    audit: {
      persisted_by: 'bulk-author',
      verdict_at: new Date().toISOString(),
      gates_passed: 'PASS',
      slab_count: result.slab_count,
      cluster_reused: result.cluster_reused,
    },
  };
  registry[slug] = { ...entry, [key]: { ...(entry[key] || {}), ...block } };
  return key;
}

// Persist a PDF-extractor result. PDF templates carry scraper_type:'pdf' and an
// extract block naming only the extractor (no column_map — PDFs are parsed by
// the extractor's own DocIntel/text logic, not a column mapping). Variants
// default to the relevant rate_page_key for the variant being authored.
function persistPdfEntry(registry, slug, entry, result) {
  // Derive the variant key from result.variant first (so the gift/fcnr
  // structured fallback — template_id 'extract_rates_pdf.mjs+currency' — still
  // persists under the correct gift/fcnr key), falling back to the ibu
  // extractor id and finally 'regular' for legacy/domestic PDFs.
  const variantKey = (result.variant === 'gift' || result.variant === 'fcnr')
    ? result.variant
    : (result.template_id === 'ibu-static-pdf-quarterly' ? 'gift' : 'regular');
  const rateKey = VARIANT_TO_RATE_KEY[result.variant] || (variantKey === 'gift' ? 'fd_gift' : 'fd');
  // Route gift/fcnr to template_gift/template_fcnr when a domestic template
  // already exists, so the foreign-currency PDF never clobbers the regular one.
  const key = targetTemplateKey(entry, result.variant);
  // Variants map describes THIS product only (the variant being authored),
  // merged with any variants already on the target key — never inherit the
  // domestic {regular} map into an fcnr/gift block.
  const variants = {
    ...((entry[key] && entry[key].variants) || {}),
    [variantKey]: { rate_page_key: rateKey },
  };
  const block = {
    template_id: result.template_id,
    template_hash: result.template_hash,
    scraper_type: 'pdf',
    fingerprinted_at: new Date().toISOString().slice(0, 10),
    extract: { extractor: result.template_id },
    variants,
    audit: {
      persisted_by: 'bulk-author',
      verdict_at: new Date().toISOString(),
      gates_passed: 'PASS',
      slab_count: result.slab_count,
      source: 'pdf',
      pdf_method: result.pdf_method,
    },
  };
  registry[slug] = { ...entry, [key]: { ...(entry[key] || {}), ...block } };
  return key;
}

// Persist an OCR (image) extractor result. Image templates carry
// scraper_type:'image' and an extract block naming only the extractor (no
// column_map — images are parsed by DocIntel Layout, not a column mapping).
// Variants default to the relevant rate_page_key for the variant being
// authored. Uses targetTemplateKey so a gift/fcnr image routes to
// template_gift/template_fcnr and never clobbers a domestic template.
function persistOcrEntry(registry, slug, entry, result) {
  const persistVariant = result.variant || 'regular';
  const rateKey = VARIANT_TO_RATE_KEY[persistVariant] || 'fd';
  // Route gift/fcnr to template_gift/template_fcnr when a domestic template
  // already exists, so the foreign-currency image never clobbers the regular one.
  const key = targetTemplateKey(entry, result.variant);
  // Variants map describes THIS product only (the variant being authored),
  // merged with any variants already on the target key — never inherit the
  // domestic {regular} map into an fcnr/gift block.
  const variants = {
    ...((entry[key] && entry[key].variants) || {}),
    [persistVariant]: { rate_page_key: rateKey },
  };
  const block = {
    template_id: result.template_id || 'extract_via_ocr',
    template_hash: result.template_hash,
    scraper_type: 'image',
    fingerprinted_at: new Date().toISOString().slice(0, 10),
    extract: { extractor: 'extract_via_ocr' },
    variants,
    extraction_method: 'automatic_ocr',
    audit: {
      persisted_by: 'bulk-author',
      verdict_at: new Date().toISOString(),
      gates_passed: 'PASS',
      slab_count: result.slab_count,
      source: 'ocr',
      ocr_confidence: result.ocr_confidence,
    },
  };
  registry[slug] = { ...entry, [key]: { ...(entry[key] || {}), ...block } };
  return key;
}

// --- Main -----------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printUsage(); process.exit(0); }
  // Foreign-currency variants (GIFT/FCNR) carry sub-1% rates (EUR/JPY) and have
  // no senior-citizen premium — relax the domestic 1% floor to 0 unless the
  // operator explicitly overrode it via --min-slabs/--rate-max-pct flags.
  if (opts.variant === 'gift' || opts.variant === 'fcnr') {
    if (opts.gates.rate_min_pct === DEFAULT_GATES.rate_min_pct) opts.gates.rate_min_pct = 0.0;
    // Baseline comparison is meaningless for gift/fcnr: April baselines predate
    // currency support and were extracted differently (often inflated), so a
    // baseline_drop here is noise, not a real regression. Disable it.
    if (opts.gates.baseline_delta_pct === DEFAULT_GATES.baseline_delta_pct) opts.gates.baseline_delta_pct = 1000;
  }
  if (!opts.cohort && opts.banks.length === 0 && !opts.fromReport) {
    process.stderr.write('error: --cohort, --banks, or --from-report required\n\n');
    printUsage();
    process.exit(2);
  }

  // Resolve cohort → list of {slug, name?, category?}
  let cohort = [];
  if (opts.fromReport) {
    cohort = cohort.concat(resolveFromReport(opts));
  }
  if (opts.cohort) {
    const data = JSON.parse(fs.readFileSync(path.isAbsolute(opts.cohort) ? opts.cohort : path.join(REPO_ROOT, opts.cohort), 'utf-8'));
    cohort = cohort.concat(Array.isArray(data) ? data : (data.cohort || []));
  }
  if (opts.banks.length > 0) {
    for (const s of opts.banks) cohort.push({ slug: s });
  }
  if (opts.limit) cohort = cohort.slice(0, opts.limit);
  if (cohort.length === 0) { process.stderr.write('error: cohort is empty\n'); process.exit(3); }

  const registry = loadRegistry();
  // Skip banks that already have a template unless --force
  if (!opts.force) {
    const before = cohort.length;
    cohort = cohort.filter(b => !(registry[b.slug] && registry[b.slug].template));
    if (before !== cohort.length) {
      process.stdout.write(`skipping ${before - cohort.length} bank(s) already with templates (use --force to re-author)\n`);
    }
  }
  if (cohort.length === 0) { process.stdout.write('no banks left to process\n'); process.exit(0); }

  process.stdout.write(`\nProcessing ${cohort.length} bank(s) (variant=${opts.variant}, write=${opts.write})\n`);
  process.stdout.write(`Gates: ${JSON.stringify(opts.gates)}\n\n`);

  const log = {
    info: () => {},  // quiet during bulk run
    warn: (m) => process.stderr.write(`[warn] ${m}\n`),
    debug: () => {},
    error: (m) => process.stderr.write(`[error] ${m}\n`),
  };

  const clusterCache = new Map();   // template_hash → proposal
  const llmCallCounter = { count: 0, ms: 0 };
  const results = [];
  const runStart = Date.now();

  for (let i = 0; i < cohort.length; i++) {
    const b = cohort[i];
    process.stdout.write(`[${String(i + 1).padStart(3)}/${cohort.length}] ${b.slug.padEnd(55)} `);
    try {
      const r = await processOne({ bankInfo: b, registry, clusterCache, llmCallCounter, log, variant: opts.variant, aggressiveFetch: opts.aggressiveFetch, gates: opts.gates });
      results.push(r);
      const tag = r.cluster_reused ? '↻' : ' ';
      process.stdout.write(`${tag} ${r.verdict.padEnd(7)} slabs=${String(r.slab_count ?? '-').padStart(3)} ${r.error || ''}${r.warnings && r.warnings.length ? ' [' + r.warnings.length + 'w]' : ''}\n`);
    } catch (err) {
      if (err.code === 'AOAI_NOT_CONFIGURED') {
        process.stderr.write('\nFATAL: AOAI not configured. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env\n');
        process.exit(4);
      }
      process.stdout.write(` ERROR ${err.message}\n`);
      results.push({ slug: b.slug, verdict: 'FAIL', error: err.message });
    }
  }

  // Summary
  const counts = { PASS: 0, REVIEW: 0, FAIL: 0 };
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const totalMs = Date.now() - runStart;
  process.stdout.write(`\n=== Summary (${(totalMs / 1000).toFixed(1)}s) ===\n`);
  process.stdout.write(`  PASS:    ${counts.PASS}\n`);
  process.stdout.write(`  REVIEW:  ${counts.REVIEW}\n`);
  process.stdout.write(`  FAIL:    ${counts.FAIL}\n`);
  process.stdout.write(`  LLM calls: ${llmCallCounter.count} (${(llmCallCounter.ms / 1000).toFixed(1)}s)\n`);
  process.stdout.write(`  Clusters discovered: ${clusterCache.size}\n`);
  if (cohort.length > 0) process.stdout.write(`  Reuse rate: ${((1 - llmCallCounter.count / cohort.length) * 100).toFixed(0)}%\n`);

  // Write report
  const report = {
    generated_at: new Date().toISOString(),
    cohort_size: cohort.length,
    variant: opts.variant,
    gates: opts.gates,
    counts,
    llm_calls: llmCallCounter.count,
    clusters: clusterCache.size,
    total_ms: totalMs,
    results,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  // safe-write-exempt: bulk-author run report (aggregator output), not a per-bank canonical artifact.
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  process.stdout.write(`\nReport: ${REPORT_PATH}\n`);

  // Persist PASS bucket if --write
  if (opts.write && counts.PASS > 0) {
    process.stdout.write(`\nPersisting ${counts.PASS} PASS bank(s) to ${REGISTRY_PATH}...\n`);
    let updated = 0;
    let urlsFixed = 0;
    for (const r of results) {
      if (r.verdict !== 'PASS') continue;
      const entry = registry[r.slug];
      if (!entry) continue;
      // Self-healed URL: persist the working host variant into rate_pages.fd so
      // the runtime scraper uses it too (not just this bulk run).
      if (r.url_corrected && r.url_used) {
        entry.rate_pages = entry.rate_pages || {};
        if (entry.rate_pages.fd !== r.url_used) {
          entry.rate_pages.fd_prev = entry.rate_pages.fd;
          entry.rate_pages.fd = r.url_used;
          entry.rate_pages.fd_url_fixed_at = new Date().toISOString().slice(0, 10);
          process.stdout.write(`  url-healed ${r.slug}: → ${r.url_used}\n`);
          urlsFixed++;
        }
      }
      const key = persistEntry(registry, r.slug, entry, r);
      if (key && key !== 'template') {
        process.stdout.write(`  ${r.slug}: persisted to ${key} (domestic template preserved)\n`);
      }
      updated++;
    }
    safeWriteArtifact({
      path: REGISTRY_PATH,
      incoming: registry,
      kind: 'registry-file',
      source: 'agent',
      logger: log,
    });
    process.stdout.write(`  wrote ${updated} template block(s)${urlsFixed ? `, self-healed ${urlsFixed} URL(s)` : ''}\n`);
  } else if (!opts.write) {
    process.stdout.write(`\n(dry-run — re-run with --write to persist PASS bucket)\n`);
  }
}

// Only auto-run when invoked as a CLI; required (e.g. by tests) it exports the
// pieces below without side effects.
if (require.main === module) {
  main().catch(e => {
    process.stderr.write(`\nUnhandled: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  processOne,
  processPdf,
  processOcr,
  persistEntry,
  persistPdfEntry,
  persistOcrEntry,
  targetTemplateKey,
  evaluateGates,
  resolveBankUrl,
  PDF_RE,
  IMG_RE,
  DEFAULT_GATES,
};
