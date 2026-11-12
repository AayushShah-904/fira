#!/usr/bin/env node
'use strict';

/**
 * Template authoring CLI.
 *
 * Sprint 006 Phase A.3 / Step 1d. The ONLY path that writes `template`
 * blocks into data/bank-domains.json. The agent never auto-writes.
 *
 * Flow:
 *   1. Resolve bank from data/bank-domains.json
 *   2. Fetch the rate page via lib/fetch/fetch_html.js (or --from-file for offline)
 *   3. Compute fingerprint via lib/templating/fingerprint.js
 *   4. Scan existing template blocks for a matching template_hash; suggest reuse [y/N]
 *   5. On cluster miss, run LLM-propose flow (requires AOAI; stubbable via --no-llm)
 *   6. Replay the chosen extractor against the fetched HTML; print slabs + diff vs baseline
 *   7. --write persists via lib/safe-write.js with operator [y/N] confirmation
 *
 * Refusal: agent-mode invocations CAN do everything except --write (which requires
 * TTY). The LLM-propose flow is what the agent does well; operator review is the
 * trust boundary, not the proposal itself.
 *
 * Design: ../sdlc/sprints/sprint-006/design/author-template-cli.md
 *
 * Usage:
 *   node scripts/author-template.js <bank-code> [options]
 *
 * Options:
 *   --variant <name>       regular | nre | nro | fcnr | gift   (default: regular)
 *   --from-url <url>       Override URL from registry
 *   --from-file <path>     Skip fetch; use captured HTML from this path
 *   --reuse-template <id>  Skip fingerprint match; reuse this template_id
 *   --propose              Run LLM-propose even if fingerprint matches existing
 *   --no-llm               Skip LLM-propose; print fingerprint only
 *   --write                Persist to data/bank-domains.json (default: dry-run)
 *   --help                 Show usage
 *
 * Exit codes:
 *   0  success
 *   2  usage error / missing bank
 *   3  fetch failed
 *   4  no rate table identified
 *   11 refused (agent + --write)
 *   12 refused (no TTY + --write)
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { fetchHtml } = require('../lib/fetch/fetch_html');
const { fingerprintPage } = require('../lib/templating/fingerprint');
const { safeWriteArtifact } = require('../lib/safe-write');
const { pickExtractor } = require('../lib/extractors/dispatch');
const { detectAgentEnvironment, detectCiEnvironment } = require('../lib/quality-gate/signed-accepts');
const { proposeTemplate } = require('../lib/templating/llm_propose');

const REPO_ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'data', 'bank-domains.json');
const BASELINE_DIR = path.join(REPO_ROOT, 'tmp', 'baseline-pre-reset', 'output-latest');

const VARIANT_TO_RATE_KEY = {
  regular: 'fd',
  nre: 'fd_nre',
  nro: 'fd_nro',
  fcnr: 'fd_fcnr',
  gift: 'fd_gift',
};

function fail(code, message) {
  process.stderr.write(`author-template: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    bankCode: null,
    variant: 'regular',
    fromUrl: null,
    fromFile: null,
    reuseTemplate: null,
    propose: false,
    noLlm: false,
    write: false,
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--variant' || a === '-v') out.variant = args[++i];
    else if (a === '--from-url') out.fromUrl = args[++i];
    else if (a === '--from-file') out.fromFile = args[++i];
    else if (a === '--reuse-template') out.reuseTemplate = args[++i];
    else if (a === '--propose') out.propose = true;
    else if (a === '--no-llm') out.noLlm = true;
    else if (a === '--write') out.write = true;
    else if (!a.startsWith('-') && !out.bankCode) out.bankCode = a;
    else fail(2, `unknown argument: ${a}`);
  }
  return out;
}

function printUsage() {
  process.stdout.write(`author-template — author a template block for one bank

Usage:
  node scripts/author-template.js <bank-code> [options]

Options:
  --variant <name>       regular | nre | nro | fcnr | gift   (default: regular)
  --from-url <url>       Override URL from data/bank-domains.json
  --from-file <path>     Skip fetch; use captured HTML from this path
  --reuse-template <id>  Skip fingerprint match; reuse this template_id (operator override)
  --propose              Run LLM-propose flow even if fingerprint matches existing
  --no-llm               Skip LLM-propose; print fingerprint only
  --write                Persist to data/bank-domains.json (default: dry-run)
  --help                 Show this message

Examples:
  # Dry-run authoring on a bank — fetches, fingerprints, suggests reuse or LLM-proposes
  node scripts/author-template.js apna-sahakari-bank-ltd --variant regular

  # Author against a captured HTML fixture (offline)
  node scripts/author-template.js axis-bank-limited --from-file tests/golden-html/axis-bank-limited.html

  # Persist after operator review
  node scripts/author-template.js psb-state-bank-of-india --reuse-template psb-pdf-rate-card-3col --write
`);
}

async function promptConfirm(question, { defaultYes = false } = {}) {
  if (!process.stdin.isTTY) {
    // Non-interactive: refuse confirmation
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      const t = String(ans).trim();
      // Default-yes mode: empty input or "y"/"yes" returns true; only explicit "n"/"no" returns false.
      // Default-no mode: explicit "y"/"yes" required; anything else returns false (back-compat).
      if (defaultYes) resolve(t === '' || /^y(es)?$/i.test(t));
      else resolve(/^y(es)?$/i.test(t));
    });
  });
}

// Summarize a single extract block — used during per-block accept/decline
// prompts so the operator sees what they're voting on at a glance.
function summarizeExtractBlock(blockIdx, block, slabs) {
  const tag = block.deposit_range ? ` deposit_range=${block.deposit_range}` : '';
  const out = [`Block ${blockIdx}: table_index=${block.table_index ?? 0}${tag} — ${slabs.length} slab(s)`];
  if (slabs.length > 0) {
    const first = slabs[0];
    const last = slabs[slabs.length - 1];
    out.push(`  first: ${truncate(first.tenure_text, 35)} g=${first.rate_general_pct} s=${first.rate_senior_pct ?? '-'} ss=${first.rate_super_senior_pct ?? '-'} [${first.deposit_range}]`);
    if (slabs.length > 1) {
      out.push(`  last:  ${truncate(last.tenure_text, 35)} g=${last.rate_general_pct} s=${last.rate_senior_pct ?? '-'} ss=${last.rate_super_senior_pct ?? '-'} [${last.deposit_range}]`);
    }
    // Unique deposit_range values across this block's slabs (shows whether
    // amount-bucket coalescing fired)
    const ranges = Array.from(new Set(slabs.map(s => s.deposit_range)));
    if (ranges.length > 1) out.push(`  deposit_ranges in slabs: ${ranges.join(', ')}`);
  }
  return out.join('\n');
}

// Per-block accept/decline. Used when an LLM proposal has 2+ extract blocks
// (e.g., HDFC retail + bulk, BoB retail + 1cr-3cr + bulk-7-buckets) and the
// operator may want to accept some and reject others (e.g., decline a special-
// schemes table that scored high but isn't a real rate card).
//
// Returns the filtered list of accepted blocks. If only one block was
// proposed, returns it unchanged without prompting — the overall persist
// confirm at the end of the flow covers the single-block case.
async function selectAcceptedBlocks(extracts, allSlabs) {
  if (!Array.isArray(extracts) || extracts.length <= 1) return extracts;
  if (!process.stdin.isTTY) return extracts; // dry-run / non-interactive

  // Group slabs by source extract block. Heuristic: each slab carries its
  // deposit_range; match to the block whose column_map produces that
  // deposit_range. Falls back to "first block claims it" when matching is
  // ambiguous (shouldn't happen with well-formed proposals).
  const slabsByBlock = extracts.map(() => []);
  outer: for (const slab of allSlabs) {
    // Try direct deposit_range match against block.deposit_range
    for (let i = 0; i < extracts.length; i++) {
      const e = extracts[i];
      if (e.deposit_range && slab.deposit_range && e.deposit_range === slab.deposit_range) {
        slabsByBlock[i].push(slab); continue outer;
      }
    }
    // Try column_map @tag match
    for (let i = 0; i < extracts.length; i++) {
      const e = extracts[i];
      const ranges = new Set(Object.values(e.column_map || {})
        .map(v => { const at = v.indexOf('@'); return at >= 0 ? v.slice(at + 1) : null; })
        .filter(Boolean));
      if (slab.deposit_range && ranges.has(slab.deposit_range)) {
        slabsByBlock[i].push(slab); continue outer;
      }
    }
    // Coalesced or fallback: assign to first matching by source_row_text
    // (rough heuristic — works when source_row_text doesn't repeat across blocks)
    slabsByBlock[0].push(slab);
  }

  process.stdout.write(`\n=== Per-block accept/decline (${extracts.length} blocks proposed) ===\n`);
  const accepted = [];
  for (let i = 0; i < extracts.length; i++) {
    process.stdout.write(`\n${summarizeExtractBlock(i, extracts[i], slabsByBlock[i])}\n`);
    const ok = await promptConfirm(`Accept block ${i}? [Y/n] `, { defaultYes: true });
    if (ok) accepted.push(extracts[i]);
    else process.stdout.write(`  → declined\n`);
  }
  return accepted;
}

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) fail(2, `registry not found at ${REGISTRY_PATH}`);
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')); }
  catch (e) { fail(2, `failed to parse registry: ${e.message}`); }
}

function findClusterMatch(registry, templateHash) {
  const matches = [];
  for (const [slug, entry] of Object.entries(registry)) {
    if (entry && entry.template && entry.template.template_hash === templateHash) {
      matches.push({ slug, template_id: entry.template.template_id });
    }
  }
  return matches;
}

async function fetchHtmlForAuth({ bankCode, variant, fromUrl, fromFile, registry, log }) {
  if (fromFile) {
    const absPath = path.isAbsolute(fromFile) ? fromFile : path.join(REPO_ROOT, fromFile);
    if (!fs.existsSync(absPath)) fail(3, `--from-file not found: ${absPath}`);
    return { html: fs.readFileSync(absPath, 'utf-8'), url: `file://${absPath}`, source: 'file' };
  }
  const bank = registry[bankCode];
  if (!bank) fail(2, `bank "${bankCode}" not in registry`);
  let url = fromUrl;
  if (!url) {
    const rateKey = VARIANT_TO_RATE_KEY[variant];
    const pagePath = bank.rate_pages && bank.rate_pages[rateKey];
    if (!pagePath) fail(2, `no rate_pages.${rateKey} for bank "${bankCode}" — use --from-url`);
    const host = bank.domain;
    url = pagePath.startsWith('http') ? pagePath : `https://${host}${pagePath.startsWith('/') ? '' : '/'}${pagePath}`;
  }
  const templateFetch = (bank.template && bank.template.fetch) || {};
  log.info(`[fetch] ${url}`);
  const result = await fetchHtml({ url, templateFetch, log });
  if (result.status !== 'success') {
    fail(3, `fetch failed: status=${result.status}, final_strategy=${result.final_strategy}, attempts=${JSON.stringify(result.attempts.map(a => ({rung: a.rung, outcome: a.outcome})))}`);
  }
  return { html: result.html, url, source: 'live', fetch_result: result };
}

function dispatchAndReplay({ templateId, html, bankCode, log, persistedExtract }) {
  // When previewing a cluster-matched bank, the operator-facing template_id is
  // a clustering label (e.g., "sscb-amount-tiered-4bucket") which usually has
  // no matching extractor module. The actual runtime module is at
  // `bank.template.extract.extractor` (typically "_generic-html-3col"). Prefer
  // that for dispatch, fall back to the label.
  const dispatchTemplateId = (persistedExtract && persistedExtract.extractor) || templateId;
  const dispatch = pickExtractor({ templateId: dispatchTemplateId, kind: 'html_static', productContext: { bank_code: bankCode } });
  if (!dispatch.extractor) {
    log.warn(`[dispatch] no extractor matched: ${dispatch.reason}`);
    return { slabs: [], diagnostics: null, dispatch };
  }
  // Pass the persisted extract config so the cluster-match preview reflects
  // what runtime actually does (extracts array, column_map, table_index, etc.)
  const templateExtract = persistedExtract || {};
  const result = dispatch.extractor({ html, templateExtract, productContext: { bank_code: bankCode } });
  return { slabs: result.slabs, diagnostics: result.diagnostics, dispatch };
}

function loadBaselineSlabs(bankCode, variant) {
  const suffix = variant === 'regular' ? '_rates.json' : `_${variant}_rates.json`;
  const p = path.join(BASELINE_DIR, `${bankCode}${suffix}`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}

/**
 * Side-by-side preview: for each LLM-proposed extract block, walk the source
 * table rows and print each row's raw cells next to the slab(s) it produced
 * (or the drop reason if it didn't). Lets the operator verify the column_map
 * is mapping the right columns and that no rows are silently lost before
 * saying y/N to persist.
 */
function printSideBySide(html, extractBlocks, replayResult) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const tables = [];
  $('table').each((tIdx, el) => {
    const $t = $(el);
    const rows = [];
    $t.find('tr').each((_, tr) => {
      const cells = [];
      $(tr).find('th,td').each((_, c) => cells.push($(c).text().replace(/\s+/g, ' ').trim()));
      if (cells.length) rows.push(cells);
    });
    tables.push({ index: tIdx, rows });
  });

  const allSlabs = replayResult.slabs || [];
  // Index slabs by source_row_text so we can find which slab(s) a given source
  // row produced (one row may produce multiple slabs when @deposit_range tags
  // are present — e.g., one tenure row → one slab per amount bucket).
  const slabsByRowText = new Map();
  for (const s of allSlabs) {
    if (!s.source_row_text) continue;
    if (!slabsByRowText.has(s.source_row_text)) slabsByRowText.set(s.source_row_text, []);
    slabsByRowText.get(s.source_row_text).push(s);
  }

  const diagBlocks = (replayResult.diagnostics && replayResult.diagnostics.extract_blocks) || [];

  process.stdout.write(`\n=== Side-by-side: source rows ↔ extracted slabs ===\n`);

  for (let b = 0; b < extractBlocks.length; b++) {
    const block = extractBlocks[b];
    const diag = diagBlocks[b] || {};
    const tIdx = block.table_index ?? 0;
    const t = tables[tIdx];
    const depositTag = block.deposit_range ? ` deposit_range=${block.deposit_range}` : '';
    process.stdout.write(`\n--- Block ${b}: table_index=${tIdx} header_row=${block.header_row} span=${block.header_span_rows}${depositTag} ---\n`);
    if (!t) {
      process.stdout.write(`  (table index ${tIdx} not found on page — ${tables.length} table(s) total)\n`);
      continue;
    }
    if (diag.error) {
      process.stdout.write(`  (extractor reported: ${diag.error})\n`);
    }
    process.stdout.write(`  column_map: ${JSON.stringify(block.column_map)}\n`);

    // Header rows: show with column indices so the operator can sanity-check
    // the column_map.
    const headerRow = block.header_row ?? 0;
    const headerSpan = block.header_span_rows ?? 1;
    for (let i = 0; i < headerSpan; i++) {
      const row = t.rows[headerRow + i];
      if (!row) continue;
      const indexed = row.map((c, idx) => `[${idx}]${truncate(c, 40)}`).join('  ');
      process.stdout.write(`  HEAD r${headerRow + i}: ${indexed}\n`);
    }

    // Data rows: print raw cells, then the slab(s) (or drop reason)
    const dataStart = headerRow + headerSpan;
    let rowsPrinted = 0;
    for (let i = dataStart; i < t.rows.length; i++) {
      const row = t.rows[i];
      const rowText = row.join(' ').replace(/\s+/g, ' ').trim();
      const matchedSlabs = slabsByRowText.get(rowText) || [];
      const cellsCompact = row.map((c, idx) => `[${idx}]${truncate(c, 25)}`).join(' ');
      process.stdout.write(`  r${String(i).padStart(2)}: ${truncate(cellsCompact, 200)}\n`);
      if (matchedSlabs.length > 0) {
        for (const s of matchedSlabs) {
          const ten = `${s.tenure_min_days}..${s.tenure_max_days == null ? '∞' : s.tenure_max_days}d`;
          const rangeTag = s.deposit_range ? ` [${s.deposit_range}]` : '';
          process.stdout.write(`        → tenure="${truncate(s.tenure_text, 30)}" (${ten}) g=${s.rate_general_pct} s=${s.rate_senior_pct ?? '-'} ss=${s.rate_super_senior_pct ?? '-'}${rangeTag}\n`);
        }
      } else {
        process.stdout.write(`        ✗ no slab produced (likely dropped — see aggregate reasons below)\n`);
      }
      rowsPrinted++;
      if (rowsPrinted >= 30) {
        process.stdout.write(`  ... (${t.rows.length - i - 1} more rows in this table — truncated for display)\n`);
        break;
      }
    }
  }

  const dropped = (replayResult.diagnostics && replayResult.diagnostics.rows_dropped_reasons) || {};
  const dropEntries = Object.entries(dropped);
  if (dropEntries.length > 0) {
    process.stdout.write(`\n  Drop reasons (aggregate across all blocks): ${dropEntries.map(([k, v]) => `${k}=${v}`).join(', ')}\n`);
  }
}

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function printDiff(label, slabs, baseline) {
  process.stdout.write(`\n=== ${label} ===\n`);
  process.stdout.write(`extracted slabs: ${slabs.length}\n`);
  if (slabs.length > 0) {
    for (const s of slabs.slice(0, 5)) {
      process.stdout.write(`  ${s.tenure_text} | general=${s.rate_general_pct ?? '-'} senior=${s.rate_senior_pct ?? '-'}\n`);
    }
    if (slabs.length > 5) process.stdout.write(`  ... +${slabs.length - 5} more\n`);
  }
  if (baseline) {
    const baseSlabs = (baseline.rate_slabs || []).filter(s => s.tenure_min_days != null);
    process.stdout.write(`baseline (tmp/baseline-pre-reset) slabs: ${baseSlabs.length}\n`);
    process.stdout.write(`delta: ${slabs.length - baseSlabs.length} slabs\n`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.bankCode) { printUsage(); process.exit(opts.help ? 0 : 2); }

  // Refusal checks for --write (LLM-propose is safe under agents; only persistence requires operator)
  if (opts.write) {
    const ci = detectCiEnvironment();
    if (ci.isCI) fail(10, `--write refused under CI (${ci.reason})`);
    const ag = detectAgentEnvironment();
    if (ag.isAgent) fail(11, `--write refused inside AI-agent session (${ag.reason}) — open a fresh shell and re-run`);
    if (!process.stdin.isTTY) fail(12, `--write requires a TTY for operator confirmation`);
  }

  const log = {
    info: (m) => process.stdout.write(`[info] ${m}\n`),
    warn: (m) => process.stderr.write(`[warn] ${m}\n`),
    debug: () => {},
    error: (m) => process.stderr.write(`[error] ${m}\n`),
  };

  const registry = loadRegistry();
  const bank = registry[opts.bankCode];

  // Fetch
  const { html, url, source } = await fetchHtmlForAuth({
    bankCode: opts.bankCode,
    variant: opts.variant,
    fromUrl: opts.fromUrl,
    fromFile: opts.fromFile,
    registry,
    log,
  });

  // Snapshot HTML
  const snapDir = path.join(REPO_ROOT, 'tmp', 'author', opts.bankCode);
  if (source === 'live') {
    fs.mkdirSync(snapDir, { recursive: true });
    // safe-write-exempt: phase-A.3 authoring snapshot under tmp/author/<bank>/; not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(path.join(snapDir, `${opts.variant}.html`), html);
    log.info(`snapshot: ${path.join(snapDir, opts.variant + '.html')}`);
  }

  // Fingerprint
  const fp = fingerprintPage({ html, url, kind: 'html' });
  process.stdout.write(`\n=== Fingerprint ===\n`);
  process.stdout.write(`template_hash: ${fp.template_hash}\n`);
  process.stdout.write(`reason:        ${fp.reason}\n`);
  process.stdout.write(`framework:     ${(fp.structural_signature.framework_hint || []).join(',') || '-'}\n`);
  process.stdout.write(`slab_bucket:   ${fp.structural_signature.slab_bucket}\n`);
  process.stdout.write(`candidate tables: ${fp.candidate_tables.length}\n`);

  // Cluster match
  let chosenTemplateId = opts.reuseTemplate;
  // Extract-config carried out of the propose flow so the persist block can
  // serialize column_map / table_index / header_row. Without this, runtime
  // re-extraction falls back to header-token inference and yields 0 slabs
  // for any bank whose header text isn't in the 4-token vocabulary
  // ({tenure, regular, senior, super_senior}). Wave 1 (2026-05-24) accepted
  // 8 templates that all extracted 0 slabs at runtime because this scope hoist
  // was missing.
  let proposedExtract = null;
  if (!chosenTemplateId && !opts.propose) {
    const matches = findClusterMatch(registry, fp.template_hash);
    if (matches.length > 0) {
      process.stdout.write(`\n=== Cluster match ===\n`);
      process.stdout.write(`template_id: ${matches[0].template_id} used by ${matches.length} other bank(s):\n`);
      for (const m of matches.slice(0, 5)) process.stdout.write(`  - ${m.slug}\n`);
      if (matches.length > 5) process.stdout.write(`  ... +${matches.length - 5} more\n`);
      const reuse = opts.write
        ? await promptConfirm(`\nReuse template_id "${matches[0].template_id}"? [y/N] `)
        : true; // dry-run: auto-accept the suggestion for the replay preview
      if (reuse) chosenTemplateId = matches[0].template_id;
    }
  }

  // Replay
  if (chosenTemplateId) {
    // For cluster-matched banks, pass the persisted extract config so the
    // preview reflects runtime behavior (without it, dispatchAndReplay would
    // call the extractor with empty templateExtract and produce 0 slabs even
    // when the persisted block works fine).
    const persistedExtract = bank && bank.template && bank.template.extract ? bank.template.extract : null;
    const { slabs, diagnostics, dispatch } = dispatchAndReplay({ templateId: chosenTemplateId, html, bankCode: opts.bankCode, log, persistedExtract });
    const baseline = loadBaselineSlabs(opts.bankCode, opts.variant);
    printDiff(`Replay with template_id="${chosenTemplateId}"`, slabs, baseline);
    if (diagnostics) {
      process.stdout.write(`rows_seen=${diagnostics.rows_seen}, rows_kept=${diagnostics.rows_kept}\n`);
    }
    // Side-by-side for cluster-matched preview too. Honor both shapes:
    // the new `extracts: [...]` and the legacy single-block (top-level
    // column_map / table_index / header_row) by wrapping legacy into a
    // single-element array for display.
    if (persistedExtract && diagnostics) {
      const displayExtracts = Array.isArray(persistedExtract.extracts) && persistedExtract.extracts.length > 0
        ? persistedExtract.extracts
        : (persistedExtract.column_map ? [{
            table_index: persistedExtract.table_index ?? 0,
            header_row: persistedExtract.header_row ?? 0,
            header_span_rows: persistedExtract.header_span_rows ?? 1,
            column_map: persistedExtract.column_map,
            deposit_range: null,
          }] : null);
      if (displayExtracts) printSideBySide(html, displayExtracts, { slabs, diagnostics });
    }
  } else if (opts.noLlm) {
    process.stdout.write(`\n--no-llm: skipping LLM-propose flow. No template_id chosen.\n`);
  } else {
    // Sprint 006 Step 1h: real LLM-propose flow (was stubbed in Step 1d).
    process.stdout.write(`\n=== LLM-propose ===\n`);
    process.stdout.write(`No cluster match. Calling AOAI to propose template...\n`);
    try {
      const { proposal, raw_response } = await proposeTemplate({
        bankCode: opts.bankCode,
        variant: opts.variant,
        url,
        html,
        logger: log,
      });
      process.stdout.write(`\nProposed template_id: ${proposal.template_id_suggestion}\n`);
      process.stdout.write(`Reason: ${proposal.reason}\n`);
      process.stdout.write(`extracts (${proposal.extracts.length} block(s)):\n`);
      for (const e of proposal.extracts) {
        const tag = e.deposit_range ? ` deposit_range=${e.deposit_range}` : '';
        process.stdout.write(`  table_index=${e.table_index} header_row=${e.header_row}${tag} column_map=${JSON.stringify(e.column_map)}\n`);
      }
      if (proposal.wait_hints) process.stdout.write(`wait_hints: ${JSON.stringify(proposal.wait_hints)}\n`);
      if (proposal.click_to_reveal) process.stdout.write(`click_to_reveal: ${JSON.stringify(proposal.click_to_reveal)}\n`);

      // Replay through _generic-html-3col with the proposed extracts to show
      // what slabs the operator would get if they accept this template.
      const { extract: genericExtract } = require('../lib/extractors/_generic-html-3col');
      const replayResult = genericExtract({
        html,
        templateExtract: { extracts: proposal.extracts, tenure_cap_days: proposal.tenure_cap_days },
        productContext: { bank_code: opts.bankCode },
      });
      const baseline = loadBaselineSlabs(opts.bankCode, opts.variant);
      printDiff(`Replay with LLM-proposed template_id="${proposal.template_id_suggestion}"`, replayResult.slabs, baseline);
      if (replayResult.diagnostics && replayResult.diagnostics.extract_blocks) {
        for (const b of replayResult.diagnostics.extract_blocks) {
          if (b.error) {
            process.stdout.write(`  block table_index=${b.table_index}: ERROR ${b.error}\n`);
          } else {
            const tag = b.deposit_range ? ` deposit_range=${b.deposit_range}` : '';
            process.stdout.write(`  block table_index=${b.table_used_index}${tag}: rows_seen=${b.rows_seen}, rows_kept=${b.rows_kept}\n`);
          }
        }
      }

      // Side-by-side: show each source row next to the extracted slab(s) so
      // the operator can spot mis-mapped columns, dropped rows, or wrong table
      // pick before saying y/N.
      printSideBySide(html, proposal.extracts, replayResult);
      if (proposal.template_id_suggestion && replayResult.slabs.length > 0) {
        chosenTemplateId = proposal.template_id_suggestion;
        // Carry the full proposal forward to the persist block. We persist
        // `extract.extractor = '_generic-html-3col'` (the actual module) and
        // keep the LLM's template_id_suggestion only as the top-level cluster
        // label. Without this, dispatch.pickExtractor returns "unresolved"
        // for any LLM-coined template_id and runtime extraction yields 0 slabs.
        proposedExtract = {
          extracts: proposal.extracts,
          tenure_cap_days: proposal.tenure_cap_days,
        };
      } else if (!proposal.template_id_suggestion) {
        process.stdout.write(`\nLLM could not identify a template. Run with --reuse-template <id> if you know which template applies.\n`);
        process.exit(4);
      } else {
        process.stdout.write(`\nReplay produced 0 slabs with the proposed column_map. Operator review needed before accepting.\n`);
        process.exit(4);
      }
    } catch (err) {
      if (err.code === 'AOAI_NOT_CONFIGURED') {
        process.stdout.write(`\nAOAI not configured (set AZURE_OPENAI_ENDPOINT + key). Run with --reuse-template <id> if you know which template applies.\n`);
        process.exit(4);
      }
      process.stderr.write(`\nLLM-propose failed: ${err.message}\n`);
      process.exit(1);
    }
  }

  // Persist
  if (opts.write && chosenTemplateId) {
    // Per-block accept/decline. Only fires when there are 2+ blocks; lets
    // operator drop e.g. a special-schemes table that scored high but isn't
    // a real rate card. Re-runs the extractor with the filtered list so the
    // final slab count reflects only accepted blocks.
    if (proposedExtract && Array.isArray(proposedExtract.extracts) && proposedExtract.extracts.length > 1) {
      const { extract: genericExtract } = require('../lib/extractors/_generic-html-3col');
      const replayBefore = genericExtract({ html, templateExtract: { extracts: proposedExtract.extracts, tenure_cap_days: proposedExtract.tenure_cap_days }, productContext: { bank_code: opts.bankCode } });
      const accepted = await selectAcceptedBlocks(proposedExtract.extracts, replayBefore.slabs);
      if (accepted.length === 0) {
        process.stdout.write(`\n0 blocks accepted — aborting (no template persisted)\n`);
        process.exit(0);
      }
      proposedExtract.extracts = accepted;
      if (accepted.length < replayBefore.slabs.length) {
        const replayAfter = genericExtract({ html, templateExtract: { extracts: accepted, tenure_cap_days: proposedExtract.tenure_cap_days }, productContext: { bank_code: opts.bankCode } });
        process.stdout.write(`\nFinal: ${accepted.length} block(s) accepted → ${replayAfter.slabs.length} slabs\n`);
      }
    }

    const confirmed = await promptConfirm(`\nPersist template block for "${opts.bankCode}" (${opts.variant}) to data/bank-domains.json? [y/N] `);
    if (!confirmed) { process.stdout.write(`aborted by operator\n`); process.exit(0); }

    // Determine which extractor MODULE to dispatch to at runtime. If the
    // LLM-coined template_id_suggestion matches a registered extractor module
    // (e.g., "coop-bankin-3col-tenure-general-senior"), use that; otherwise
    // fall back to "_generic-html-3col" which knows how to consume the saved
    // extracts array. This keeps the LLM's clustering label available at the
    // top level while ensuring dispatch.pickExtractor always resolves.
    const { listRegistered } = require('../lib/extractors/dispatch');
    const registered = new Set(listRegistered());
    const extractorModule = proposedExtract && !registered.has(chosenTemplateId)
      ? '_generic-html-3col'
      : chosenTemplateId;

    const extract = { extractor: extractorModule };
    if (proposedExtract) {
      if (Array.isArray(proposedExtract.extracts) && proposedExtract.extracts.length > 0) {
        extract.extracts = proposedExtract.extracts;
      }
      if (proposedExtract.tenure_cap_days != null) extract.tenure_cap_days = proposedExtract.tenure_cap_days;
    }
    const block = {
      template_id: chosenTemplateId,
      template_hash: fp.template_hash,
      fingerprinted_at: new Date().toISOString().slice(0, 10),
      fingerprinted_from_url: url,
      fetch: (bank.template && bank.template.fetch) || {},
      extract,
      variants: bank.template && bank.template.variants ? bank.template.variants : { [opts.variant]: { rate_page_key: VARIANT_TO_RATE_KEY[opts.variant] } },
    };
    const newEntry = { ...bank, template: { ...(bank.template || {}), ...block } };
    const newRegistry = { ...registry, [opts.bankCode]: newEntry };
    safeWriteArtifact({
      path: REGISTRY_PATH,
      incoming: newRegistry,
      kind: 'registry-file',
      source: 'operator',
      logger: log,
    });
    process.stdout.write(`\nwrote template block for ${opts.bankCode}\n`);
    process.stdout.write(`[METRIC] template_persisted bank=${opts.bankCode} template_id=${chosenTemplateId} variant=${opts.variant}\n`);
  } else if (!opts.write) {
    process.stdout.write(`\n(dry-run — re-run with --write to persist)\n`);
  }
}

main().catch((e) => fail(1, `unhandled error: ${e.stack || e.message}`));
