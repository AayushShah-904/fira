'use strict';

/**
 * Action: extract_via_ocr — Sprint 004 M3 OCR-fallback contract.
 *
 * Calls Azure Document Intelligence's `prebuilt-layout` model on an
 * image (JPG/PNG) or image-based PDF and converts the returned table
 * structure into rate slabs. Matches the `pages: [...]` shape of
 * `extract_pdf_table.js` so the orchestrator's existing M2.6 aggregation
 * absorbs the output unchanged.
 *
 * Design ref: ../../sdlc/sprints/sprint-004/design/ocr-fallback.md
 * Provisioning ref: ../../sdlc/sprints/sprint-004/implementation/m3-docintel-setup.md
 *
 * Requires:
 *   - AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
 *   - AZURE_DOCUMENT_INTELLIGENCE_KEY  (key-based auth; MI migration deferred)
 *
 * Input:
 *   {
 *     url: string,                          // image or PDF URL (or local path with file://)
 *     product_type?: "FD",
 *     variant?: "regular"|"nre"|"nro"|"fcnr"|"gift",
 *     hints?: object,
 *     logger?: object,
 *   }
 *
 * Output (success):
 *   {
 *     ok: true,
 *     pages: Array<{
 *       page_number: number,
 *       product_type: "FD",
 *       variant: string,              // per-TABLE classified since Sprint 011 A2 (item 19)
 *       effective_date: string|null,  // ISO YYYY-MM-DD, captured from table
 *                                     // title rows / DI paragraphs since
 *                                     // Sprint 011 (2026-07-07); null when absent
 *       slabs: Slab[],
 *       warnings: string[],
 *       confidence: "high"|"medium"|"low",
 *     }>,
 *     extraction_method: "automatic_ocr",
 *     cost_pages: number,
 *     regulatory_constraints?: string[],   // item 19 (b): footnote text captured from DI paragraphs
 *     dropped_slab_counts?: object,        // item 19 (c): { rfc_term: n, rfc_savings: n } dropped (not in pack schema)
 *   }
 *
 * Output (no rate-bearing tables found):
 *   { ok: true, pages: [], extraction_method: "automatic_ocr", warnings: [...] }
 *
 * Output (failure):
 *   null  (per CLAUDE.md; caller writes empty rate_slabs).
 */

const { parseTenure } = require('../../scripts/utils/parse-tenure');
// Single date parser for the whole repo (sprint-011 item 21) — do NOT add a
// second one here; extend normalizeEffectiveDate in lib/rates-qc.js instead.
const { normalizeEffectiveDate } = require('../rates-qc');

const VALID_VARIANTS = new Set(['regular', 'nre', 'nro', 'fcnr', 'gift']);
const CURRENCY_VARIANTS = new Set(['fcnr', 'gift']);

// ── Sprint 011 A2 / item 19 (2026-07-06): per-table variant classification ──
// Single PDFs that bundle FCNR(B) / RFC Term / RFC Savings sections on one
// page (Axis fcnr-rfc-deposits-13-june-26.pdf; same pattern expected on HDFC
// and other large PVBs) previously had EVERY table tagged with the single
// input `variant` — 36 RFC Term slabs shipped as FCNR on 2026-06-15. Each
// table is now classified individually:
//   1. Heading match — nearest preceding DI paragraph (same page, in the band
//      between the previous table's bottom and this table's top) against
//      VARIANT_HEADING_MAP.
//   2. Currency heuristic (fcnr input only, gated on an RFC signal in the
//      doc — see detectRfcSignal): currency-bearing table WITH JPY → fcnr;
//      WITHOUT JPY → rfc_term; no currency column → rfc_savings.
//   3. Otherwise keep the input variant.
// rfc_term / rfc_savings are NOT in the pack schema (item 19 fix (c),
// minimal form): their slabs are dropped with an operator-visible log line.
const RFC_VARIANTS = new Set(['rfc_term', 'rfc_savings']);
// Order matters: RFC entries must be tested before FCNR so a combined title
// like "FCNR & RFC Deposits" can't claim an RFC section, and rfc_savings
// before rfc_term for the same reason.
const VARIANT_HEADING_MAP = [
  { re: /RFC\s*Savings/i, variant: 'rfc_savings' },
  { re: /RFC\s*Term/i, variant: 'rfc_term' },
  { re: /FCNR/i, variant: 'fcnr' },
  { re: /\bNRE\b/i, variant: 'nre' },
  { re: /\bNRO\b/i, variant: 'nro' },
  { re: /\b(?:domestic|regular)\b/i, variant: 'regular' },
];
// Item 19 fix (b): footnote capture. A paragraph is a regulatory footnote
// when it starts with a footnote marker, contains a regulatory keyword, or
// sits below the last table with DI role "footnote".
const FOOTNOTE_MARKER_RE = /^[#*†]/;
const FOOTNOTE_KEYWORD_RE = /lock-in|RBI|regulatory|note:/i;
// Markers inside a tenure cell that link the row to a footnote (e.g. Axis
// "3 years < 4 years#" → RBI Jun–Sep 2026 lock-in window).
const TENURE_FLAG_RE = /[#*†]/g;
// y-tolerance (DI Layout units — inches for PDFs) when comparing element
// positions; DI polygons jitter slightly around visual boundaries.
const Y_EPSILON = 0.05;

// ── Sprint 011 (2026-07-07): OCR effective-date capture ──
// Rate sheets carry their effective date in the table's merged title row
// (Axis FCNR: "FCNR (B) DEPOSITS Interest Rates | w.e.f. 13th June 2026")
// or in a nearby DI paragraph. Previously discarded — every OCR-extracted
// variant shipped effective_date: null. Phrase alternation is ordered
// longest-first so bare "effective" can't half-claim "effective from".
const EFFECTIVE_PHRASE_SRC =
  'w\\.?\\s*e\\.?\\s*f\\.?|with\\s+effect\\s+from|effective\\s+from|effective\\s+date|effective|as\\s+on|as\\s+of';
// Date shapes normalizeEffectiveDate (lib/rates-qc.js) parses — keep in sync:
//   2026-06-13 | 13-06-2026 / 13.06.2026 / 13/06/2026 (DD.MM.YYYY, Indian
//   convention) | 13th June 2026 | June 13, 2026
const EFFECTIVE_DATE_TOKEN_SRC =
  '\\d{4}-\\d{1,2}-\\d{1,2}'
  + '|\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}'
  + '|\\d{1,2}\\s*(?:st|nd|rd|th)?[-\\s]+[A-Za-z]+[-,\\s]+\\d{4}'
  + '|[A-Za-z]+[-\\s]+\\d{1,2}\\s*(?:st|nd|rd|th)?[,\\s]+\\d{4}';
// Sanity window: an effective date before 2020 is page legalese, one more
// than a week in the future is OCR/parse garbage — never fabricate either.
const EFFECTIVE_DATE_MIN_ISO = '2020-01-01';
const EFFECTIVE_DATE_FUTURE_GRACE_DAYS = 7;

// Sprint 006 Step 1g (un-deferred from Sprint 7 per operator 2026-05-24):
// Azure DocumentIntelligence client is now centralized in lib/azure/doc_intelligence.js.
// This module delegates buildClient + analyzeUrl to the shared module so we
// don't maintain two copies of the SDK setup. Public surface unchanged —
// existing tests pass; only the internal helper that previously lived here is gone.
const sharedDocIntel = require('../azure/doc_intelligence');

// Tenure column header — matches common English synonyms PLUS Hindi (अवधि).
// `अवधि` doesn't have word boundaries that \b respects in non-ASCII, so we
// use a separate alternation outside \b for that token.
const TENURE_HEADER_RE = /(\b(?:tenor|tenure|period|days|months|years|maturity|slab|bucket|fixed\s*deposit|deposit|scheme)\b|अवधि)/i;
// Rate column header — English synonyms + Hindi (ब्याज = interest, दर = rate).
const GENERAL_RATE_HEADER_RE = /(\b(?:rate|interest|roi|general|public|individual|p\.a\.?|%)\b|ब्याज|दर)/i;
const SENIOR_RATE_HEADER_RE = /\b(senior|sr\.?|60\s*\+|elderly)/i;
const SUPER_SENIOR_HEADER_RE = /\b(super\s*senior|80\s*\+|sup\.?\s*sr\.?)/i;
const CURRENCY_HEADER_RE = /\b(currency|ccy)\b/i;
const CURRENCY_CODE_RE = /\b(USD|GBP|EUR|JPY|CAD|AUD|SGD|CHF|HKD|NZD)\b/i;
const PCT_RE = /(-?\d+(?:\.\d+)?)\s*%?\s*$/;

/**
 * Build a DocumentAnalysisClient using key-based auth from env.
 *
 * Sprint 006 Step 1g: delegates to lib/azure/doc_intelligence.js to avoid
 * SDK-setup duplication. The shared module throws with code='DOCINTEL_NOT_CONFIGURED';
 * we re-throw with the legacy code='OCR_NOT_CONFIGURED' so back-compat callers
 * (extract_via_ocr.js tests, orchestrator error-handling) still match the
 * historical contract.
 */
function buildClient() {
  try {
    return sharedDocIntel.buildClient();
  } catch (e) {
    if (e.code === 'DOCINTEL_NOT_CONFIGURED') {
      const legacy = new Error(e.message);
      legacy.code = 'OCR_NOT_CONFIGURED';
      throw legacy;
    }
    throw e;
  }
}

/**
 * Call DI Layout on a URL. Returns the AnalyzeResult.
 * Override-able via the `client` parameter for unit-testing.
 *
 * Sprint 006 Step 1g: delegates to lib/azure/doc_intelligence.js#analyzeUrl.
 * Signature kept positional (`analyzeUrl(url, client?)`) for back-compat
 * with the few internal callers in this file.
 */
async function analyzeUrl(url, client = null) {
  return sharedDocIntel.analyzeUrl({ url, client: client || buildClient() });
}

/**
 * Group DI cells back into a row-major 2D grid: cells[rowIndex][columnIndex] = content.
 * Cells that span multiple rows/cols are written to each covered position
 * (so callers don't have to worry about merges).
 */
function cellsToGrid(table) {
  const grid = Array.from({ length: table.rowCount }, () =>
    Array.from({ length: table.columnCount }, () => '')
  );
  for (const cell of (table.cells || [])) {
    const text = (cell.content || '').trim();
    const rs = cell.rowSpan || 1;
    const cs = cell.columnSpan || 1;
    for (let dr = 0; dr < rs; dr++) {
      for (let dc = 0; dc < cs; dc++) {
        const r = cell.rowIndex + dr;
        const c = cell.columnIndex + dc;
        if (r < table.rowCount && c < table.columnCount) {
          grid[r][c] = text;
        }
      }
    }
  }
  return grid;
}

/**
 * Identify column roles by header-row text. Returns
 *   { tenureCol, generalCol, seniorCol, superSeniorCol, currencyCol, currencyCols }
 * where currencyCols is set when the table is shaped {currency × tenure-cols} (FCNR-style).
 */
function classifyColumns(headerRow) {
  let tenureCol = -1, generalCol = -1, seniorCol = -1, superSeniorCol = -1, currencyCol = -1;
  const currencyCols = []; // [{ col, currency }]
  for (let i = 0; i < headerRow.length; i++) {
    const h = headerRow[i];
    if (!h) continue;
    if (tenureCol < 0 && TENURE_HEADER_RE.test(h)) tenureCol = i;
    if (currencyCol < 0 && CURRENCY_HEADER_RE.test(h)) currencyCol = i;
    if (superSeniorCol < 0 && SUPER_SENIOR_HEADER_RE.test(h)) superSeniorCol = i;
    // Order: super-senior check first so the senior regex doesn't claim it
    if (seniorCol < 0 && SENIOR_RATE_HEADER_RE.test(h) && i !== superSeniorCol) seniorCol = i;
    // General is anything that looks like a rate column AND isn't senior/super
    if (generalCol < 0 && GENERAL_RATE_HEADER_RE.test(h) && i !== seniorCol && i !== superSeniorCol) {
      generalCol = i;
    }
    // FCNR-style: header cells contain tenure spans (e.g., "1 Year but less than 2 Years")
    // Detect by absence of rate keyword + presence of year/month/day pattern.
    if (i !== tenureCol && i !== currencyCol && /year|month|day/i.test(h) && !GENERAL_RATE_HEADER_RE.test(h)) {
      // record as a tenure-bearing column; the row contents will be rates
    }
  }
  return { tenureCol, generalCol, seniorCol, superSeniorCol, currencyCol };
}

// Currency normalisation shared with the HTML extractor — see
// scripts/utils/normalise-currency.js.
const { normaliseCurrency } = require('../../scripts/utils/normalise-currency');

/**
 * Pattern B detector — currency columns: header row has currency codes
 * (USD, GBP, EUR, ...) in non-tenure columns; rows are tenures.
 *
 * Some banks publish a merged "title" row above the actual header
 * (Axis FCNR's row 0 = "FCNR (B) DEPOSITS Interest Rates | w.e.f. ..."
 * with the real header at row 1). The helper scans the first 3 rows
 * and uses the first one that contains ≥ 2 normalised currency codes.
 *
 * If the row immediately below has amount-tier text under any currency
 * column (e.g. "Below 1 million" / "1 million & above" — common for
 * banks that split USD by deposit amount), the helper records those as
 * `deposit_range_hint` so tableToSlabs can tag the slab.
 *
 * Returns { tenureCol, currencyCols: [{ col, currency, deposit_range? }],
 *           headerRow } or null.
 */
function detectCurrencyColumnsLayout(grid) {
  if (grid.length < 2 || grid[0].length < 2) return null;
  for (let headerRow = 0; headerRow < Math.min(3, grid.length - 1); headerRow++) {
    const header = grid[headerRow];
    const currencyCols = [];
    let tenureCol = -1;
    for (let i = 0; i < header.length; i++) {
      const h = header[i] || '';
      if (!h.trim()) continue;
      if (tenureCol < 0 && TENURE_HEADER_RE.test(h)) { tenureCol = i; continue; }
      const ccy = normaliseCurrency(h);
      if (ccy) currencyCols.push({ col: i, currency: ccy });
    }
    if (currencyCols.length >= 2) {
      if (tenureCol < 0) tenureCol = 0;
      // Look for a sub-header row below that splits any currency by
      // amount tier (e.g. "Below 1 million" / "1 million & above").
      let dataStart = headerRow + 1;
      if (grid[headerRow + 1]) {
        const subRow = grid[headerRow + 1];
        let subHits = 0;
        for (const cc of currencyCols) {
          const sub = subRow[cc.col] || '';
          const dr = amountTierToDepositRange(sub);
          if (dr) {
            cc.deposit_range = dr;
            subHits++;
          }
        }
        // If 2+ columns got a deposit_range from the sub-row, skip it as
        // data (it's a sub-header). Otherwise leave dataStart at headerRow+1.
        if (subHits >= 2) dataStart = headerRow + 2;
      }
      return { tenureCol, currencyCols, headerRow, dataStart };
    }
  }
  return null;
}

/**
 * Map sub-header text like "Below 1 million" / "1 million & above" /
 * "Up to 5 lakhs" / ">= ₹3 Crore" to a canonical deposit_range token.
 * Returns null when the text doesn't look like an amount-tier label.
 */
function amountTierToDepositRange(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // Million tiers (FCNR Axis-style): below 1M → below_1mn, 1M & above → above_1mn
  if (/(below|less than|under|<)\s*1\s*(mn|million)/.test(t)) return 'below_1mn';
  if (/1\s*(mn|million)\s*(&|and)\s*above/.test(t) || /(>=|≥|above|over)\s*1\s*(mn|million)/.test(t)) return 'above_1mn';
  // Crore tiers (INR-side, less common in FCNR but possible)
  if (/(below|less than|<)\s*3\s*cr/.test(t)) return 'below_3cr';
  if (/3\s*cr.*5\s*cr/.test(t)) return '3cr_to_5cr';
  if (/(>=|≥|above)\s*5\s*cr/.test(t)) return 'above_5cr';
  return null;
}

/**
 * Detect whether a table is currency-keyed (FCNR-shape: first column or row is currency code,
 * remaining columns are tenure buckets).
 */
function detectCurrencyKeyedTable(grid) {
  if (grid.length < 2) return null;
  const header = grid[0];
  // Pattern A: header row is "Currency | 1Y | 2Y | 3Y | ..."
  //   first col header matches /currency/i OR first data row first cell is a currency code
  const firstHeader = (header[0] || '').trim();
  const firstDataCell = (grid[1] && grid[1][0]) || '';
  const isCurrencyKeyedRows = CURRENCY_HEADER_RE.test(firstHeader) || CURRENCY_CODE_RE.test(firstDataCell);
  if (!isCurrencyKeyedRows) return null;
  // Other columns must look like tenure descriptors
  const tenureCols = [];
  for (let c = 1; c < header.length; c++) {
    const h = header[c] || '';
    if (/year|month|day/i.test(h)) tenureCols.push(c);
  }
  if (tenureCols.length === 0) return null;
  return { layout: 'currency_rows_tenure_cols', tenureCols };
}

/**
 * Parse a rate cell like "5.50%", "5.5", "5.50 p.a.", em-dash into a number or null.
 */
function parseRate(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/p\.?\s*a\.?/gi, '')
    .replace(/per\s*annum/gi, '')
    .replace(/[%,\s]/g, '')
    .trim();
  if (!cleaned) return null;
  if (/^[—–\-]+$/.test(cleaned) || /^n\.?a\.?$/i.test(cleaned)) return null;
  // Cell must be PURELY numeric (with optional decimal). Reject anything
  // with letters or other characters — guards against deposit-range labels
  // like "1 million & above" where the leading digit would otherwise parse
  // as a rate. End-anchor required.
  const m = cleaned.match(/^(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0 || n > 30) return null;
  return n;
}

// eslint-disable-next-line no-unused-vars

/**
 * Pick the canonical tenure text from a cell — strip trailing colons / asterisks.
 * Sprint 011 A2 (item 19, 2026-07-06): '#' added to the strip set — footnote
 * markers now ride the slab as `regulatory_flag_keys` (see extractTenureFlagKeys)
 * instead of polluting tenure_text.
 */
function cleanTenureText(t) {
  return String(t || '').replace(/[\*†‡#]+$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Item 19 fix (b): pull footnote-marker keys (#, *, †) out of a raw tenure
 * cell. Returns the distinct markers found (e.g. ['#']) so tableToSlabs can
 * stamp `regulatory_flag_keys` on the slab.
 */
function extractTenureFlagKeys(raw) {
  const m = String(raw || '').match(TENURE_FLAG_RE);
  return m ? [...new Set(m)] : [];
}

/**
 * First boundingRegion of a DI element → { page, top, bottom } (y-extent).
 * DI polygons are [x1,y1, x2,y2, ...] in reading order; only relative
 * ordering on the same page matters here. Returns null when the element
 * carries no usable region (synthetic tests, older captures).
 */
function regionOf(el) {
  const br = el?.boundingRegions?.[0];
  if (!br || !Array.isArray(br.polygon) || br.polygon.length < 4) return null;
  const ys = br.polygon.filter((_, i) => i % 2 === 1);
  return { page: br.pageNumber ?? 1, top: Math.min(...ys), bottom: Math.max(...ys) };
}

/**
 * Match heading text against the variant-keyword map. Returns the variant
 * string or null.
 */
function matchHeadingVariant(text) {
  const t = String(text || '');
  if (!t) return null;
  for (const { re, variant } of VARIANT_HEADING_MAP) {
    if (re.test(t)) return variant;
  }
  return null;
}

/**
 * Currency menu of a table, or null when the table has no currency
 * dimension. Used by the item-19 heuristic (JPY presence distinguishes
 * FCNR from RFC Term on Axis-pattern sheets).
 */
function tableCurrencySet(table) {
  const grid = cellsToGrid(table);
  if (grid.length === 0) return null;
  const colLayout = detectCurrencyColumnsLayout(grid);
  if (colLayout) return new Set(colLayout.currencyCols.map((c) => c.currency));
  const keyed = detectCurrencyKeyedTable(grid);
  if (keyed) {
    const set = new Set();
    for (let r = 1; r < grid.length; r++) {
      const c = normaliseCurrency((grid[r][0] || '').trim());
      if (c) set.add(c);
    }
    if (set.size > 0) return set;
  }
  return null;
}

/**
 * Does this document look like it carries RFC sections at all?
 * Guard for the item-19 currency heuristic: WITHOUT this gate, a legitimate
 * FCNR-only bank whose currency menu happens to lack JPY (USD/GBP/EUR-only
 * menus are common) would have its whole table demoted to rfc_term and
 * dropped. Signals:
 *   - any DI paragraph mentions RFC, or
 *   - ≥ 2 currency-bearing tables with differing JPY presence (the
 *     unlabelled multi-section shape the heuristic exists for).
 */
function detectRfcSignal(paragraphs, tables) {
  if ((paragraphs || []).some((p) => /\bRFC\b/i.test(p?.content || ''))) return true;
  const sets = (tables || []).map(tableCurrencySet).filter((s) => s && s.size >= 2);
  if (sets.length >= 2) {
    const withJpy = sets.filter((s) => s.has('JPY')).length;
    if (withJpy > 0 && withJpy < sets.length) return true;
  }
  return false;
}

/**
 * Item 19 fix (a): classify ONE table's variant.
 *   1. Nearest preceding paragraph heading (same page, y-band between the
 *      previous table's bottom and this table's top) vs VARIANT_HEADING_MAP.
 *   2. Currency heuristic — fcnr input only, gated on detectRfcSignal.
 *   3. Fall back to the input variant.
 */
function classifyTableVariant(table, allTables, paragraphs, inputVariant, rfcSignal) {
  const reg = regionOf(table);
  if (reg && Array.isArray(paragraphs) && paragraphs.length > 0) {
    // Floor = bottom of the nearest table above us on the same page, so we
    // never walk past it and claim an earlier section's heading.
    let floor = -Infinity;
    for (const other of allTables || []) {
      if (other === table) continue;
      const r = regionOf(other);
      if (r && r.page === reg.page && r.bottom <= reg.top + Y_EPSILON && r.bottom > floor) {
        floor = r.bottom;
      }
    }
    const candidates = [];
    for (const p of paragraphs) {
      const r = regionOf(p);
      if (!r || r.page !== reg.page) continue;
      if (r.bottom > reg.top + Y_EPSILON) continue;   // not above this table
      if (r.bottom < floor - Y_EPSILON) continue;     // belongs to a previous section
      candidates.push({ text: (p.content || '').trim(), bottom: r.bottom });
    }
    candidates.sort((a, b) => b.bottom - a.bottom);   // nearest heading first
    for (const c of candidates) {
      const v = matchHeadingVariant(c.text);
      if (v) return v;
    }
  }
  if (inputVariant === 'fcnr' && rfcSignal) {
    const currencies = tableCurrencySet(table);
    if (currencies === null) return 'rfc_savings';    // no currency column
    return currencies.has('JPY') ? 'fcnr' : 'rfc_term';
  }
  return inputVariant;
}

/**
 * Item 19 fix (b): collect regulatory footnote paragraphs from the
 * AnalyzeResult. A paragraph qualifies when it
 *   - starts with a footnote marker (#, *, †), or
 *   - contains a regulatory keyword (lock-in / RBI / regulatory / note:), or
 *   - sits spatially below the last table AND DI tagged it role="footnote".
 * Page headers/footers/numbers are always skipped. Returns deduped strings.
 */
function collectRegulatoryConstraints(analyzeResult) {
  const paragraphs = analyzeResult?.paragraphs || [];
  if (paragraphs.length === 0) return [];
  const tables = analyzeResult?.tables || [];
  let lastPage = -1;
  let lastBottom = -Infinity;
  for (const t of tables) {
    const r = regionOf(t);
    if (!r) continue;
    if (r.page > lastPage || (r.page === lastPage && r.bottom > lastBottom)) {
      lastPage = r.page;
      lastBottom = r.bottom;
    }
  }
  const out = [];
  const seen = new Set();
  for (const p of paragraphs) {
    const text = (p?.content || '').trim();
    if (!text) continue;
    const role = p.role || '';
    if (role === 'pageHeader' || role === 'pageFooter' || role === 'pageNumber') continue;
    const r = regionOf(p);
    const belowLastTable = !!r && lastPage > 0
      && (r.page > lastPage || (r.page === lastPage && r.top >= lastBottom - Y_EPSILON));
    if (FOOTNOTE_MARKER_RE.test(text)
        || FOOTNOTE_KEYWORD_RE.test(text)
        || (belowLastTable && role === 'footnote')) {
      if (!seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
  }
  return out;
}

/**
 * Sprint 011 (2026-07-07): scan free text for effective-date phrases
 * ("w.e.f." / "with effect from" / "effective from" / "effective date" /
 * "effective" / "as on" / "as of") followed by a date in a common Indian
 * bank format. Returns ALL candidates in reading order as
 * `{ raw, iso }` — iso is null when normalizeEffectiveDate can't parse the
 * captured token (kept so the caller can warn instead of silently dropping).
 */
function findEffectiveDateCandidates(text) {
  const out = [];
  const s = typeof text === 'string' ? text : '';
  if (!s) return out;
  const re = new RegExp(
    `(?:${EFFECTIVE_PHRASE_SRC})\\s*[:\\-–—]?\\s*(${EFFECTIVE_DATE_TOKEN_SRC})`,
    'gi',
  );
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push({ raw: m[1], iso: normalizeEffectiveDate(m[1]) });
  }
  return out;
}

/**
 * Candidates from a table's own cell text (title/header rows included).
 * Iterates raw DI cells rather than the expanded grid so merged title rows
 * (columnSpan > 1) are scanned once, not once per covered column.
 */
function tableEffectiveDateCandidates(table) {
  const joined = (table?.cells || []).map((c) => (c?.content || '')).join('\n');
  return findEffectiveDateCandidates(joined);
}

/** UTC calendar day of a Date as "YYYY-MM-DD". */
function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a candidate list to a single effective date (or null — never
 * fabricate). Rules:
 *   - dedupe by ISO value; sanity-reject dates < 2020-01-01 or > today+7d;
 *   - one valid date → use it;
 *   - several distinct valid dates → most recent ≤ today (earliest overall
 *     when all sit in the future-grace window) + an ambiguity warning;
 *   - none valid → null, with a warning when candidates existed but were
 *     rejected/unparseable.
 * Returns { date: string|null, warnings: string[] }.
 */
function resolveEffectiveDate(candidates, now = new Date()) {
  const warnings = [];
  if (!Array.isArray(candidates) || candidates.length === 0) return { date: null, warnings };
  const todayIso = isoDay(now);
  const maxIso = isoDay(new Date(now.getTime() + EFFECTIVE_DATE_FUTURE_GRACE_DAYS * 86400000));
  const valid = [];
  const rejected = [];
  const unparseable = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c || !c.iso) {
      const raw = c?.raw != null ? String(c.raw) : '';
      if (raw && !unparseable.includes(raw)) unparseable.push(raw);
      continue;
    }
    if (seen.has(c.iso)) continue;
    seen.add(c.iso);
    if (c.iso < EFFECTIVE_DATE_MIN_ISO || c.iso > maxIso) rejected.push(c.iso);
    else valid.push(c.iso);
  }
  if (valid.length === 0) {
    if (rejected.length > 0) {
      warnings.push(
        `effective-date candidate(s) ${rejected.join(', ')} outside sanity window `
        + `(${EFFECTIVE_DATE_MIN_ISO}..${maxIso}); effective_date left null`,
      );
    } else if (unparseable.length > 0) {
      warnings.push(
        `effective-date phrase found but date not parseable (${unparseable.join(' | ')}); effective_date left null`,
      );
    }
    return { date: null, warnings };
  }
  if (valid.length === 1) return { date: valid[0], warnings };
  const sorted = [...valid].sort();
  const pastOrToday = sorted.filter((d) => d <= todayIso);
  const chosen = pastOrToday.length > 0 ? pastOrToday[pastOrToday.length - 1] : sorted[0];
  warnings.push(
    `ambiguous effective-date candidates (${sorted.join(', ')}); using ${chosen} (most recent ≤ today)`,
  );
  return { date: chosen, warnings };
}

/**
 * Convert a Document Intelligence table into rate slabs.
 *
 * Supports two shapes:
 *   - Standard: rows are tenures, cols include tenure + general + (optional) senior
 *   - Currency-keyed: rows are currencies, cols are tenure buckets (FCNR-style)
 */
function tableToSlabs(table, variant) {
  const grid = cellsToGrid(table);
  if (grid.length < 2 || grid[0].length < 2) return [];

  const slabs = [];

  // Try Pattern B currency-keyed first (cols are currencies, rows are
  // tenures — Axis / HDFC / most large PVB FCNR PDFs). The header row has
  // currency codes in non-tenure columns.
  const curColLayout = detectCurrencyColumnsLayout(grid);
  if (curColLayout) {
    // Validate the table is actually a FCNR-shaped multi-tenure matrix —
    // not a 1-data-row strip like Axis's RFC table where col 0 contains a
    // rate cell ("0.15%") rather than a tenure descriptor. Count the rows
    // whose tenure-column cell parses as a tenure (or at least is non-numeric
    // text). Need ≥ 2 such rows to accept the table.
    let tenureRowCount = 0;
    const dataStart = curColLayout.dataStart ?? ((curColLayout.headerRow ?? 0) + 1);
    for (let r = dataStart; r < grid.length; r++) {
      const txt = cleanTenureText(grid[r][curColLayout.tenureCol]);
      if (!txt) continue;
      // Reject if the "tenure" cell itself parses cleanly as a rate.
      if (parseRate(txt) != null) continue;
      tenureRowCount++;
    }
    if (tenureRowCount < 2) {
      // Not a FCNR matrix — fall through to Pattern A / standard handling
    } else {
      for (let r = dataStart; r < grid.length; r++) {
        const rawTenure = grid[r][curColLayout.tenureCol];
        const tenureText = cleanTenureText(rawTenure);
        if (!tenureText) continue;
        if (parseRate(tenureText) != null) continue;  // skip rate-cell rows
        const tp = parseTenure(tenureText);
        // Item 19 (b): footnote markers (#/*/†) link the row to a regulatory
        // footnote — carried on the slab, stripped from tenure_text.
        const flagKeys = extractTenureFlagKeys(rawTenure);
        for (const { col, currency, deposit_range } of curColLayout.currencyCols) {
          const rateGen = parseRate(grid[r][col]);
          if (rateGen == null) continue;
          slabs.push({
            tenure_text: tenureText,
            tenure_min_days: tp?.minDays ?? null,
            tenure_max_days: tp?.maxDays ?? null,
            rate_general_pct: rateGen,
            rate_senior_pct: null,
            rate_super_senior_pct: null,
            deposit_range: deposit_range || 'below_3cr',
            currency,
            ...(flagKeys.length > 0 ? { regulatory_flag_keys: flagKeys } : {}),
          });
        }
      }
      if (slabs.length > 0) return slabs;
    }
  }

  // Try Pattern A currency-keyed (rows are currencies, cols are tenure buckets)
  const curLayout = detectCurrencyKeyedTable(grid);
  if (curLayout) {
    for (let r = 1; r < grid.length; r++) {
      const ccyRaw = (grid[r][0] || '').trim().toUpperCase();
      const ccy = normaliseCurrency(ccyRaw);
      if (!ccy) continue;
      for (const col of curLayout.tenureCols) {
        const rawTenure = grid[0][col];
        const tenureText = cleanTenureText(rawTenure);
        const rateGen = parseRate(grid[r][col]);
        if (rateGen == null || !tenureText) continue;
        const tp = parseTenure(tenureText);
        const flagKeys = extractTenureFlagKeys(rawTenure); // item 19 (b)
        slabs.push({
          tenure_text: tenureText,
          tenure_min_days: tp?.minDays ?? null,
          tenure_max_days: tp?.maxDays ?? null,
          rate_general_pct: rateGen,
          rate_senior_pct: null,
          rate_super_senior_pct: null,
          deposit_range: 'below_3cr',
          currency: ccy,
          ...(flagKeys.length > 0 ? { regulatory_flag_keys: flagKeys } : {}),
        });
      }
    }
    return slabs;
  }

  // Standard tenure-keyed shape
  const cls = classifyColumns(grid[0]);
  // Fallback: if no tenure column matched but a rate column did, assume col 0
  // is the tenure descriptor. Many small-bank rate tables use unconventional
  // column-1 headers like "Fixed Deposits" (Banswara CCB), regional-language
  // headers, or no header at all — but rate tables almost universally have
  // tenure in column 0. Without this fallback we'd reject those entirely.
  let tenureCol = cls.tenureCol;
  if (tenureCol < 0 && cls.generalCol > 0) tenureCol = 0;
  if (tenureCol < 0 || cls.generalCol < 0) return [];

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const rawTenure = row[tenureCol];
    const tenureText = cleanTenureText(rawTenure);
    if (!tenureText) continue;
    const rateGen = parseRate(row[cls.generalCol]);
    const rateSr = cls.seniorCol >= 0 ? parseRate(row[cls.seniorCol]) : null;
    const rateSuperSr = cls.superSeniorCol >= 0 ? parseRate(row[cls.superSeniorCol]) : null;
    if (rateGen == null) continue;
    const tp = parseTenure(tenureText);
    const flagKeys = extractTenureFlagKeys(rawTenure); // item 19 (b)
    const slab = {
      tenure_text: tenureText,
      tenure_min_days: tp?.minDays ?? null,
      tenure_max_days: tp?.maxDays ?? null,
      rate_general_pct: rateGen,
      rate_senior_pct: rateSr,
      rate_super_senior_pct: rateSuperSr,
      deposit_range: 'below_3cr',
      ...(flagKeys.length > 0 ? { regulatory_flag_keys: flagKeys } : {}),
    };
    if (CURRENCY_VARIANTS.has(variant)) {
      // Variant says FCNR/GIFT but the table shape wasn't currency-keyed.
      // Drop the slab — emitting an INR rate as FCNR would be wrong.
      continue;
    }
    slabs.push(slab);
  }
  return slabs;
}

/**
 * Top-level action entry point.
 *
 * @param {object} input
 * @returns {Promise<object|null>}
 */
async function extractViaOcr(input) {
  const url = input?.url;
  const variant = VALID_VARIANTS.has(input?.variant) ? input.variant : 'regular';
  const productType = input?.product_type || 'FD';
  const log = input?.logger || console;

  if (!url) {
    log.warn?.('[extract_via_ocr] no url provided');
    return null;
  }

  let analyzeResult;
  try {
    if (input?._analyze) {
      // Test/stub path — never instantiate the real client
      analyzeResult = await input._analyze(url);
    } else {
      const client = input?._client || buildClient();
      analyzeResult = await analyzeUrl(url, client);
    }
  } catch (err) {
    log.warn?.(`[extract_via_ocr] DI call failed for ${url}: ${err.message}`);
    return null;
  }

  const tables = analyzeResult?.tables || [];
  const paragraphs = analyzeResult?.paragraphs || [];
  const pageCount = analyzeResult?.pages?.length || 1;
  log.info?.(`[extract_via_ocr] ${url}: pages=${pageCount} tables=${tables.length}`);

  if (tables.length === 0) {
    return {
      ok: true,
      pages: [],
      extraction_method: 'automatic_ocr',
      cost_pages: pageCount,
      warnings: [`No tables detected by DI Layout (pages=${pageCount}).`],
    };
  }

  // Sprint 011 A2 (item 19, 2026-07-06): footnote capture + per-table
  // variant classification (see the constant block at the top of the file).
  const regulatoryConstraints = collectRegulatoryConstraints(analyzeResult);
  const rfcSignal = detectRfcSignal(paragraphs, tables);

  // Sprint 011 (2026-07-07): effective-date capture. Document-level
  // candidates come from DI paragraphs (title rows like "… Effective 13th
  // June 2026"), with the raw `content` text as a fallback when the capture
  // carries no paragraphs. Used only when a table's own cells (nearest
  // source — typically the merged title row) yield no date.
  const now = input?._now ? new Date(input._now) : new Date();
  const docDateCandidates = [];
  for (const p of paragraphs) docDateCandidates.push(...findEffectiveDateCandidates(p?.content));
  if (docDateCandidates.length === 0 && typeof analyzeResult?.content === 'string') {
    docDateCandidates.push(...findEffectiveDateCandidates(analyzeResult.content));
  }

  // Cross-page dedup. Some banks (Axis FCNR observed 2026-05-22) publish
  // the same rate data in multiple tables on the same PDF — one table per
  // tenure-bucket presentation. The slabs are byte-identical across tables;
  // collapse them by composite key so downstream consumers don't see
  // duplicates. Track-first-wins.
  const seenKeys = new Set();
  function dedupKey(s) {
    return [
      s.tenure_text,
      s.tenure_min_days ?? '',
      s.tenure_max_days ?? '',
      s.currency || '',
      s.deposit_range || '',
      s.rate_general_pct ?? '',
      s.rate_senior_pct ?? '',
    ].join('|');
  }

  const pages = [];
  // Item 19 fix (c) minimal form: rfc_term / rfc_savings are not in the pack
  // schema — count and drop their slabs instead of shipping them under a
  // wrong variant (the 2026-06-15 Axis failure shipped 36 RFC Term slabs
  // as fcnr).
  const droppedByVariant = new Map();
  for (let i = 0; i < tables.length; i++) {
    const tableVariant = classifyTableVariant(tables[i], tables, paragraphs, variant, rfcSignal);
    const rawSlabs = tableToSlabs(tables[i], tableVariant);
    if (rawSlabs.length === 0) continue;
    const slabs = [];
    for (const s of rawSlabs) {
      const k = dedupKey(s);
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      slabs.push(s);
    }
    if (slabs.length === 0) continue;  // entire page was duplicates of earlier
    if (RFC_VARIANTS.has(tableVariant)) {
      droppedByVariant.set(tableVariant, (droppedByVariant.get(tableVariant) || 0) + slabs.length);
      continue;
    }
    // Effective date: the table's own cells win (nearest source — usually
    // the merged title row); fall back to document-level paragraphs/content.
    const tableDateCandidates = tableEffectiveDateCandidates(tables[i]);
    const { date: effectiveDate, warnings: dateWarnings } = resolveEffectiveDate(
      tableDateCandidates.length > 0 ? tableDateCandidates : docDateCandidates,
      now,
    );
    pages.push({
      page_number: i + 1,
      product_type: productType,
      variant: tableVariant,
      effective_date: effectiveDate,
      slabs,
      warnings: dateWarnings,
      confidence: 'medium',
    });
  }

  for (const [droppedVariant, count] of droppedByVariant.entries()) {
    log.info?.(`[ocr] dropped ${count} ${droppedVariant} slabs (not in pack schema)`);
  }

  const result = {
    ok: true,
    pages,
    extraction_method: 'automatic_ocr',
    cost_pages: pageCount,
  };
  if (regulatoryConstraints.length > 0) result.regulatory_constraints = regulatoryConstraints;
  if (droppedByVariant.size > 0) result.dropped_slab_counts = Object.fromEntries(droppedByVariant);
  return result;
}

module.exports = {
  extractViaOcr,
  _internals: {
    cellsToGrid,
    classifyColumns,
    detectCurrencyKeyedTable,
    detectCurrencyColumnsLayout,
    amountTierToDepositRange,
    normaliseCurrency,
    parseRate,
    cleanTenureText,
    tableToSlabs,
    buildClient,
    analyzeUrl,
    // Sprint 011 A2 (item 19, 2026-07-06)
    regionOf,
    matchHeadingVariant,
    tableCurrencySet,
    detectRfcSignal,
    classifyTableVariant,
    collectRegulatoryConstraints,
    extractTenureFlagKeys,
    // Sprint 011 effective-date capture (2026-07-07)
    findEffectiveDateCandidates,
    tableEffectiveDateCandidates,
    resolveEffectiveDate,
  },
};
