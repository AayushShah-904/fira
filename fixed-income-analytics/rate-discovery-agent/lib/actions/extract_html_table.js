'use strict';

/**
 * Action: extract_html_table — deterministic-first with LLM fallback.
 *
 * Sprint 003 #1a contract (A3) — see sdlc/sprints/sprint-003/design/action-contracts.md.
 *
 * Three paths layered in priority order:
 *
 *   1. Deterministic (regex parser on cached_body OR via the dispatcher) —
 *      cheap, no LLM cost. Wins on banks with clean rate tables matching
 *      the default column mapping.
 *
 *   2. LLM fallback (Sprint 003 #1c follow-up) — when deterministic returns
 *      zero slabs OR `hints.prefer_llm === true` AND AZURE_OPENAI_ENDPOINT
 *      is configured, the action sends the page's `<table>` segments to a
 *      focused JSON-only extraction prompt and parses the response. Closes
 *      the ~104 "dispatcher returned 0" gap measured in Track 2.
 *
 *   3. Null (per CLAUDE.md) when both paths fail.
 *
 * Operator-approved additions from Q5/Q7 are preserved:
 *
 *   - `hints.cached_body` — when provided, parses the HTML directly without
 *     re-fetching. Closes the .bank.in TLS-bundle issue AND lets the refresh
 *     pipeline reuse cached bodies without an extra HTTP round trip.
 *
 *   - FCNR/GIFT variant support with per-slab `currency` tagging.
 *
 *   - PNB-style ambiguous-column rejection.
 *
 *   - Slab dedup.
 *
 *   - Multi-table warning.
 *
 * Still deferred:
 *
 *   - cheerio-based canonical-table picking via `config.selectors.table`.
 *
 *   - Focused LLM call for effective_date (separate from the slab-extraction
 *     fallback). The existing regex remains for now; BoB "1st July 1995" is
 *     a known false-positive class.
 *
 * Input:
 *   {
 *     url: string,
 *     kind: "html_static" | "html_js",
 *     product_type?: string,                 // default "FD"
 *     variant?: string,                      // default "regular"; accepts nre|nro|fcnr|gift
 *     config?: object,                       // optional pre-loaded bank config
 *     hints?: {
 *       cached_body?: string,                // pre-fetched HTML; when present, no live fetch
 *       selectors?: object,
 *       column_mapping?: object,             // overrides config.column_mapping
 *       expected_slab_count?: number,        // used by LLM-fallback trigger
 *       expected_currencies?: string[],      // for fcnr/gift
 *       prefer_llm?: boolean,                // force LLM fallback to fire
 *       scraper_notes?: object,              // forwarded to LLM prompt
 *       // Bank context (added 2026-05-17): inlined in LLM extraction prompt
 *       // so the model knows which bank's page it's looking at. Mirrors the
 *       // CLAUDE.md path's user-prompt format. Optional; older callers
 *       // without this set still work, just without the grounding.
 *       bank_name?: string,
 *       bank_type?: string,                  // PSB | PVB | SFB | ...
 *       bank_code?: string,
 *       state?: string,
 *       category?: string,
 *       cached_notes?: string,               // free-text notes from bank-domains.json
 *     }
 *   }
 *
 * Output (success):
 *   {
 *     ok: true,
 *     slabs: Array<...>,                     // each slab has currency on fcnr/gift
 *     effective_date: string|null,
 *     warnings: string[],
 *     extraction_method: "automatic_html_static" | "automatic_html_js",
 *     path_used: "deterministic",            // see deferred LLM-fallback note
 *     product_type, variant,
 *   }
 *
 * Output (failure):
 *   null  (per CLAUDE.md; caller writes _rates.json with rate_slabs: []).
 */

const {
  extractHtmlStatic,
  extractHtmlJs,
  parseHtmlTables,
  extractSlabsFromTable,
  extractEffectiveDateFromHtml,
} = require('../../scripts/extract_rates');

const { extractScoredTables, extractTableChunks, extractTableTierLabel } = require('./_cheerio_tables');
const { parseTenure } = require('../../scripts/utils/parse-tenure');
const cheerio = require('cheerio');
// Orch-1 (sprint-004 2026-05-21): multi-table extraction with section
// context. Both helpers are bank-agnostic.
const { headingToDepositRange } = require('./_cheerio_heading_range');
const { captureSectionContext, interpretSectionContext } = require('./_cheerio_section_context');
// FCNR-4a (2026-05-22): normalise LLM-emitted currency codes
// ("EURO" → "EUR", "YEN" → "JPY", "USD (Above 5L)" → "USD") so dedup +
// pack-build treat synonyms as one currency.
// Fix A (sprint-011 2026-07-07): detectCurrencyTokens scans free chunk text
// for distinct currency tokens (ISO codes + spelled-out names) so the LLM
// chunk selection can target the currency-keyed matrix on consolidated pages.
const { normaliseCurrency, detectCurrencyTokens } = require('../../scripts/utils/normalise-currency');

const HTML_KINDS = new Set(['html_static', 'html_js']);
const VALID_VARIANTS = new Set(['regular', 'nre', 'nro', 'fcnr', 'gift']);

/**
 * FCNR Fix #1 (sprint-004 2026-05-23): count distinct currency markers
 * in this table.
 *
 * Scans the header rows (first 3) AND first column of data rows for
 * recognizable currency codes (via `normaliseCurrency`). Returns the
 * COUNT of distinct currencies found — Pattern B (cols) + Pattern A
 * (rows) — so callers can rank candidate tables and pick the best
 * FCNR-shaped one on the page.
 *
 * Caller usage:
 *   - countTableCurrencyMarkers(rows) === 0 → reject for fcnr/gift
 *   - countTableCurrencyMarkers(rows) >= 1 → candidate; rank against
 *     other candidates by this count to pick the best
 *
 * Reuses `normaliseCurrency` from `scripts/utils/normalise-currency.js`
 * which already knows the canonical alias map (USD/GBP/EUR/JPY/CAD/AUD +
 * EURO→EUR/YEN→JPY synonyms + AED/QAR/SAR/etc).
 *
 * Called from the table picker ONLY when variant ∈ {fcnr, gift}.
 * For regular/NRE/NRO this filter must NOT apply (they're INR-denominated).
 *
 * @param {string[][]} rows - 2D row-major cells from extractScoredTables
 * @returns {number} count of distinct currency codes detected (0+)
 */
function countTableCurrencyMarkers(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return 0;
  const found = new Set();

  // Pattern B check — currencies in column headers (top row, and the
  // optional second sub-header row that some banks use: "USD | USD | GBP"
  // with row-2 splitting USD into amount tiers).
  const headerRows = rows.slice(0, Math.min(3, rows.length));
  for (const row of headerRows) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const c = normaliseCurrency(cell);
      if (c) found.add(c);
    }
  }

  // Pattern A check — currencies in column 0 OR column 1 of data rows.
  // Some banks (PNB observed 2026-05-23) put column 0 = "S.No." and
  // column 1 = currency code, so col 0 alone misses the markers. Scan
  // both leading columns of the first ~20 data rows.
  for (let r = 1; r < Math.min(rows.length, 20); r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length === 0) continue;
    for (let c = 0; c < Math.min(row.length, 2); c++) {
      const code = normaliseCurrency(row[c]);
      if (code) found.add(code);
    }
  }

  return found.size;
}

/**
 * Back-compat boolean wrapper for tableHasCurrencyMarkers. Returns true
 * when the table has ≥ 1 currency marker. Used by call sites that don't
 * need the count, only the binary "is this currency-bearing" answer.
 */
function tableHasCurrencyMarkers(rows) {
  return countTableCurrencyMarkers(rows) > 0;
}
const CURRENCY_VARIANTS = new Set(['fcnr', 'gift']);
const DEFAULT_COLUMN_MAPPING = { '0': 'tenure_text', '1': 'rate_general_pct', '2': 'rate_senior_pct' };

/**
 * Maximum HTML chars to send to the LLM. Raised 30k → 120k on 2026-05-17
 * after the orchestrator-LLM-usage audit (sdlc/sprints/sprint-003/...):
 * gpt-4.1-mini has 128k+ context; the previous 30k cap silently dropped
 * banners/headings/tab-labels that disambiguate multi-variant pages.
 */

async function extractHtmlTable(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('extractHtmlTable: input must be an object');
  }
  const { url, kind, product_type, variant, config: providedConfig, hints } = input;

  if (!url || typeof url !== 'string') throw new Error('extractHtmlTable: input.url is required');
  if (!HTML_KINDS.has(kind)) {
    throw new Error(`extractHtmlTable: input.kind must be one of ${[...HTML_KINDS].join(', ')} (got "${kind}")`);
  }
  const v = variant || 'regular';
  if (!VALID_VARIANTS.has(v)) {
    throw new Error(`extractHtmlTable: unsupported variant "${v}"`);
  }

  const config = providedConfig
    ? { ...providedConfig }
    : { bank_code: '(unknown)', scraper_type: kind, rate_page_urls: { fd: url } };
  if (hints?.column_mapping) config.column_mapping = hints.column_mapping;
  if (hints?.selectors) config.selectors = hints.selectors;
  if (hints?.scraper_notes) config.scraper_notes = { ...(config.scraper_notes || {}), ...hints.scraper_notes };
  config.rate_page_urls = { ...(config.rate_page_urls || {}), fd: url };

  const warnings = [];
  let slabs = [];
  let effectiveDate = null;
  // Orch-1 (sprint-004 2026-05-21): per-table page list emitted by the new
  // multi-table accumulator. Each entry is `{ variant, slabs, deposit_range_hint,
  // section_heading, notes, signals, table_index, page_number }`. The
  // orchestrator's M2.6 PDF-style aggregation absorbs this directly. Empty
  // for the LLM-fallback or legacy single-payload paths — orchestrator falls
  // back to the flat `slabs` array in those cases.
  let htmlPages = [];
  let pathUsed = 'deterministic';
  let extractionMethod = kind === 'html_static' ? 'automatic_html_static' : 'automatic_html_js';
  // Keep the cached body around for LLM fallback (may be supplied directly
  // OR captured during the dispatcher path below).
  let bodyForFallback = null;
  // Track AOAI usage when the LLM fallback runs; orchestrator rolls these
  // up into per-run cost telemetry. null means LLM never fired.
  const llmUsages = [];

  // ── Path A: cached HTML provided → parse it inline ─────────────────
  let pathAUsed = false;
  if (typeof hints?.cached_body === 'string' && hints.cached_body.length > 0) {
    const html = hints.cached_body;
    bodyForFallback = html;

    if (detectAmbiguousColumns(html)) {
      // Don't reject outright — pre-Phase-4 these pages went through Path B
      // (live dispatcher) which has no ambiguous-columns guard and parsed
      // them fine. Push a warning so the LLM trigger picks up the suspicion;
      // then fall through to Path B for the same fetch+parse pre-Phase-4
      // would have done. The cached body stays in bodyForFallback for LLM.
      warnings.push('ambiguous_columns: existing-vs-revised or W.E.F.-dated two-column layout detected on cached_body; falling through to live dispatcher');
    } else {
      pathAUsed = true;
    }
  }

  if (pathAUsed) {
    const html = hints.cached_body;

    // Selector-aware canonical-table picking. When config.selectors.table is
    // a recognised pattern, restrict parsing to matching <table> blocks. This
    // closes the "regex picker grabs a non-rate table with one rate-shaped
    // row" failure class observed in the Track 2 measurement (HSBC, Kotak,
    // Axis, Bandhan family all reported dispatcher_count=1 because the
    // wrong table won).
    const selectorPattern = config.selectors && config.selectors.table;
    let candidateHtml = html;
    if (selectorPattern && typeof selectorPattern === 'string') {
      const filtered = filterHtmlByTableSelector(html, selectorPattern);
      if (filtered.matched > 0) {
        candidateHtml = filtered.html;
        warnings.push(`canonical_table_selector: matched ${filtered.matched} <table>(s) via "${selectorPattern}"`);
      } else if (filtered.recognised) {
        warnings.push(`canonical_table_selector: "${selectorPattern}" matched 0 tables — falling back to default scan`);
      }
      // else: selector wasn't recognised by the in-house matcher; we already
      // logged a one-off warning via Recognized flag handling. Fall back
      // silently to default scan.
    }

    // Cheerio multi-table picker. Returns tables sorted by score so the
    // first hit is the most-likely-rate-table. Falls back to the legacy
    // regex parseHtmlTables if cheerio finds nothing (e.g., malformed HTML
    // edge cases). See lib/actions/_cheerio_tables.js for scoring details.
    let scoredTables = extractScoredTables(candidateHtml);
    if (scoredTables.length === 0) {
      const legacyTables = parseHtmlTables(candidateHtml);
      scoredTables = legacyTables.map((rows, i) => ({ index: i, rows, score: 1, signals: {} }));
    }

    if (scoredTables.length > 0) {
      const rateBearing = scoredTables.filter((t) => t.score > 0).length;
      if (rateBearing > 1) {
        warnings.push(`multi_table: ${scoredTables.length} tables on page (${rateBearing} rate-bearing by score)`);
      }

      const columnMapping = (config.column_mapping && Object.keys(config.column_mapping).length > 0)
        ? config.column_mapping
        : DEFAULT_COLUMN_MAPPING;

      // Orch-1 (sprint-004 2026-05-21): multi-table accumulator with
      // section-context interpretation.
      //
      // OLD behaviour: walked scored tables, picked the ONE yielding the most
      // slabs, dropped the rest. Lost HDFC's 3-5cr bucket and similar multi-
      // table layouts. Surfaced by the M4 probe's investigation of HDFC's
      // 8-table FD page.
      //
      // NEW behaviour: keep every scored table that yields ≥1 slab. For each,
      // derive (a) the table's `deposit_range` from the nearest preceding
      // heading, (b) the section's `fulfills_variants`, senior-exclusion,
      // and minimum-tenor rules from the section heading + notes. Fan out
      // to one page entry per fulfilled variant, applying per-variant
      // overrides (drop senior column, filter min-tenor). Return a `pages`
      // array; the orchestrator's M2.6 PDF-style aggregation absorbs it
      // unchanged.
      //
      // Filter the pages list to ONLY entries matching the iteration's
      // requested `variant` arg before returning. The orchestrator iterates
      // products and calls extract_html_table once per product; each call
      // emits only its product's pages. (Avoids the bookkeeping needed if
      // one extraction tried to commit all variants at once.)
      htmlPages = [];
      let tableEntries = []; // candidate (table, slabs, ctx, interp) before dedup
      for (const t of scoredTables) {
        if (t.score <= 0) continue;
        const candidateSlabs = extractSlabsFromTable(t.rows, columnMapping);
        if (candidateSlabs.length === 0) continue; // textual / non-rate table; drop

        // Orch-1 secondary filter: drop tables where the majority of slabs
        // lack a parseable tenure. Indian-banking pages put terms /
        // definitions / premature-withdrawal tables alongside rate tables;
        // these tables often have ONE column that looks like a percentage
        // and ONE column that looks like text labels ("Additional Premium",
        // "Premature Closure"). extractSlabsFromTable will produce slabs
        // for them but none of them parse into a tenure. Drop the table
        // when fewer than half its slabs have a parseable tenure bound.
        //
        // Fix #8 (sprint-004 2026-05-23): small special-scheme tables
        // (e.g., RAP30 / FD365 / NAVATHI-900 / 400-day-URP) carry
        // scheme-name labels in column 0 that don't parse as tenures, but
        // they're real rate emissions — losing them dropped 4 cohort #1
        // banks (citizen-credit, sbpp-killa-pardi, district-co-op-srikakulam,
        // uttarakhand-state) by 3-6 slabs each. Keep tables with 4-10
        // scheme-named rows where every label contains a digit (the
        // distinguishing signal vs noisy text-only callouts). Slabs emit
        // with null tenure bounds — consumers render these as scheme rows.
        const withTenure = candidateSlabs.filter((s) => Number.isFinite(s.tenure_min_days) || Number.isFinite(s.tenure_max_days)).length;
        const isSmallSchemeTable = candidateSlabs.length >= 4
          && candidateSlabs.length <= 10
          && withTenure === 0
          && candidateSlabs.every((s) => /\d/.test(s.tenure_text || ''));
        if (withTenure < candidateSlabs.length / 2 && !isSmallSchemeTable) {
          warnings.push(`multi_table_filter: dropped table[${t.index}] (only ${withTenure}/${candidateSlabs.length} slabs had parseable tenures — likely textual content)`);
          continue;
        }
        if (isSmallSchemeTable) {
          warnings.push(`special_scheme_table: kept table[${t.index}] with ${candidateSlabs.length} scheme-named rows (first label: "${candidateSlabs[0].tenure_text}") — slabs emitted with null tenure_min_days/tenure_max_days`);
        }

        // FCNR Fix #1 (sprint-004 2026-05-23): for fcnr/gift variant, the
        // table MUST exhibit currency markers — either Pattern A (currency
        // codes in column 0 of data rows) or Pattern B (currency codes in
        // header row). Without this, the picker scored INR bulk-FD tables
        // (which have 11+ columns showing deposit-amount tiers) higher than
        // the actual FCNR currency-keyed matrix, then the post-tagger
        // default-filled all slabs with USD via the missing-currency
        // fallback. Result was "wrong table, wrong currency, wrong data"
        // for canara/PNB/IDBI/city-union/punjab-sind/dhanlaxmi/karnataka.
        if (CURRENCY_VARIANTS.has(v) && !tableHasCurrencyMarkers(t.rows)) {
          warnings.push(`fcnr_table_filter: dropped table[${t.index}] for variant=${v} — no currency markers (USD/GBP/EUR/...) in header row or first data column; this is likely an INR bulk-FD table that scored high but isn't an FCNR/GIFT matrix`);
          continue;
        }

        // Section + per-table heading context. `$el` and `$` were added to
        // each scored-table entry by `extractScoredTables` (Orch-1 change to
        // `_cheerio_tables.js`).
        //
        // `captureSectionContext` returns both:
        //   - `section_heading` (most-prominent heading, e.g., HDFC's <h2>
        //     "Domestic / NRO / NRE FIXED DEPOSIT RATE")
        //   - `nearest_heading_text` (closest heading, used for the
        //     deposit_range derivation)
        // So we use ONE call instead of two (extractTableTierLabel +
        // captureSectionContext) — equivalent output, fewer DOM walks.
        let sectionCtx = { section_heading: null, nearest_heading_text: null, effective_date_text: null, notes: [] };
        try {
          if (t.$ && t.$el) {
            sectionCtx = captureSectionContext(t.$, t.$el, 2000);
          }
        } catch (_) { /* defensive — bad DOM shouldn't break extraction */ }
        // deposit_range derivation: try the nearest preceding heading first;
        // if that yields no match (or no heading exists), fall back to the
        // table's caption / first-row header cells. Indian PVB pages
        // commonly put the deposit_range right in the table header row
        // (e.g., HDFC's `Tenor Bucket | < ₹3 Crore | Senior Citizen Rates`)
        // rather than as a preceding heading.
        let depositRange = headingToDepositRange(sectionCtx.nearest_heading_text);
        if (!depositRange) {
          try {
            const captionText = (t.$el && t.$ ? (t.$el.find('caption').first().text() || '') : '').trim();
            depositRange = headingToDepositRange(captionText) || depositRange;
          } catch (_) {}
        }
        if (!depositRange && Array.isArray(t.rows) && t.rows.length > 0) {
          // Probe the first 2 rows' cells for amount-range text. Most pages
          // put it in cell index 1 of the header row, but some banks use a
          // multi-row header where row 0 is column labels and row 1 has
          // sub-labels — checking both is cheap.
          const probe = [...(t.rows[0] || []), ...(t.rows[1] || [])].join(' | ');
          depositRange = headingToDepositRange(probe) || depositRange;
        }
        const interp = interpretSectionContext(sectionCtx);
        tableEntries.push({
          table_index: t.index,
          slabs: candidateSlabs,
          deposit_range_hint: depositRange,
          section_heading: sectionCtx.section_heading,
          notes: sectionCtx.notes,
          interp,
          signals: t.signals,
        });
      }

      // Dedupe near-duplicate tables (same section_heading + first-data-row
      // signature; prefer the table with more columns to preserve senior).
      // HDFC's table[0] (3 cols) and table[1] (2 cols) hit this case.
      const dedupedEntries = dedupeTableEntries(tableEntries);
      const droppedDup = tableEntries.length - dedupedEntries.length;
      if (droppedDup > 0) {
        warnings.push(`multi_table_dedup: dropped ${droppedDup} near-duplicate rate table(s) (same heading + same first row)`);
      }

      // Variant fan-out. Each table emits one page per fulfilled variant,
      // with per-variant overrides applied.
      //
      // When `fulfills_variants` was DEFAULTED (no recognised variant tokens
      // in the section heading — common case for single-variant pages), we
      // trust the orchestrator's iteration variant `v` instead of forcing
      // ['regular']. This matches the pre-Orch-1 behavior where the slabs
      // got committed to whatever variant the orchestrator asked for.
      //
      // When the heading explicitly listed variants (e.g., HDFC's
      // "Domestic / NRO / NRE FIXED DEPOSIT RATE"), we honor that list and
      // filter to the iteration's variant — other variants get emitted on
      // their own product iteration.
      for (const e of dedupedEntries) {
        const variants = (e.interp.fulfills_variants_is_default === true)
          ? [v]
          : (e.interp.fulfills_variants && e.interp.fulfills_variants.length > 0
              ? e.interp.fulfills_variants
              : [v]);
        for (const fulVariant of variants) {
          // When fulfills was defaulted we already substituted `v`, so this
          // filter is a no-op there. When it was explicit, we filter so each
          // orchestrator product iteration emits only its variant's pages.
          if (fulVariant !== v) continue;

          let variantSlabs = e.slabs.map((s) => ({ ...s }));
          if (e.interp.senior_excluded_for.includes(fulVariant)) {
            for (const s of variantSlabs) s.rate_senior_pct = null;
          }
          const minDays = e.interp.min_tenor_days_by_variant[fulVariant];
          if (Number.isFinite(minDays) && minDays > 0) {
            const before = variantSlabs.length;
            variantSlabs = variantSlabs.filter((s) => Number.isFinite(s.tenure_min_days) ? s.tenure_min_days >= minDays : true);
            if (variantSlabs.length < before) {
              warnings.push(`min_tenor_filter:${fulVariant}: dropped ${before - variantSlabs.length} slab(s) with tenure_min_days < ${minDays}`);
            }
          }
          // Tag deposit_range if not already present on the slab
          if (e.deposit_range_hint) {
            for (const s of variantSlabs) {
              if (!s.deposit_range) s.deposit_range = e.deposit_range_hint;
            }
          }
          if (variantSlabs.length === 0) continue;
          htmlPages.push({
            page_number: e.table_index + 1, // 1-indexed like PDF pages
            table_index: e.table_index,
            variant: fulVariant,
            slabs: variantSlabs,
            deposit_range_hint: e.deposit_range_hint,
            section_heading: e.section_heading,
            notes: e.notes,
            signals: e.signals,
          });
        }
      }

      // Surface unrecognised notes as warnings (one entry per unique note
      // across all tables) so the operator sees what the parser didn't act on.
      const unrecognised = new Set();
      for (const e of dedupedEntries) for (const n of e.interp.raw_notes) unrecognised.add(n);
      if (unrecognised.size > 0) {
        warnings.push(`section_notes_unparsed: ${unrecognised.size} note(s) preserved but not converted to rule overrides: ${[...unrecognised].slice(0, 3).join(' | ')}`);
      }

      // Flat slabs (back-compat for callers that don't read `pages`):
      // concatenate all pages' slabs. The legacy single-winner path used to
      // populate this; we now derive it from the multi-table output.
      slabs = htmlPages.flatMap((p) => p.slabs);

      if (htmlPages.length > 0 && rateBearing > 1) {
        const pageVariants = htmlPages.map((p) => `t${p.table_index}/${p.variant}`).join(', ');
        warnings.push(`multi_table_pages: emitted ${htmlPages.length} page(s) → ${pageVariants}`);
      }
    }
    effectiveDate = extractEffectiveDateFromHtml(html);
    for (const p of htmlPages) {
      if (!p.effective_date) p.effective_date = effectiveDate;
    }
  }

  if (!pathAUsed) {
    // ── Path B: live fetch via existing dispatcher ───────────────────
    let raw;
    try {
      raw = kind === 'html_static' ? await extractHtmlStatic(config) : extractHtmlJs(config);
    } catch (err) {
      // Dispatcher threw; we can still try LLM fallback if we can fetch.
      raw = null;
    }
    if (raw && Array.isArray(raw.slabs) && raw.slabs.length > 0) {
      slabs = raw.slabs;
      effectiveDate = raw.effectiveDate || null;
      if (Array.isArray(raw.warnings)) warnings.push(...raw.warnings);
    }
    // Playwright dispatcher returns rendered page_html. Always run the
    // cheerio multi-table picker on it — even when the in-browser picker
    // returned some slabs, cheerio may pick a better table or surface a
    // div-based "table" the in-browser scan missed (Liferay portlets and
    // React/Vue rate grids). Keep whichever path yielded more slabs.
    if (raw && typeof raw.pageHtml === 'string') {
      bodyForFallback = raw.pageHtml;
      // FCNR Fix #1b (sprint-004 2026-05-23): pass the iteration's variant
      // so the legacy single-winner picker can skip non-currency tables
      // for fcnr/gift variants (PNB/canara/idbi/city-union etc. — same
      // class as the multi-table accumulator fix in lines 247-313).
      const cheerioCand = extractWithCheerio(raw.pageHtml, config, warnings, v);
      if (cheerioCand && cheerioCand.length > slabs.length) {
        warnings.push(`cheerio_html_js: dispatcher returned ${slabs.length} slabs; cheerio multi-table picker found ${cheerioCand.length} — using cheerio result`);
        slabs = cheerioCand;
        extractionMethod = 'automatic_html_js';
      }
    }
  }

  // ── Path C: LLM fallback ───────────────────────────────────────────
  // Triggers when ANY of:
  //   - deterministic produced no slabs;
  //   - hints.prefer_llm forces it;
  //   - the deterministic picker fired a `multi_table` warning (it knows the
  //     table choice was ambiguous — exactly the HSBC/Kotak/Axis/Bandhan
  //     class measured in Track 2 where dispatcher returned 1 wrong slab);
  //   - we know expected_slab_count and got back < half of it;
  //   - the variant is FCNR/GIFT (multi-currency layout — cheerio's column-
  //     mapping approach can't pivot currency-as-columns tables like SBI's
  //     FCNR page which shows 6 tenures × 6 currencies = 36 slabs but
  //     cheerio reads as 6 rows / 6 slabs);
  //   - ambiguous_columns warning was pushed (Path A detected existing-vs-
  //     revised W.E.F. layout — cheerio's column index will be wrong).
  // We still need a body to send and the LLM configured.
  const preferLlm = !!hints?.prefer_llm;
  const llmConfigured = !!process.env.AZURE_OPENAI_ENDPOINT;
  const expectedSlabCount = Number(hints?.expected_slab_count) || 0;
  // Multi-table ambiguity surfaces in different warnings depending on the path:
  //   Path A (cached_body) — `multi_table: N tables ...`
  //   Path A (post-pick)   — `cheerio_picker: chose table[i]` (only when 2+ tables)
  //   Path B (live fetch)  — `cheerio_html_js: ...` and/or `cheerio_multi_table: ...`
  //   `canonical_table_selector: ... matched 0` — picker fell back to default scan
  //   `ambiguous_columns: ...` — Path A detected W.E.F. two-column layout
  const sawMultiTableAmbiguity = warnings.some((w) => typeof w === 'string' && (
    w.startsWith('multi_table')
    || w.startsWith('cheerio_multi_table')
    || w.startsWith('cheerio_html_js')
    || w.startsWith('cheerio_picker')
    || w.startsWith('ambiguous_columns')
    || /canonical_table_selector.*matched 0/.test(w)
  ));
  const tooFewSlabs = expectedSlabCount > 0 && slabs.length > 0 && slabs.length < Math.ceil(expectedSlabCount * 0.5);
  // Multi-currency variants (FCNR, GIFT) almost always pivot currencies as
  // columns — cheerio can't unpivot, so its slab count is structurally wrong.
  // When we have a body + expected_currencies hint + LLM, just always defer.
  const isMultiCurrencyVariant = (v === 'fcnr' || v === 'gift')
    && Array.isArray(hints?.expected_currencies) && hints.expected_currencies.length > 1;
  const deterministicSuspect = sawMultiTableAmbiguity || tooFewSlabs || isMultiCurrencyVariant;
  const shouldTryLlm = (slabs.length === 0 || preferLlm || deterministicSuspect) && bodyForFallback && llmConfigured;

  if (shouldTryLlm) {
    try {
      // Compare LLM vs deterministic on the dedup-equivalent slab count, NOT
      // the raw count. Otherwise extractors that emit many near-identical
      // rows (e.g., when TENURE_RE fails to populate min/max so dedup collapses
      // them all to one) lose unfairly to an LLM with fewer-but-unique slabs.
      // AU SFB v2 surfaced this: deterministic 37 → dedup to 2; LLM had 11
      // valid slabs but the comparison saw 37 ≥ 11 and kept deterministic.
      const deterministicSlabCount = dedupSlabs(slabs).length;
      const llmResult = await extractViaLlmFromHtml({
        html: bodyForFallback,
        variant: v,
        product_type: product_type || 'FD',
        expectedCurrencies: hints?.expected_currencies,
        bankContext: {
          bank_name: hints?.bank_name,
          bank_type: hints?.bank_type,
          bank_code: hints?.bank_code,
          state: hints?.state,
          category: hints?.category,
          expected_slab_count: expectedSlabCount || undefined,
          scraper_notes: hints?.scraper_notes,
          notes: hints?.cached_notes,
          url,
        },
        logger: input.logger,
      });
      // Drain per-chunk usage records (prompt-improvement-2026-05-18: the LLM
      // now fires once per scored table, so usage is a list, not a single
      // record). Roll them up for cost telemetry regardless of whether we
      // adopt the LLM slabs.
      if (Array.isArray(llmResult?.llm_usages) && llmResult.llm_usages.length > 0) {
        llmUsages.push(...llmResult.llm_usages);
      } else if (llmResult?.usage) {
        llmUsages.push({ model: llmResult.model, usage: llmResult.usage, action: 'extract_html_table_llm', variant: v });
      }

      // New errors[] contract: when the model self-reports blocking issues
      // (truncation, unreadable column, competing W.E.F. dates), the slabs
      // it produced are untrustworthy. Surface the errors as warnings and
      // skip adopting LLM output — fall back to deterministic.
      const llmErrors = Array.isArray(llmResult?.errors) ? llmResult.errors : [];
      if (llmErrors.length > 0) {
        warnings.push(`llm_errors_present: keeping deterministic (LLM reported: ${llmErrors.slice(0, 3).join('; ').slice(0, 240)})`);
        if (Array.isArray(llmResult?.warnings)) warnings.push(...llmResult.warnings.slice(0, 5));
      } else if (llmResult && Array.isArray(llmResult.slabs) && llmResult.slabs.length > 0) {
        // Only adopt LLM result if it beats deterministic. Avoid downgrading
        // a 10-slab deterministic hit to a 4-slab LLM hit when LLM was fired
        // only because of a multi_table warning.
        if (llmResult.slabs.length >= deterministicSlabCount) {
          slabs = llmResult.slabs;
          effectiveDate = effectiveDate || llmResult.effective_date || null;
          if (deterministicSlabCount === 0) {
            warnings.push(`llm_fallback: deterministic returned 0 slabs; LLM extracted ${llmResult.slabs.length}`);
          } else {
            warnings.push(`llm_fallback: deterministic returned ${deterministicSlabCount} slabs (suspect: multi_table=${sawMultiTableAmbiguity} too_few=${tooFewSlabs}); LLM extracted ${llmResult.slabs.length} — using LLM`);
          }
          if (Array.isArray(llmResult.warnings)) warnings.push(...llmResult.warnings);
          pathUsed = 'llm_fallback';
          extractionMethod = 'llm_inline_extraction';
        } else {
          warnings.push(`llm_fallback_skipped: deterministic ${deterministicSlabCount} ≥ LLM ${llmResult.slabs.length}; keeping deterministic`);
        }
      } else {
        // Either LLM returned null (API error / non-JSON / no body) or 0 slabs.
        // Record this so we can tell the difference between "trigger never fired"
        // and "trigger fired but LLM produced nothing usable" in post-mortem.
        warnings.push(`llm_fallback_no_result: deterministic returned ${deterministicSlabCount} slabs; LLM produced no usable slabs (trigger: zero=${deterministicSlabCount === 0} suspect=${deterministicSuspect} prefer=${preferLlm})`);
      }
    } catch (err) {
      if (input.logger?.warn) input.logger.warn(`extract_html_table LLM fallback failed: ${err.message}`);
      // Fall through with empty slabs.
    }
  }

  // ── Path D: text-pattern fallback (A15, sprint-004) ────────────────
  // Last-resort scan of the page's visible text for (tenure, rate%) row
  // sequences. Fires when ALL prior paths returned zero OR every slab
  // they produced would be dropped as malformed by the post-processing
  // B3 filter (Equitas FCNR — cheerio's single-cell collapse emits one
  // garbage row that survives length 0 but never survives B3). Covers
  // two bank families the cheerio + LLM combo can't reach:
  //   1. React/Tailwind SPAs with rates in styled <div>s and zero <table>
  //      elements (Equitas FD).
  //   2. Static pages whose single <table> has cells mashed into one big
  //      string so cheerio's column parse fails and the LLM reports
  //      "no rate table found" (Equitas FCNR).
  // Generic: no per-bank selectors; gated on ≥5 rate-shaped patterns to
  // avoid emitting noise on banks where rate-shaped numbers appear in
  // unrelated prose (footnotes, marketing). The B3 malformed-slab filter
  // and dedupSlabs further catch any false-positives downstream.
  const hasUsableSlab = slabs.length > 0 && slabs.some((s) => !isMalformedSlab(s));
  if (!hasUsableSlab && typeof bodyForFallback === 'string' && bodyForFallback.length > 0) {
    const textSlabs = extractViaTextPattern(bodyForFallback, v, hints?.expected_currencies);
    const guard = textPatternMultiCurrencyGuard(textSlabs, v, hints?.expected_currencies);
    if (guard.rejected) {
      warnings.push(guard.reason);
    } else if (textSlabs.length > 0) {
      slabs = textSlabs;
      pathUsed = 'text_pattern_fallback';
      extractionMethod = 'automatic_text_pattern';
      warnings.push(`text_pattern_fallback: deterministic + LLM returned 0 usable; recovered ${textSlabs.length} slab(s) from page text`);
    }
  }

  if (slabs.length === 0) return null;

  // ── Post-processing applied to both paths ──────────────────────────
  if (CURRENCY_VARIANTS.has(v)) {
    const tagged = tagCurrencyForeignVariant(slabs, hints?.expected_currencies, warnings);
    if (tagged.rejected) return rejection(tagged.reason, kind, product_type, v);
    slabs = tagged.slabs;
    // FCNR-3 (2026-05-22): the orchestrator's M2.6 aggregation reads
    // `pages: [...]` (htmlPages) — NOT the flat `slabs` array — when
    // committing. If the LLM-fallback or text-pattern path fired, the
    // htmlPages array still holds the pre-fallback (often empty)
    // deterministic slabs. Without syncing, the post-tagger's currency
    // assignment never reaches the file. Wrap the tagged slabs in a
    // single synthetic page so the orchestrator commits the right shape.
    if (pathUsed === 'llm_fallback' || pathUsed === 'text_pattern_fallback') {
      htmlPages = [{
        page_number: 1,
        table_index: 0,
        product_type,
        variant: v,
        effective_date: effectiveDate,
        slabs: tagged.slabs,
        warnings: [],
        confidence: 'medium',
      }];
    } else {
      // Deterministic Path A: tagged.slabs are NEW objects via spread copy,
      // so the per-page slabs arrays in htmlPages are stale references to
      // the old (untagged) objects. Rebuild htmlPages from the tagged
      // slabs, partitioning by table_index when available.
      if (htmlPages.length > 0) {
        // Build a lookup from old slab identity → tagged version. The
        // tagger preserves slab order and creates one-to-one tagged
        // counterparts, so we can re-flatten by index.
        let cursor = 0;
        for (const p of htmlPages) {
          const n = p.slabs.length;
          p.slabs = tagged.slabs.slice(cursor, cursor + n);
          cursor += n;
        }
      }
    }
  }

  // A2 (slab-quality-anomalies-2026-05-18) — drop non-FD rows that the LLM
  // mistakenly emitted alongside FD slabs. Three families:
  //   (a) FCNR/GIFT savings rows with currency-shaped tenure_text and no
  //       day bounds (e.g., BOI-IBU's 3rd table).
  //   (b) NRE/NRO/regular deposit-amount tier indicators that read as
  //       slabs ("Up to Rs.5.00 lacs", "Above Rs.5.00 lacs but below
  //       Rs.1 Crore") — SBI's NRE/NRO pages embed these between the real
  //       slabs and the page footer.
  //   (c) Penalty / rule rows ("Premature withdrawal", "Penalty for ...")
  //       that emit a rate but aren't deposit rates.
  // For non-FCNR variants we ALSO drop slabs with rate_general_pct < 1.0
  // — Indian FD rates are essentially never sub-1%, but savings rates and
  // penalty caps frequently are.
  const beforeNonFd = slabs.length;
  const NON_FD_TENURE_RE = /^\s*(?:up\s+to\s+rs|above\s+rs|below\s+rs|premature\s+withdraw|penalty|min(?:imum)?\s+deposit|max(?:imum)?\s+amount|partial\s+withdrawal)/i;
  slabs = slabs.filter((s) => {
    const hasNoTenure = s.tenure_min_days == null && s.tenure_max_days == null;
    const tenureLooksLikeCurrency = s.tenure_text
      && (s.tenure_text === s.currency
        || (s.tenure_text.length <= 4 && /^[A-Z]{3,4}$/.test(s.tenure_text)));
    if (hasNoTenure && (tenureLooksLikeCurrency || !s.tenure_text || s.tenure_text.length < 4)) {
      return false; // (a) tenure-less FCNR-style
    }
    if (s.tenure_text && NON_FD_TENURE_RE.test(s.tenure_text)) {
      return false; // (b) + (c) deposit-amount / penalty rows
    }
    // (d) sub-1% rate on INR variants — Indian FD floor is ~3%, sub-1% is
    // savings or penalty. FCNR can dip to 0.x% on JPY so we exclude those
    // variants from this check.
    if (!CURRENCY_VARIANTS.has(v) && typeof s.rate_general_pct === 'number'
        && s.rate_general_pct > 0 && s.rate_general_pct < 1.0) {
      return false;
    }
    return true;
  });
  if (slabs.length < beforeNonFd) {
    warnings.push(`non_fd_filter: dropped ${beforeNonFd - slabs.length} non-FD slab(s) (savings, deposit-tier indicators, penalty rules)`);
  }

  // B3 (sprint-004) — drop malformed slabs from div-table / SPA pages where
  // cheerio's cell extraction concatenated multiple cells (or an entire
  // table fragment) into one tenure_text. Symptoms: tenure_text > 100 chars,
  // tenure_text contains rate-shaped numbers, or tenure_text has 2+ percent
  // signs. These slabs never describe real rates — they're table-text blobs.
  // The LLM-fallback path runs separately and is unaffected by this filter.
  const beforeMalformed = slabs.length;
  slabs = slabs.filter((s) => !isMalformedSlab(s));
  if (slabs.length < beforeMalformed) {
    warnings.push(`malformed_slab_filter: dropped ${beforeMalformed - slabs.length} slab(s) with tenure_text containing concatenated rate/table fragments (div-table extraction artefact)`);
  }

  // A1 (slab-quality-anomalies-2026-05-18) — normalise deposit_range labels
  // to canonical snake_case BEFORE dedup, so "above 1.00 Mn" and
  // "above_1.00_Mn" don't survive as separate slabs. The LLM emits free-
  // text labels across per-table chunks; the canonical list comes from
  // docs/agent/schemas.md (Rate File Schema — Deposit ranges).
  for (const s of slabs) {
    if (s.deposit_range) {
      const canonical = normaliseDepositRange(s.deposit_range);
      if (canonical && canonical !== s.deposit_range) s.deposit_range = canonical;
    }
  }

  slabs = dedupSlabs(slabs);

  if (slabs.length === 0) return null;

  return {
    ok: true,
    slabs,
    // Orch-1: per-table multi-variant pages output (empty when the LLM-
    // fallback or legacy single-payload path produced the slabs). The
    // orchestrator's M2.6 PDF-style aggregation reads this when present
    // and groups by variant.
    pages: htmlPages.length > 0 ? htmlPages : undefined,
    effective_date: effectiveDate,
    warnings,
    extraction_method: extractionMethod,
    path_used: pathUsed,
    product_type: product_type || 'FD',
    variant: v,
    llm_usages: llmUsages.length > 0 ? llmUsages : undefined,
  };
}

/**
 * Dedup near-duplicate scored tables: same section_heading + same first-
 * data-row signature. Prefers the entry with more columns (preserves the
 * senior column when one variant of the same table has it and the other
 * doesn't). Orch-1 sprint-004 — surfaced by HDFC's table[0] (3 cols) and
 * table[1] (2 cols) carrying identical tenure rows.
 */
function dedupeTableEntries(entries) {
  if (entries.length <= 1) return entries.slice();
  const out = [];
  const seen = new Map(); // key → index in `out`
  for (const e of entries) {
    const firstRow = e.slabs[0] || {};
    const sig = [
      (e.section_heading || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80),
      firstRow.tenure_min_days ?? '',
      firstRow.tenure_max_days ?? '',
      firstRow.rate_general_pct ?? '',
    ].join('|');
    if (!seen.has(sig)) {
      seen.set(sig, out.length);
      out.push(e);
      continue;
    }
    // Duplicate signature — keep the one with more rate columns populated.
    const existingIdx = seen.get(sig);
    const existing = out[existingIdx];
    const newCols = countRateColumns(e.slabs[0]);
    const oldCols = countRateColumns(existing.slabs[0]);
    if (newCols > oldCols) {
      out[existingIdx] = e;
    }
  }
  return out;
}

function countRateColumns(slab) {
  if (!slab) return 0;
  let n = 0;
  if (slab.rate_general_pct != null) n++;
  if (slab.rate_senior_pct != null) n++;
  if (slab.rate_super_senior_pct != null) n++;
  return n;
}

/**
 * LLM-fallback path. Per prompt-improvement-2026-05-18:
 *   - Split the page into per-table chunks (extractTableChunks) instead of
 *     sending the whole 120k-char body. Each chunk is one <table> + its
 *     nearest heading + W.E.F. context. Eliminates the silent-truncation
 *     class that produced hallucinated SBI FCNR / BOI-IBU output in the
 *     2026-05-18 smoke.
 *   - Call the LLM concurrently per chunk (capped at 6).
 *   - Post-validate: every emitted slab's `source_row_text` (or
 *     `tenure_text`) must appear verbatim in its source chunk. Slabs that
 *     don't trace back are dropped — defense in depth against fabrication.
 *   - New JSON contract has `errors[]` (blocking) alongside `warnings[]`
 *     (non-blocking). When merged result has non-empty errors[], the
 *     caller treats the LLM output as untrustworthy.
 *
 * Returns merged `{ slabs, effective_date, warnings, errors, usage, model,
 * llm_usages }` or `null` if no rate-bearing chunks were found / LLM
 * unavailable.
 */
async function extractViaLlmFromHtml({ html, variant, product_type, expectedCurrencies, bankContext, logger }) {
  if (!process.env.AZURE_OPENAI_ENDPOINT) return null;
  if (!html || typeof html !== 'string' || html.length === 0) return null;

  const allChunks = extractTableChunks(html, { maxChunkChars: 30000 });
  // Rate-bearing chunks only. score > 0 means at least one rate-shaped row
  // exists.
  let chunks = allChunks.filter((c) => c.score > 0);
  if (chunks.length === 0) {
    if (logger?.debug) logger.debug(`extractViaLlmFromHtml: no rate-bearing table chunks found in ${html.length}-char body`);
    return null;
  }

  // Fix A (sprint-011, fcnr-yield-root-cause-2026-07-07) — currency-aware
  // chunk selection for fcnr/gift. On consolidated all-variant pages (PNB,
  // UCO, idbi, … — ~13 banks measured), the generic top-6-by-rate-score cap
  // fed the LLM the dominant INR FD tables; the extraction then correctly
  // died at the missing_currency_multi backstop, wasting the LLM calls.
  // Here we (a) keep ONLY currency-bearing chunks (ranked by distinct
  // currency tokens), and (b) fail fast BEFORE any LLM call when the page
  // has no currency-keyed chunk at all (reason: no_currency_chunk) — that
  // distinguishes "matrix exists but was mis-picked" (class A) from "page
  // simply has no FCNR content" (class C) in triage. Runs BEFORE the top-6
  // cap so a matrix buried behind 6 bigger INR tables is still found.
  // Non-fcnr/gift variants are completely unaffected.
  const currencyFilter = filterChunksForCurrencyVariant(chunks, variant, expectedCurrencies);
  if (currencyFilter.rejected) {
    if (logger?.warn) logger.warn(`extractViaLlmFromHtml: ${currencyFilter.reason}`);
    if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(`[extract_html_table:reject] kind=llm_chunk_filter variant=${variant} reason=${currencyFilter.reason}\n`);
    }
    // Structured fail-fast: errors[] flows back through the caller's
    // llm_errors_present branch, so deterministic output is kept (and the
    // missing_currency_multi backstop still guards it). No LLM call made.
    return {
      slabs: [],
      effective_date: null,
      warnings: [],
      errors: [currencyFilter.reason],
      usage: null,
      model: null,
      llm_usages: [],
    };
  }
  if (currencyFilter.filtered) {
    if (logger?.debug) logger.debug(`extractViaLlmFromHtml: variant=${variant} currency-aware chunk filter kept ${currencyFilter.chunks.length}/${chunks.length} chunks (distinct-currency counts: ${currencyFilter.counts.join(',')})`);
    chunks = currencyFilter.chunks;
  }

  // Cap at 6 so a noisy page with 30 footnote-shaped tables doesn't run
  // away with cost.
  chunks = chunks.slice(0, 6);

  // Deployment precedence: explicit EXTRACTION override > MINI (cheap, default
  // for high-volume extraction) > FULL > generic DEPLOYMENT > hard-coded
  // 'gpt-4.1-mini' fallback.
  const deployment = process.env.AZURE_OPENAI_EXTRACTION_DEPLOYMENT
    || process.env.AZURE_OPENAI_DEPLOYMENT_MINI
    || process.env.AZURE_OPENAI_DEPLOYMENT_FULL
    || process.env.AZURE_OPENAI_DEPLOYMENT
    || 'gpt-4.1-mini';

  if (logger?.debug) logger.debug(`extractViaLlmFromHtml: chunks=${chunks.length} deployment=${deployment} variant=${variant}`);

  const { createClient, chatCompletion } = require('../azure-openai-client');
  const client = createClient();
  const prompt = buildHtmlExtractionPrompt(variant, expectedCurrencies, bankContext);

  // Per-chunk LLM call. Concurrent for latency; errors per chunk are
  // localised so one failure doesn't poison the merged result.
  const chunkResults = await Promise.all(chunks.map((c, i) => callLlmOnChunk({
    client,
    deployment,
    prompt,
    chunk: c,
    chunkIndex: i,
    chunkCount: chunks.length,
    logger,
  })));

  const allSlabs = [];
  const allWarnings = [];
  const allErrors = [];
  const llmUsages = [];
  let effectiveDate = null;

  for (let i = 0; i < chunkResults.length; i++) {
    const r = chunkResults[i];
    if (!r) {
      allWarnings.push(`llm_chunk[${i}]: no result (API error or non-JSON)`);
      continue;
    }
    if (r.usage) {
      llmUsages.push({ model: r.model, usage: r.usage, action: 'extract_html_table_llm_chunk', variant, chunk_index: i });
    }
    if (!effectiveDate && r.effective_date) effectiveDate = r.effective_date;

    // Post-validate: every slab's source_row_text (or fallback tenure_text)
    // must trace back to text content in the chunk. Strip HTML tags + entities
    // before matching — LLM emits row text as "tenure rate1 rate2" but the
    // raw HTML has <td>tenure</td><td>rate1</td><td>rate2</td>, so an exact
    // tag-bearing match always fails. Also accept a partial match: tenure_text
    // alone, AND every rate the LLM emitted must literally appear as a digit
    // string in the chunk text (so hallucinated rates still get dropped).
    const chunkText = htmlToText(chunks[i].tableHtml + '\n' + (chunks[i].contextHtml || ''));
    let chunkValidSlabs = 0;
    for (const slab of r.slabs || []) {
      const validation = validateSlabAgainstChunk(slab, chunkText, chunks[i]);
      if (validation.ok) {
        allSlabs.push(slab);
        chunkValidSlabs++;
      } else {
        allWarnings.push(`llm_validation: chunk[${i}] dropped slab; ${validation.reason}`);
      }
    }
    if (Array.isArray(r.warnings)) allWarnings.push(...r.warnings.map((w) => `chunk[${i}]: ${w}`));
    // Per-chunk error scoping (sprint-011, rbl-gift-2026-07-08):
    // `errors[]` is a PER-CHUNK signal — the prompt asks the model to emit an
    // error (with empty rate_slabs) when a given chunk has no extractable rate
    // table (e.g., a fees/charges table that the currency-token count let
    // through as a false positive), or when a rate chunk is truncated/
    // unreadable. Only errors from a chunk that ALSO produced usable slabs are
    // "blocking" — those specific slabs are untrustworthy and must poison the
    // whole LLM adoption (caller keeps deterministic). An error from a chunk
    // that yielded ZERO usable slabs simply means "nothing here"; treating it
    // as a global blocker used to discard every good slab from the OTHER chunks
    // (RBL GIFT: chunk[0] = fees table → "no rates table found" wrongly nuked
    // 60 correct FCNR-matrix slabs from chunk[1]). Downgrade those to warnings.
    if (Array.isArray(r.errors) && r.errors.length > 0) {
      const bucket = chunkValidSlabs > 0 ? allErrors : allWarnings;
      const tag = chunkValidSlabs > 0 ? '' : ' (chunk yielded no slabs — informational, not blocking)';
      for (const e of r.errors) bucket.push(`chunk[${i}]: ${e}${tag}`);
    }
  }

  if (allSlabs.length === 0 && allErrors.length === 0) {
    // No slabs, no explicit errors — treat as nothing-useful so caller falls
    // back to deterministic. Don't synthesize an error.
    if (logger?.warn) logger.warn(`extractViaLlmFromHtml: zero slabs across ${chunks.length} chunks (variant=${variant}, warnings=${JSON.stringify(allWarnings).slice(0, 300)})`);
    return null;
  }

  // Aggregated usage for caller's cost telemetry. Sum tokens across chunks
  // and report the deployment that handled them (all chunks used the same).
  const aggregateUsage = llmUsages.length > 0 ? llmUsages.reduce((acc, u) => ({
    prompt_tokens: (acc.prompt_tokens || 0) + (u.usage?.prompt_tokens || 0),
    completion_tokens: (acc.completion_tokens || 0) + (u.usage?.completion_tokens || 0),
    total_tokens: (acc.total_tokens || 0) + (u.usage?.total_tokens || 0),
  }), {}) : null;

  return {
    slabs: allSlabs,
    effective_date: effectiveDate,
    warnings: allWarnings,
    errors: allErrors,
    usage: aggregateUsage,
    model: deployment,
    llm_usages: llmUsages,
  };
}

/**
 * Fix A (sprint-011, fcnr-yield-root-cause-2026-07-07) — currency-aware
 * chunk selection for multi-currency variants (fcnr/gift).
 *
 * Scores each candidate chunk by the number of DISTINCT currency tokens in
 * its visible text (table + context). Detection is detectCurrencyTokens
 * from scripts/utils/normalise-currency.js: word-boundaried UPPERCASE ISO
 * codes (so "audit" never counts as AUD) PLUS spelled-out names ("US
 * Dollar", "Pound", "Euro", "Yen", …) because some banks (jkb observed
 * 2026-07-07) publish the FCNR grid with names only and zero ISO codes.
 * Bare "Dollar" is never counted — ambiguous across USD/CAD/AUD/SGD/HKD.
 *
 * Threshold: a chunk qualifies with ≥2 distinct currencies — EXCEPT when
 * the orchestrator declares exactly ONE expected currency (single-currency
 * FCNR banks like Saraswat USD-only), where ≥1 qualifies. This mirrors the
 * single-currency carve-out in tagCurrencyForeignVariant.
 *
 * Per-currency-table layout (emirates-nbd observed 2026-07-07): some banks
 * publish ONE table per currency, so every chunk holds exactly 1 distinct
 * token and the ≥2 rule would wrongly fast-fail. When no chunk reaches the
 * threshold but the UNION of single-currency chunks spans ≥2 currencies,
 * all single-currency chunks are kept instead.
 *
 * Returns one of:
 *   { filtered: false, chunks }                        — variant not fcnr/gift; untouched
 *   { filtered: true, rejected: false, chunks, counts } — currency-bearing
 *       chunks only, ranked by distinct-currency count desc (tie: score)
 *   { filtered: true, rejected: true, reason }         — NO chunk qualifies;
 *       caller must fail fast with reason `no_currency_chunk` and make no
 *       LLM call. The missing_currency_multi guard stays as the backstop —
 *       this only saves the doomed LLM round-trip and sharpens triage.
 */
function filterChunksForCurrencyVariant(chunks, variant, expectedCurrencies) {
  if (!CURRENCY_VARIANTS.has(variant)) return { filtered: false, chunks };
  const minDistinct = (Array.isArray(expectedCurrencies) && expectedCurrencies.length === 1) ? 1 : 2;
  const scored = chunks.map((chunk) => ({
    chunk,
    currencies: detectCurrencyTokens(htmlToText(chunk.tableHtml + '\n' + (chunk.contextHtml || ''))),
  }));
  let kept = scored.filter((s) => s.currencies.size >= minDistinct);
  if (kept.length === 0 && minDistinct > 1) {
    // Per-currency-table layout: one table per currency, union spans ≥2.
    const singles = scored.filter((s) => s.currencies.size === 1);
    const union = new Set();
    for (const s of singles) for (const c of s.currencies) union.add(c);
    if (union.size >= 2) kept = singles;
  }
  if (kept.length === 0) {
    const maxSeen = scored.reduce((m, s) => Math.max(m, s.currencies.size), 0);
    return {
      filtered: true,
      rejected: true,
      reason: `no_currency_chunk: variant=${variant} — page has ${chunks.length} rate-bearing table chunk(s) but none contains >=${minDistinct} distinct currency tokens (max seen: ${maxSeen}${Array.isArray(expectedCurrencies) && expectedCurrencies.length > 0 ? `; expected: ${expectedCurrencies.join(',')}` : ''}). The page has no currency-keyed content for this variant; skipping the LLM call rather than extracting an INR table that the missing_currency_multi guard would reject anyway.`,
    };
  }
  kept.sort((a, b) => b.currencies.size - a.currencies.size || (b.chunk.score || 0) - (a.chunk.score || 0));
  return {
    filtered: true,
    rejected: false,
    chunks: kept.map((s) => s.chunk),
    counts: kept.map((s) => s.currencies.size),
  };
}

/**
 * Strip HTML tags + decode common entities for post-validation comparison.
 * Keeps the visible cell text in document order so a probe like
 * "7 days to 30 days 3.40% 1.60%" can match the raw HTML even with <td>...
 * </td> tag interleaving between cells.
 */
function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8377;/gi, '₹')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validate one LLM-emitted slab against the text-stripped chunk content.
 *
 * Acceptance rule: at least ONE of the following must hold:
 *   - `source_row_text` (whitespace-normalised, first ~150 chars) appears in
 *     the chunk text — strongest signal, this is what the prompt asked for.
 *   - `tenure_text` appears in the chunk text AND the `rate_general_pct`
 *     digit string also appears in the chunk text — weaker but catches
 *     cases where the LLM emitted tenure_text verbatim but joined the row
 *     differently in source_row_text.
 *
 * Any slab whose rate doesn't literally appear in the chunk is dropped
 * unconditionally — that's the anti-fabrication backstop. The runtime is
 * deliberately strict here: we lose a few real slabs to LLM paraphrasing
 * but never accept invented numbers.
 */
function validateSlabAgainstChunk(slab, chunkText, chunk) {
  if (!chunkText) return { ok: false, reason: 'empty chunk text' };
  const probe = (slab.source_row_text || '').replace(/\s+/g, ' ').trim();
  const tenure = (slab.tenure_text || '').replace(/\s+/g, ' ').trim();
  const rate = slab.rate_general_pct != null ? String(slab.rate_general_pct) : '';

  // Anti-fabrication backstop: rate digit string MUST appear somewhere.
  if (rate && !chunkText.includes(rate)) {
    return { ok: false, reason: `rate ${rate} not present in chunk text` };
  }

  let ok = false;
  if (probe.length >= 6) {
    const head = probe.slice(0, Math.min(150, probe.length));
    if (chunkText.includes(head)) ok = true;
  }
  if (!ok && tenure.length >= 3 && chunkText.includes(tenure)) ok = true;
  if (!ok) {
    return { ok: false, reason: `neither source_row_text ("${probe.slice(0, 60)}") nor tenure_text ("${tenure}") found in chunk text` };
  }

  // A4 (sprint-004) — backfill deposit_range from the chunk's tier_hint when
  // the LLM forgot to emit it. The hint is verbatim heading text from the
  // page; normaliseDepositRange (called later before dedup) canonicalises
  // it. Only backfills when the slab has no deposit_range AND the chunk
  // has a hint — never overwrites an explicit LLM emission.
  if (!slab.deposit_range && chunk && chunk.tier_hint) {
    slab.deposit_range = chunk.tier_hint;
  }
  return { ok: true };
}

/**
 * Send one chunk to the LLM and parse the JSON response. Returns
 * `{ slabs, effective_date, warnings, errors, usage, model }` or `null` on
 * failure.
 */
async function callLlmOnChunk({ client, deployment, prompt, chunk, chunkIndex, chunkCount, logger }) {
  const { chatCompletion } = require('../azure-openai-client');
  // A4 (sprint-004) — when a per-chunk tier hint is available (the
  // heading immediately preceding the table on the page), surface it
  // to the LLM as a deposit_range hint. The model is asked to emit it
  // verbatim in each slab; normaliseDepositRange canonicalises later.
  const tierLine = chunk.tier_hint
    ? `Deposit tier hint (from the heading immediately preceding this table):\n  "${chunk.tier_hint}"\nSet each slab's "deposit_range" to this verbatim text; the runtime canonicalises afterwards.`
    : '';
  const chunkBody = [
    chunk.contextHtml ? `<context>\n${chunk.contextHtml}\n</context>` : '',
    tierLine,
    `<table_chunk index="${chunkIndex}" of="${chunkCount}">`,
    chunk.tableHtml,
    '</table_chunk>',
  ].filter(Boolean).join('\n');

  if (logger?.debug) logger.debug(`callLlmOnChunk: chunk[${chunkIndex}/${chunkCount}] chars=${chunkBody.length}`);

  let response;
  try {
    response = await chatCompletion(client, {
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: `${prompt.userPrefix}\n\n${chunkBody}` },
      ],
      temperature: 0,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }, { model: deployment, logger: logger?.warn ? logger.warn.bind(logger) : undefined });
  } catch (err) {
    if (logger?.warn) logger.warn(`callLlmOnChunk[${chunkIndex}]: AOAI call failed: ${err.message}`);
    return null;
  }

  const text = response?.choices?.[0]?.message?.content || '';
  const finishReason = response?.choices?.[0]?.finish_reason;
  if (logger?.warn && finishReason && finishReason !== 'stop') {
    logger.warn(`callLlmOnChunk[${chunkIndex}]: finish_reason=${finishReason} response_chars=${text.length}`);
  }
  if (!text) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (logger?.warn) logger.warn(`callLlmOnChunk[${chunkIndex}]: non-JSON response: ${err.message}; head: ${text.slice(0, 200)}`);
    return null;
  }

  return {
    slabs: Array.isArray(parsed.rate_slabs) ? parsed.rate_slabs : [],
    effective_date: parsed.effective_date || null,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    usage: response?.usage || null,
    model: deployment,
  };
}

function buildHtmlExtractionPrompt(variant, expectedCurrencies, bankContext) {
  const isFcnrGift = CURRENCY_VARIANTS.has(variant);
  const currencyClause = isFcnrGift
    ? `Each slab MUST include a "currency" field (e.g., "USD", "GBP", "EUR", "JPY", "CAD", "AUD"). If a tenure shows multiple currencies, emit one slab per (tenure, currency).`
    : `Slabs are INR-denominated; do NOT include a "currency" field.`;
  const seniorClause = isFcnrGift
    ? `FCNR/GIFT slabs have NO senior or super-senior premium — leave "rate_senior_pct" and "rate_super_senior_pct" as null.`
    : `Include "rate_senior_pct" and "rate_super_senior_pct" if the page shows separate columns; otherwise null.`;
  const expected = Array.isArray(expectedCurrencies) && expectedCurrencies.length > 0
    ? `\nExpected currencies for this page (in priority order): ${expectedCurrencies.join(', ')}.`
    : '';
  const variantGuidance = (() => {
    if (variant === 'regular') return 'Pick the table that lists DOMESTIC INR fixed-deposit rates. Ignore NRE / NRO / FCNR / GIFT sections on the same page if they are clearly labelled.';
    if (variant === 'nre') return 'Pick the table that lists NRE (Non-Resident External) INR fixed-deposit rates. NRE is denominated in INR — do not confuse with FCNR (foreign currency).';
    if (variant === 'nro') return 'Pick the table that lists NRO (Non-Resident Ordinary) INR fixed-deposit rates. NRO is denominated in INR.';
    if (variant === 'fcnr') return 'Pick the table(s) that list FCNR (Foreign Currency Non-Resident) deposit rates in foreign currencies (USD/GBP/EUR/JPY/CAD/AUD).';
    if (variant === 'gift') return 'Pick the table(s) that list GIFT City / IFSC Banking Unit deposit rates in foreign currencies (USD/EUR/GBP).';
    return '';
  })();

  const system = [
    'You extract fixed-deposit rate slabs from ONE HTML table block plus its surrounding context. The input is a single <table> the system pre-selected as rate-bearing; do not look for other tables.',
    '',
    'Return ONLY a JSON object (no prose, no markdown fences):',
    '{',
    '  "effective_date": "ISO-8601 date if a w.e.f. / effective / as-on date appears in the <context> or table, else null",',
    '  "rate_slabs": [',
    '    {',
    '      "tenure_text": "VERBATIM text from the tenure cell — do not paraphrase",',
    '      "tenure_min_days": <integer or null>,',
    '      "tenure_max_days": <integer or null>,',
    '      "rate_general_pct": <number>,',
    '      "rate_senior_pct": <number or null>,',
    '      "rate_super_senior_pct": <number or null>,' + (isFcnrGift ? '\n      "currency": "USD" | "GBP" | "EUR" | "JPY" | "CAD" | "AUD",' : ''),
    '      "deposit_range": "<below_3cr|3cr_to_5cr|...>" (only if context labels a tier — else omit),',
    '      "source_row_text": "VERBATIM concatenation of the entire source row\\u0027s cells, space-separated. MUST appear in the input."',
    '    }',
    '  ],',
    '  "warnings": ["non-blocking observations — multi-column tenure, footnote-only data, suspected stale rates"],',
    '  "errors":   ["BLOCKING problems — table appears cut off, column header unreadable, two competing W.E.F. dates, currency column has no header"]',
    '}',
    '',
    "HARD RULES — violating any of these requires emitting EMPTY rate_slabs and an entry in errors[]:",
    "- Do NOT use prior knowledge of typical bank rates. If a rate is not in the input, do NOT output it.",
    "- Every emitted slab's source_row_text MUST appear verbatim in the input. The runtime drops any slab whose source_row_text it can't find — your output is rejected silently if you fabricate.",
    "- Every emitted slab's rate_general_pct MUST be a number whose digit string appears in the row text (e.g., 4.40 → \"4.40\" must be present somewhere in source_row_text).",
    "- If the input table is cut off (last row truncated mid-cell, or column header missing), emit ONLY the rows whose text is fully present, and add \"input_truncated_mid_table\" to errors[].",
    "- For currency-as-columns tables (one tenure row × USD/GBP/EUR/JPY columns), emit one slab per (tenure × currency) — never collapse to one currency, never invent a currency.",
    "- FCNR-1b currency-completeness rule: when the table header lists N currency columns (e.g., USD | GBP | EUR | JPY | CAD | AUD = 6 columns), the emitted slab set MUST span all N distinct currencies. If you can only extract some currencies confidently, STILL emit one slab per (tenure × currency) for every currency in the header — using the value from the row's cell for that column. Partial currency coverage is a fabrication-equivalent error: it makes downstream consumers think those currencies aren't published when they actually are.",
    "- If you cannot extract any slab confidently, return {\"rate_slabs\": [], \"errors\": [\"why\"]}.",
    '',
    currencyClause,
    seniorClause,
    expected,
    'Include EVERY rate row that appears for the requested variant — especially "special tenure" slabs (400 Days, 444 Days, 555 Days, 888 Days, etc.) and the highest-tenure "above N years" slab.',
    'Bulk-deposit tables (≥₹3 Cr / ≥3 Cr) are a different product — set deposit_range to the appropriate tier label, do not skip them.',
  ].filter(Boolean).join('\n');

  // Bank context preface. Mirrors the CLAUDE.md path's user-prompt format
  // (run-discovery.js:200-249) so the model can ground extraction in which
  // bank's page it's looking at — disambiguates footnotes, navigation rates
  // ("savings account 3.00%") from FD slabs, and competing tables.
  const contextLines = [];
  if (bankContext?.bank_name) contextLines.push(`Bank Name: ${bankContext.bank_name}`);
  if (bankContext?.bank_type) contextLines.push(`Bank Type: ${bankContext.bank_type}`);
  if (bankContext?.category)  contextLines.push(`Category: ${bankContext.category}`);
  if (bankContext?.state)     contextLines.push(`State: ${bankContext.state}`);
  if (bankContext?.url)       contextLines.push(`Source URL: ${bankContext.url}`);
  if (bankContext?.expected_slab_count) contextLines.push(`Expected slab count (approximate, from prior runs): ${bankContext.expected_slab_count}`);
  if (bankContext?.scraper_notes) {
    const sn = bankContext.scraper_notes;
    const notes = [];
    if (sn.framework) notes.push(`framework=${sn.framework}`);
    if (sn.bot_protection) notes.push(`bot_protection=${sn.bot_protection}`);
    if (sn.data_format) notes.push(`data_format=${sn.data_format}`);
    if (sn.rate_tables_on_page) notes.push(`rate_tables_on_page=${sn.rate_tables_on_page}`);
    if (sn.has_tabs) notes.push('has_tabs');
    if (sn.has_dropdowns) notes.push('has_dropdowns');
    if (notes.length) contextLines.push(`Scraper notes: ${notes.join(', ')}`);
  }
  if (bankContext?.notes && typeof bankContext.notes === 'string') {
    contextLines.push(`Prior-run notes: ${bankContext.notes.slice(0, 400)}`);
  }
  contextLines.push(`Variant requested: ${variant} (${variant === 'fcnr' || variant === 'gift' ? 'FD foreign-currency' : 'FD INR'}).`);
  if (variantGuidance) contextLines.push(variantGuidance);
  const contextBlock = contextLines.join('\n');

  return {
    system,
    userPrefix: `${contextBlock}\n\nExtract the rate slabs from the following HTML body:`,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * In-house thin CSS-selector matcher for canonical-table picking. Recognises
 * the patterns actually used in `output/latest/*_config.json` files:
 *
 *   - `table` or `*` — match every <table>; not useful for narrowing.
 *   - `table.class1.class2.class3` — match a <table> with ALL these class names.
 *   - `.classN table` / `<container> table` — descendant combinator;
 *     match <table> elements that appear after an opening tag carrying the
 *     ancestor class (best-effort regex; doesn't model real DOM nesting).
 *   - Anything else — not recognised; caller falls back to the default scan.
 *
 * Returns `{ html, matched, recognised }`:
 *   - html: HTML containing only the matching <table> blocks (concatenated)
 *     when matched > 0; otherwise the input html unchanged.
 *   - matched: count of <table> blocks that matched.
 *   - recognised: true when the selector pattern was parseable (even if
 *     0 matched); false when the pattern is too complex for the in-house
 *     matcher (e.g., attribute selectors, pseudo-classes, sibling combinators).
 *
 * This is deliberately a small grammar — cheerio would handle the full CSS
 * selector spec but is currently not installable in the operator's env.
 * Adding cheerio later is straightforward: replace this function's body
 * with `$(selector).map((_, el) => $.html(el)).get().join('\\n')`.
 */
function filterHtmlByTableSelector(html, selector) {
  const trimmed = selector.trim();

  // No-op selectors — every table is candidate.
  if (trimmed === 'table' || trimmed === '*' || trimmed === '') {
    const all = (html.match(/<table[\s\S]*?<\/table>/gi) || []);
    return { html, matched: all.length, recognised: true };
  }

  try {
    const $ = cheerio.load(html);
    const matched = $(trimmed);
    if (matched.length > 0) {
      const htmlOut = matched.map((_, el) => $.html(el)).get().join('\n');
      return { html: htmlOut, matched: matched.length, recognised: true };
    }
  } catch (err) {
    // Fall through to regex-based fallbacks
  }

  // Pattern: `table.class1.class2.class3` — class chain on the <table> tag.
  // Class order in the source HTML doesn't matter; require all classes present.
  const classChain = /^table((?:\.[\w-]+)+)$/.exec(trimmed);
  if (classChain) {
    const required = classChain[1].slice(1).split('.');
    return matchTableByClassChain(html, required);
  }

  // Pattern: `.ancestor table` or `#ancestor table` or `tag table` — descendant.
  // We approximate: find the first ancestor opener whose attribute carries the
  // ancestor selector, then capture <table> blocks that follow it up to the
  // matching closer. This is brittle but covers the common ".tablewrap table"
  // and "#main table" cases observed in real configs.
  const descendant = /^([.#]?[\w-]+)\s+table$/.exec(trimmed);
  if (descendant) {
    return matchTableByDescendant(html, descendant[1]);
  }

  // Pattern: `table[attr=...]` or pseudo-class — out of scope for the in-house matcher.
  return { html, matched: 0, recognised: false };
}

function matchTableByClassChain(html, required) {
  const tableRegex = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  const matches = [];
  let m;
  while ((m = tableRegex.exec(html)) !== null) {
    const attrs = m[1] || '';
    const classMatch = /\bclass\s*=\s*"([^"]*)"|\bclass\s*=\s*'([^']*)'/i.exec(attrs);
    if (!classMatch) continue;
    const classes = (classMatch[1] || classMatch[2] || '').split(/\s+/).filter(Boolean);
    const classSet = new Set(classes);
    if (required.every((r) => classSet.has(r))) {
      matches.push(m[0]);
    }
  }
  return {
    html: matches.length > 0 ? matches.join('\n') : html,
    matched: matches.length,
    recognised: true,
  };
}

function matchTableByDescendant(html, ancestorSelector) {
  // Parse the ancestor selector once.
  let attrName, attrValue;
  if (ancestorSelector.startsWith('.')) {
    attrName = 'class';
    attrValue = ancestorSelector.slice(1);
  } else if (ancestorSelector.startsWith('#')) {
    attrName = 'id';
    attrValue = ancestorSelector.slice(1);
  } else {
    // Bare tag name as ancestor — treat as "any opening of that tag".
    attrName = null;
    attrValue = ancestorSelector.toLowerCase();
  }

  // Find ancestor opener positions.
  let ancestorRegex;
  if (attrName === 'class') {
    ancestorRegex = new RegExp(`<[a-z][\\w-]*\\b[^>]*\\bclass\\s*=\\s*"[^"]*\\b${escapeForRegex(attrValue)}\\b[^"]*"[^>]*>|<[a-z][\\w-]*\\b[^>]*\\bclass\\s*=\\s*'[^']*\\b${escapeForRegex(attrValue)}\\b[^']*'[^>]*>`, 'gi');
  } else if (attrName === 'id') {
    ancestorRegex = new RegExp(`<[a-z][\\w-]*\\b[^>]*\\bid\\s*=\\s*["']${escapeForRegex(attrValue)}["'][^>]*>`, 'gi');
  } else {
    ancestorRegex = new RegExp(`<${escapeForRegex(attrValue)}\\b[^>]*>`, 'gi');
  }

  const matches = [];
  let am;
  while ((am = ancestorRegex.exec(html)) !== null) {
    // Capture tables in the next ~10KB after the ancestor opener (rough
    // proxy for "inside the ancestor"; doesn't model real DOM nesting).
    const start = am.index + am[0].length;
    const window = html.slice(start, start + 10000);
    const tableRegex = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
    let t;
    while ((t = tableRegex.exec(window)) !== null) {
      matches.push(t[0]);
    }
  }
  // Deduplicate by exact-content match.
  const uniq = [...new Set(matches)];
  return {
    html: uniq.length > 0 ? uniq.join('\n') : html,
    matched: uniq.length,
    recognised: true,
  };
}

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * Detect PNB-style ambiguous two-column rate layouts where the page exposes
 * both an "Existing" and "Revised" set of rates (or two different W.E.F.
 * dates side-by-side). The deterministic extractor will pick one column
 * non-deterministically; rejection forces the orchestrator to route the
 * extraction to operator-resolve.
 */
function detectAmbiguousColumns(html) {
  // Pattern A: literal "existing rate" + "revised rate" within a near window.
  if (/existing\s+rate[\s\S]{0,2000}?revised\s+rate/i.test(html)) return true;
  // Pattern B: "existing roi" + "revised roi" (rate of interest abbreviation).
  if (/existing\s+roi[\s\S]{0,2000}?revised\s+roi/i.test(html)) return true;
  // Pattern C: two distinct "W.E.F. <date>" headers/cells INSIDE THE SAME <table> with DIFFERENT dates.
  // Bare page-level W.E.F. dates in separate tables or identical dates across columns are not ambiguous.
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const cleaned = table.replace(/discontinued\s+w\.?e\.?f\.?[^<]*/gi, '');
    const wefMatches = [...cleaned.matchAll(/<(?:th|td)[^>]*>[\s\S]*?w\.?e\.?f\.?\s*[:\-]?\s*(\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4})[\s\S]*?<\/(?:th|td)>/gi)];
    const distinctDates = new Set(wefMatches.map(m => m[1]));
    if (distinctDates.size >= 2) return true;
  }
  return false;
}

/**
 * FCNR-5 (2026-05-22): decide whether to accept the text-pattern fallback's
 * slabs for a multi-currency variant. The text-pattern path is a regex
 * over visible page text — it can latch onto incidental decimal-shaped
 * numbers (footnotes, charts, marketing copy) that have nothing to do
 * with rate cells. For fcnr/gift variants where the operator has
 * declared ≥ 3 expected currencies, refuse a result that only captured
 * 1-2 distinct currencies — it's almost certainly noise that would
 * overwrite a cleaner upstream extraction.
 *
 * Reuse note: this guard intentionally lives in `extract_html_table.js`
 * next to the call site rather than in a shared utility. The companion
 * decision in `extract_via_ocr.js` is a row-count check, not a
 * currency-spread check — different shape, different signal.
 *
 * @param {Array} textSlabs                  — slabs returned by extractViaTextPattern
 * @param {string} variant                   — orchestrator iteration variant
 * @param {Array|undefined} expectedCurrencies — hint from orchestrator
 * @returns {{ rejected: false } | { rejected: true, reason: string }}
 */
function textPatternMultiCurrencyGuard(textSlabs, variant, expectedCurrencies) {
  if (!textSlabs || textSlabs.length === 0) return { rejected: false };
  if (!CURRENCY_VARIANTS.has(variant)) return { rejected: false };
  if (!Array.isArray(expectedCurrencies) || expectedCurrencies.length < 3) {
    return { rejected: false };
  }
  const captured = new Set(textSlabs.map((s) => s.currency).filter(Boolean));
  if (captured.size >= 3) return { rejected: false };
  return {
    rejected: true,
    reason: `text_pattern_fallback_rejected: variant=${variant} expected ${expectedCurrencies.length} currencies but text-pattern captured only ${captured.size} (${[...captured].sort().join(',')}); refusing — likely noise from regex-over-page-text matching incidental decimal-shaped numbers`,
  };
}

/**
 * Tag `currency` on slabs for fcnr/gift variants. If slabs already carry a
 * currency, that wins. If hints supply expected_currencies and the slabs are
 * uniform-shaped (no embedded currency), tag every slab with the first
 * expected currency AND emit a warning so operator can sanity-check.
 *
 * Returns either `{ slabs }` or `{ rejected: true, reason }`.
 */
function tagCurrencyForeignVariant(slabs, expectedCurrencies, warnings) {
  const tagged = slabs.map((s) => ({ ...s }));
  // FCNR-4a: normalise any present currency codes BEFORE checking for
  // missing/peer-default. LLM-emitted "EURO" / "YEN" / "USD (Above 5L)"
  // get rewritten to canonical EUR / JPY / USD.
  for (const s of tagged) {
    if (s.currency) {
      const canon = normaliseCurrency(s.currency);
      if (canon && canon !== s.currency) s.currency = canon;
    }
  }
  const missing = tagged.filter((s) => !s.currency);
  if (missing.length === 0) return { slabs: tagged };

  // If at least one slab DOES have currency, default the others to the same.
  const present = tagged.find((s) => s.currency);
  if (present) {
    for (const s of tagged) if (!s.currency) s.currency = present.currency;
    warnings.push(`currency_default: ${missing.length} fcnr/gift slabs lacked a currency; filled in with "${present.currency}" from peer slab — operator should verify per-currency rows`);
    return { slabs: tagged };
  }

  // FCNR Fix #2 (sprint-004 2026-05-23): none of the slabs carries a
  // currency AND multiple expected currencies declared. This means the
  // extractor picked the wrong table (an INR table that has no currency
  // markers at all — likely an INR bulk-FD table with deposit-tier columns)
  // OR the right table's currency column was missed.
  //
  // BEFORE this fix: default-filled all slabs with expectedCurrencies[0]
  // (typically "USD"). That silently turned a missing-data bug into a
  // wrong-data bug — operator saw 14 slabs all tagged USD with INR tenures
  // like "7 Days to 14 Days" on canara/PNB/idbi/city-union/punjab-sind.
  //
  // AFTER: when 2+ currencies expected and zero detected, REJECT. The
  // failure surfaces as 0 FCNR slabs + a clear warning, which the cohort
  // partial_silent gate catches. Better failure mode than wrong data.
  //
  // Special case: if expectedCurrencies has EXACTLY ONE entry (single-
  // currency bank like Saraswat USD-only FCNR), the default-fill is still
  // correct — only one currency could possibly be the tag.
  if (Array.isArray(expectedCurrencies) && expectedCurrencies.length === 1) {
    const c = expectedCurrencies[0];
    for (const s of tagged) s.currency = c;
    warnings.push(`currency_hint_single: no slab carried a currency; defaulted to "${c}" from hints.expected_currencies (only 1 expected; safe to default)`);
    return { slabs: tagged };
  }

  if (Array.isArray(expectedCurrencies) && expectedCurrencies.length >= 2) {
    return {
      rejected: true,
      reason: `missing_currency_multi: fcnr/gift extraction returned ${tagged.length} slabs with NO currency markers, but ${expectedCurrencies.length} currencies were expected (${expectedCurrencies.join(',')}). This usually means the table-picker selected an INR table (bulk-FD with deposit-tier columns) instead of the FCNR currency-keyed matrix. Refusing to default-fill with "${expectedCurrencies[0]}" — operator should verify the source page has FCNR currency-keyed data and the engine is finding it.`,
    };
  }

  // No way to assign currency and no hint — reject rather than write invalid fcnr/gift data.
  return { rejected: true, reason: `missing_currency: fcnr/gift slabs require a currency field per slab; deterministic extraction produced none and no hints.expected_currencies were provided` };
}

/**
 * Collapse slabs with the same identity tuple (tenure_min_days,
 * tenure_max_days, currency, deposit_range). First occurrence wins;
 * later duplicates are dropped silently. This catches the bulk-tier or
 * mirror-table cases where the same logical slab gets emitted twice.
 */
/**
 * A1 (slab-quality-anomalies-2026-05-18) — map free-text deposit_range
 * labels (LLM-emitted, sometimes per-chunk-inconsistent) into the
 * canonical snake_case tokens from docs/agent/schemas.md (Rate File Schema). Bank pages use varied
 * conventions ("above 1.00 Mn", "≥ 1 Mn", "1cr to 5cr", "Above ₹1 Crore"
 * etc.) and the per-chunk LLM doesn't always pick the same form.
 *
 * Returns the canonical token when matched, the input lowercased + snake-
 * cased as a fallback (still better for dedup than raw mixed-case text),
 * or null when input is falsy.
 *
 * Add new patterns here as new bank phrasings surface — narrow regex
 * fixes are cheaper than per-bank overrides.
 */
function normaliseDepositRange(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Treat underscores as spaces so pre-snake_cased inputs (e.g.,
  // "above_1.00_Mn" emitted by an LLM that already canonicalised once)
  // still hit the canonical patterns.
  const lower = raw.toLowerCase().replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();

  // Below thresholds
  if (/below\s*(?:rs\.?|₹)?\s*15\s*l/.test(lower) || /<\s*15\s*l/.test(lower)) return 'below_15l';
  if (/below\s*(?:rs\.?|₹)?\s*3\s*cr/.test(lower) || /<\s*3\s*cr/.test(lower)) return 'below_3cr';

  // 1 Mn / 1.00 Mn — BOI-IBU GIFT tier
  if (/(?:below|<=?|under)\s*(?:rs\.?|₹)?\s*1(?:\.0+)?\s*mn/.test(lower)) return 'below_1mn';
  if (/(?:above|>=?|over)\s*(?:rs\.?|₹)?\s*1(?:\.0+)?\s*mn/.test(lower)) return 'above_1mn';

  // L = lakh; explicit ranges
  if (/15\s*l\s*(?:to|-)\s*1\s*cr/.test(lower)) return '15l_to_1cr';
  if (/1\s*cr\s*(?:to|-)\s*10\s*cr/.test(lower)) return '1cr_to_10cr';
  if (/above\s*(?:rs\.?|₹)?\s*10\s*cr/.test(lower) || />\s*10\s*cr/.test(lower)) return 'above_10cr';
  if (/1\.01\s*cr\s*(?:to|-)\s*(?:less\s+than\s+)?3\s*cr/.test(lower)) return '1.01cr_to_less_than_3cr';

  // Bulk tiers
  if (/3\s*cr\s*(?:to|-)\s*5\s*cr/.test(lower)) return '3cr_to_5cr';
  if (/5\s*cr\s*(?:to|-)\s*25\s*cr/.test(lower)) return '5cr_to_25cr';
  if (/25\s*cr\s*(?:to|-)\s*100\s*cr/.test(lower)) return '25cr_to_100cr';
  if (/above\s*(?:rs\.?|₹)?\s*100\s*cr/.test(lower) || />\s*100\s*cr/.test(lower)) return 'above_100cr';
  if (/above\s*(?:rs\.?|₹)?\s*3\s*cr/.test(lower) || />\s*3\s*cr/.test(lower)) return 'above_3cr';

  // Fallback: snake_case the input. Better for dedup than raw text but
  // surfaces as a non-canonical value the operator can audit.
  return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Sprint 4 A15 — text-pattern fallback for pages where cheerio + LLM both
 * return zero slabs. Two real-world triggers:
 *   - React/Tailwind SPAs that render rates in <div>s with no <table>
 *     elements (Equitas FD style).
 *   - Static pages whose single <table> has cells mashed so cheerio's row
 *     parse produces one giant cell (Equitas FCNR style).
 *
 * Algorithm:
 *   1. Strip script/style; collect visible body text on one line.
 *   2. Find every rate-shaped position (\d+\.\d{1,2}\s*%) in the text.
 *   3. Cluster adjacent rates (within 40 chars) — a row may have 1, 2 or 3
 *      rate columns (general / senior / super-senior, OR tier1 / tier2).
 *   4. For each cluster, scan up to 80 chars of preceding text for the
 *      LONGEST suffix that parseTenure() can parse. That suffix becomes
 *      the slab's tenure_text.
 *   5. For FCNR/GIFT variants, track the most-recent ISO currency code
 *      seen in the running text and tag each emitted slab with it.
 *
 * Gating (all required, no per-bank carve-outs):
 *   - The body text contains ≥ 5 rate-shaped patterns (cheap noise gate).
 *   - At least one matched tenure parses into days.
 * Returns [] if any condition fails; the caller treats that as "no fallback".
 *
 * The B3 malformed-slab filter and dedupSlabs in post-processing further
 * clean any over-extraction.
 */
/**
 * Sprint 4 B3 — predicate flagging slabs whose `tenure_text` looks like a
 * concatenated table fragment rather than a real tenure label. Used both
 * by the post-processing filter (drop after extract) and by the A15
 * trigger check (treat slabs that would fail this as "empty" so A15
 * fires when cheerio produced only garbage rows).
 */
function isMalformedSlab(slab) {
  const t = slab && slab.tenure_text;
  if (!t || typeof t !== 'string') return false;
  if (t.length > 100) return true;
  const pctCount = (t.match(/%/g) || []).length;
  if (pctCount >= 2) return true;
  if (/\d+\.\d{1,2}\s*%/.test(t)) return true;
  return false;
}

function extractViaTextPattern(html, variant, expectedCurrencies) {
  if (!html || typeof html !== 'string') return [];
  let $;
  try { $ = cheerio.load(html); } catch { return []; }
  $('script, style, noscript').remove();
  const text = $('body').text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const allRatesCount = (text.match(/\d+\.\d{1,2}\s*%/g) || []).length;
  if (allRatesCount < 5) return [];

  const RATE_RE = /(\d+\.\d{1,2})\s*%/g;
  const CURRENCY_RE = /\b(USD|EUR|GBP|JPY|CAD|AUD|SGD|CHF|HKD|NZD)\b/g;
  const isMultiCurrency = variant === 'fcnr' || variant === 'gift';

  const matches = [];
  let mm;
  while ((mm = RATE_RE.exec(text)) !== null) {
    matches.push({ rate: parseFloat(mm[1]), idx: mm.index, end: mm.index + mm[0].length });
  }

  // Find a parseTenure-able substring in the window, then narrow the
  // tenure_text label to just the relevant suffix. Two-step:
  //   (a) Walk i from 0 forward → first hit is the LONGEST parseable
  //       substring. That commits us to a (minDays, maxDays) parse.
  //   (b) Then walk i forward further as long as parseTenure still yields
  //       the SAME (minDays, maxDays). The latest such i strips leading
  //       junk like "USD 500,000>= USD 500,00012 month to <= 18 months"
  //       down to "12 month to <= 18 months".
  const findTenureInWindow = (window) => {
    let firstIdx = -1;
    let firstParse = null;
    for (let i = 0; i < window.length - 2; i++) {
      const cand = window.slice(i).trim();
      if (cand.length < 3) break;
      const parsed = parseTenure(cand);
      if (parsed && (parsed.minDays != null || parsed.maxDays != null)) {
        firstIdx = i;
        firstParse = parsed;
        break;
      }
    }
    if (firstIdx < 0) return null;
    // Narrow: find the LATEST start that still produces the same parse.
    let bestIdx = firstIdx;
    for (let i = firstIdx + 1; i < window.length - 2; i++) {
      const cand = window.slice(i).trim();
      if (cand.length < 3) break;
      const parsed = parseTenure(cand);
      if (parsed && parsed.minDays === firstParse.minDays && parsed.maxDays === firstParse.maxDays) {
        bestIdx = i;
      }
    }
    return { text: window.slice(bestIdx).trim(), parsed: firstParse };
  };

  // Per-row walk. For each rate position, look BACKWARD for a tenure
  // (the row label), then FORWARD up to 40 chars for 0-2 sibling rates
  // (senior / super-senior or tier columns) — stopping the moment a
  // new tenure-shape appears, which marks the next row.
  const slabs = [];
  let runningCurrency = null;
  let lastScannedCcy = 0;
  let prevRowEnd = 0; // end position of the last successfully-consumed rate
  let i = 0;
  while (i < matches.length) {
    const first = matches[i];
    // CRITICAL: lookback must NOT cross the previous row's last rate% —
    // otherwise the "longest parseable tenure" search will swallow the
    // prior row's tenure-text + rates and merge multiple rows into one.
    const lookbackStart = Math.max(prevRowEnd, first.idx - 80);
    const lookback = text.slice(lookbackStart, first.idx);
    const tenure = findTenureInWindow(lookback);
    if (!tenure) { i++; continue; }

    if (isMultiCurrency) {
      // Scan from the end of the previous emitted row all the way up to
      // (but not including) the lookback window used for tenure parsing.
      // The most-recent currency mention in that span IS this row's
      // currency context. Cross-checking the lookback too catches the
      // case where the currency label and tenure label sit in the same
      // text block (Equitas GBP section: "TenureGBP (ROI)12 month to ...").
      const between = text.slice(lastScannedCcy, first.idx);
      const ccyMatches = [...between.matchAll(CURRENCY_RE)];
      if (ccyMatches.length > 0) runningCurrency = ccyMatches[ccyMatches.length - 1][1];
    }

    const rates = [first.rate];
    let lastEnd = first.end;
    let j = i + 1;
    while (j < matches.length && rates.length < 3) {
      const next = matches[j];
      if (next.idx - lastEnd > 40) break;
      const between = text.slice(lastEnd, next.idx);
      if (findTenureInWindow(between)) break;
      rates.push(next.rate);
      lastEnd = next.end;
      j++;
    }

    const slab = {
      tenure_text: tenure.text,
      tenure_min_days: tenure.parsed.minDays,
      tenure_max_days: tenure.parsed.maxDays,
      rate_general_pct: rates[0],
      rate_senior_pct: rates[1] != null ? rates[1] : null,
      rate_super_senior_pct: rates[2] != null ? rates[2] : null,
    };
    if (isMultiCurrency) {
      const ccy = runningCurrency
        || (Array.isArray(expectedCurrencies) && expectedCurrencies.length === 1 ? expectedCurrencies[0] : null);
      if (ccy) slab.currency = ccy;
    }
    slabs.push(slab);
    lastScannedCcy = first.idx;
    prevRowEnd = lastEnd;
    i = j;
  }

  return slabs;
}

function dedupSlabs(slabs) {
  // ── Pass 1: strict dedup (same logic as before B1) ────────────────
  // Collapses exact key matches: same (tenure-as-keyed, currency, deposit_range).
  const seen = new Set();
  const firstPass = [];
  for (const s of slabs) {
    // When parseTenure failed and both bounds are null, falling back on
    // (null, null, currency, range) would collapse every unparseable row
    // in the same currency/range into ONE bucket — HDFC's 19-row table
    // dedup'd to 2 slabs that way. Use the normalised tenure_text as the
    // discriminator instead so distinct rows survive. The "t:"/"n:" prefix
    // prevents a parsed `(7, 14, ...)` slab from cross-colliding with a
    // text-keyed `("7 - 14 days", ...)` one.
    const tenureKey = s.tenure_min_days == null && s.tenure_max_days == null
      ? `t:${String(s.tenure_text || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
      : `n:${s.tenure_min_days ?? ''}:${s.tenure_max_days ?? ''}`;
    const key = JSON.stringify([
      tenureKey,
      s.currency ?? null,
      s.deposit_range ?? null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    firstPass.push(s);
  }

  // ── Pass 2: B1 (sprint-004) — shadow-duplicate collapse ───────────
  // Same (currency, rate_general_pct, rate_senior_pct, rate_super_senior_pct)
  // for the SAME normalised-tenure are the same data point even if one
  // carries a deposit_range and the other doesn't (BOI-IBU "main rates"
  // vs explicit "below_1mn" tier with identical numbers), or even if one
  // has parsed tenure bounds and the other only the text (Kotak FCNR
  // where the LLM emitted both forms of the same row).
  //
  // Discriminator: drop the slab with the LESS-populated fields. Score:
  //   +2 if tenure_min_days != null AND tenure_max_days != null
  //   +1 if deposit_range is a non-empty string
  // Higher score wins; ties keep the first.
  //
  // Critically: this does NOT merge slabs whose rates differ. Legitimate
  // multi-tier pages (above_1mn at 3.5% vs default at 3.4%) are preserved
  // because the rate values differ.
  const normaliseText = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const semanticKey = (s) => {
    // Use the normalised tenure_text as the spine of the key so a slab
    // emitted twice — once with parsed bounds, once without — collapses
    // to the same key. The parsed-bounds variant wins on score below.
    // Strip punctuation/case so "≥1 Year - Less than 2 Year" matches
    // ">=1 year - less than 2 year".
    return JSON.stringify([
      normaliseText(s.tenure_text),
      s.currency ?? null,
      s.rate_general_pct ?? null,
      s.rate_senior_pct ?? null,
      s.rate_super_senior_pct ?? null,
    ]);
  };
  const score = (s) => {
    let n = 0;
    if (s.tenure_min_days != null && s.tenure_max_days != null) n += 2;
    if (typeof s.deposit_range === 'string' && s.deposit_range.length > 0) n += 1;
    return n;
  };
  // Group by semantic key, then within each group keep highest-scored.
  // Stable order: keep the first occurrence at the tied-best score.
  const grouped = new Map();
  for (let i = 0; i < firstPass.length; i++) {
    const s = firstPass[i];
    // Pass 2 only applies when we have a rate to compare on. Otherwise
    // we'd risk collapsing two genuinely different unpopulated rows.
    if (typeof s.rate_general_pct !== 'number') {
      grouped.set(`__keep:${i}`, { idx: i, slab: s, score: -1 });
      continue;
    }
    const k = semanticKey(s);
    const cur = grouped.get(k);
    if (!cur || score(s) > cur.score) {
      grouped.set(k, { idx: i, slab: s, score: score(s) });
    }
  }
  return [...grouped.values()]
    .sort((a, b) => a.idx - b.idx)
    .map((g) => g.slab);
}

/**
 * Heuristic: how many tables on the page have ≥2 rate-bearing rows. Used to
 * surface multi-table ambiguity as a warning.
 */
function countRateBearingTables(tables) {
  const ratePattern = /\d+\.\d+/;
  return tables.filter((rows) => rows.filter((r) => r.some((c) => ratePattern.test(c))).length >= 2).length;
}

/**
 * Build a null-with-warnings-shaped rejection. We can't return warnings on the
 * null path per CLAUDE.md convention; the caller passes those forward via the
 * orchestrator's per-bank summary. So `null` is the contract, but we attach
 * a `.warning` property to the function for any caller that wants more detail.
 *
 * Until the orchestrator wiring lands, this just returns null and logs.
 */
function rejection(reason, kind, product_type, variant) {
  // For now `null` is the contract; capture the reason in a property the caller
  // can read via Function.prototype.lastRejection (not standard — see TODO).
  // Practical fix: callers should rely on log lines or a separate `inspect_*`
  // helper. The reason string is informational, persisted in operator runbooks.
  if (typeof process !== 'undefined' && process.stderr) {
    process.stderr.write(`[extract_html_table:reject] kind=${kind} variant=${variant} reason=${reason}\n`);
  }
  return null;
}

/**
 * Re-parse rendered HTML with cheerio multi-table scorer + column_mapping.
 * Used both:
 *   - Inline by the cached_body path (replaces parseHtmlTables).
 *   - As a second look on path B when the Playwright in-browser picker
 *     returned weak results.
 *
 * Returns slabs[] or empty array.
 */
function extractWithCheerio(html, config, warnings, variant) {
  if (!html) return [];
  const scored = extractScoredTables(html);
  if (scored.length === 0) return [];
  const positiveScored = scored.filter((t) => t.score > 0);
  if (positiveScored.length === 0) return [];
  const columnMapping = (config?.column_mapping && Object.keys(config.column_mapping).length > 0)
    ? config.column_mapping
    : DEFAULT_COLUMN_MAPPING;
  let best = [];
  let bestSignals = null;
  let bestIdx = -1;
  let bestCurrencyCount = -1;
  let rejectedForCurrency = 0;
  const isFcnrLike = variant === 'fcnr' || variant === 'gift';

  for (const t of positiveScored) {
    let currencyCount = 0;
    if (isFcnrLike) {
      // FCNR Fix #1b+#1c (sprint-004 2026-05-23): for fcnr/gift variant,
      // (a) REJECT tables with zero currency markers (they're INR tables),
      // (b) PREFER tables with MORE currency markers over tables with fewer
      //     even when the slab counts favour the fewer one. INR bulk-FD
      //     tables routinely have one stray USD mention (in a footnote or
      //     legend) which would pass a binary "has currency" filter; ranking
      //     by currency count beats those tables with the true FCNR matrix.
      currencyCount = countTableCurrencyMarkers(t.rows);
      if (currencyCount === 0) {
        rejectedForCurrency++;
        continue;
      }
    }
    const candidate = extractSlabsFromTable(t.rows, columnMapping);
    if (isFcnrLike) {
      // For FCNR, prefer the table with MORE distinct currencies; tie-break
      // on slab count.
      const isBetter = currencyCount > bestCurrencyCount
        || (currencyCount === bestCurrencyCount && candidate.length > best.length);
      if (isBetter) {
        best = candidate;
        bestSignals = t.signals;
        bestIdx = t.index;
        bestCurrencyCount = currencyCount;
      }
    } else {
      // Non-FCNR variants: keep the slab-count-max picker (unchanged)
      if (candidate.length > best.length) {
        best = candidate;
        bestSignals = t.signals;
        bestIdx = t.index;
      }
    }
  }
  if (best.length > 0 && Array.isArray(warnings)) {
    const suffix = isFcnrLike ? ` [currencyCount=${bestCurrencyCount}]` : '';
    warnings.push(`cheerio_multi_table: picked table[${bestIdx}] (${best.length} slabs)${suffix} from ${scored.length} table(s); signals=${JSON.stringify(bestSignals)}`);
  }
  if (rejectedForCurrency > 0 && Array.isArray(warnings)) {
    warnings.push(`fcnr_picker_filter: rejected ${rejectedForCurrency} table(s) for variant=${variant} — no currency markers; this is the right behaviour for INR bulk-tier tables`);
  }
  return best;
}

module.exports = {
  extractHtmlTable,
  // Sprint 006 Step 3d (un-deferred from Sprint 7 per operator 2026-05-24):
  // The LLM scaffolding is exported so lib/extractors/_llm-fallback.js can
  // call it directly. This is the "lift without moving code" pattern: the
  // canonical home of this logic remains here (until Sprint 7 retires the
  // legacy file), but new dispatcher-path callers use it from this surface.
  buildHtmlExtractionPrompt,
  callLlmOnChunk,
  validateSlabAgainstChunk,
  dedupSlabs,
  extractTableChunksReExport: require('./_cheerio_tables').extractTableChunks,
  // Exposed for unit tests; not part of the action's public contract.
  _detectAmbiguousColumns: detectAmbiguousColumns,
  _tagCurrencyForeignVariant: tagCurrencyForeignVariant,
  _textPatternMultiCurrencyGuard: textPatternMultiCurrencyGuard,
  _tableHasCurrencyMarkers: tableHasCurrencyMarkers,
  _countTableCurrencyMarkers: countTableCurrencyMarkers,
  _filterChunksForCurrencyVariant: filterChunksForCurrencyVariant,
  _dedupSlabs: dedupSlabs,
  _extractViaTextPattern: extractViaTextPattern,
  _normaliseDepositRange: normaliseDepositRange,
  _validateSlabAgainstChunk: validateSlabAgainstChunk,
  _filterHtmlByTableSelector: filterHtmlByTableSelector,
  _extractWithCheerio: extractWithCheerio,
};
