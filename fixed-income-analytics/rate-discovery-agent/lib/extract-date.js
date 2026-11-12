/**
 * lib/extract-date.js
 *
 * Centralised date extraction module for Rate Discovery Agent.
 * Replaces duplicated date extraction regex across extract_rates.js,
 * extract_rates_pdf.mjs, fetch_rates_playwright.js, etc.
 *
 * ARCHITECTURE — 5-tier fallback:
 *  Tier 1: Primary keyword-anchored body text  (w.e.f., effective from, applicable from, …)
 *  Tier 2: Secondary keyword-anchored body text (as on, updated on, last modified, …)
 *  Tier 3: PDF header standalone fallback       (ISO / text date in first 1000 chars)
 *  Tier 4: Source URL filename date extraction  (domestic-deposits-13-june-26.pdf)
 *  Tier 5: HTTP Last-Modified / Date header
 *  Tier 6: ScrapedAt timestamp (only when fallbackToScrapedAt = true)
 *
 * IMPORTANT — escape rules:
 *   All keyword prefix strings use String.raw`` so backslashes are literal and
 *   passed verbatim to `new RegExp()`. Do NOT mix String.raw with ordinary
 *   template literals (which would double the backslashes).
 */

const MONTH_MAP = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', september: '09', sept: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12'
};

const MONTH_NAMES = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Sept|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';

// ---------------------------------------------------------------------------
// Tier-1: PRIMARY keyword triggers — unambiguously about rate effective dates
// ---------------------------------------------------------------------------
// Covers every real-world variant seen across Indian bank websites and PDFs:
//   w.e.f. / w.e.f / wef / w e f (spaced PDF artefact)
//   with effect from / with effect from date
//   effective from / effective date
//   applicable from / applicable w.e.f.
//   rates as on / rates effective / rates w.e.f.
//   revised as on / revised on / revised w.e.f.
//   date of effect / date of revision
//   interest rates w.e. / interest rate revised on
//   current w.e.f. (seen in HDFC-style tables)
// ---------------------------------------------------------------------------
const PRIMARY_KEYWORD_PREFIX = String.raw`(?:` +
  String.raw`with\s+effect\s+from(?:\s+date)?` + `|` +
  String.raw`w\s*\.\s*e\s*\.\s*f\s*\.?\s*(?:from)?` + `|` +  // w.e.f. / w.e.f / w . e . f .
  String.raw`\bwef\b` + `|` +                                   // wef (no dots)
  String.raw`effective\s+(?:from|date)` + `|` +
  String.raw`applicable\s+(?:from|w\.?e\.?f\.?)` + `|` +
  String.raw`rates?\s+(?:as\s+on|effective(?:\s+from)?|w\.?e\.?f\.?)` + `|` +
  String.raw`revised\s+(?:as\s+on|on|w\.?e\.?f\.?)` + `|` +
  String.raw`date\s+of\s+(?:effect|revision)` + `|` +
  String.raw`interest\s+rates?\s+(?:w\.?\s*e\.?\s*|revised\s+on)` + `|` +
  String.raw`current\s+(?:rates?\s+)?w\.?e\.?f\.?` +
`)`; // end of PRIMARY group

// ---------------------------------------------------------------------------
// Tier-2: SECONDARY keyword triggers — less specific, used only as fallback
// ---------------------------------------------------------------------------
const SECONDARY_KEYWORD_PREFIX = String.raw`(?:` +
  String.raw`as\s+(?:on|of)` + `|` +               // as on / as of
  String.raw`updated\s+(?:on|:|\s)` + `|` +
  String.raw`last\s+(?:updated|modified|revised)` + `|` +
  String.raw`modified\s+date` +
`)`;

// ---------------------------------------------------------------------------
// Build pattern arrays: each prefix × 4 date-format variants
// ---------------------------------------------------------------------------
function buildKeywordPatterns(prefix) {
  return [
    // A: ordinal + month-name + year  "18th June, 2026" / "18 June 2026" / "18th June '26"
    new RegExp(String.raw`${prefix}[\s:*]*(\d{1,2}(?:\s*(?:st|nd|rd|th))?\s+(${MONTH_NAMES})[\s,*]*(?:['']?\s*(\d{2,4}))?)`, 'i'),
    // B: numeric  "18/06/2026" / "18-06-26" / "18.06.2026" / "2026-06-18"
    new RegExp(String.raw`${prefix}[\s:*]*(\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4})`, 'i'),
    // C: text-month  "18-Jun-2026" / "18/June/2026"
    new RegExp(String.raw`${prefix}[\s:*]*(\d{1,2}[-/.](?:${MONTH_NAMES})[-/.'](\d{2,4}))`, 'i'),
    // D: Month Day Year  "June 18, 2026" / "September 04, 2026"
    new RegExp(String.raw`${prefix}[\s:*]*((${MONTH_NAMES})[\s,]+\d{1,2}(?:\s*(?:st|nd|rd|th))?[\s,]+(\d{2,4}))`, 'i'),
  ];
}

const PRIMARY_KEYWORD_PATTERNS   = buildKeywordPatterns(PRIMARY_KEYWORD_PREFIX);
const SECONDARY_KEYWORD_PATTERNS = buildKeywordPatterns(SECONDARY_KEYWORD_PREFIX);

// ---------------------------------------------------------------------------
// Tier-3: PDF header standalone fallback — no keyword required
// Scans first 1000 chars only to avoid picking up random dates from tables
// ---------------------------------------------------------------------------
const PDF_FALLBACK_PATTERNS = [
  // E: ISO "2026-06-18"
  /^[\s\S]{0,1000}?\b(\d{4}[-/.]\d{2}[-/.]\d{2})\b/,
  // F: "18 June 2026" or "18th June 2026"
  new RegExp(String.raw`^[\s\S]{0,1000}?\b(\d{1,2}(?:\s*(?:st|nd|rd|th))?\s+(?:${MONTH_NAMES})[\s,]+\d{4})\b`, 'i'),
  // G: "June 18, 2026"
  new RegExp(String.raw`^[\s\S]{0,1000}?\b((?:${MONTH_NAMES})\s+\d{1,2}[\s,]+\d{4})\b`, 'i'),
  // H: "June 2026" (month-year only — day defaults to 01)
  new RegExp(String.raw`^[\s\S]{0,1000}?\b((?:${MONTH_NAMES})\s+\d{4})\b`, 'i'),
];

// ---------------------------------------------------------------------------
// normaliseDateString: raw date string → "YYYY-MM-DD" or null
// ---------------------------------------------------------------------------
function normaliseDateString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip ordinal suffixes, smart quotes, trailing asterisks, parentheses
  const s = raw
    .trim()
    .replace(/[*()]/g, '')
    .replace(/['\u2018\u2019]/g, '')
    .replace(/(\d{1,2})\s*(?:st|nd|rd|th)\b/gi, '$1')
    .trim();

  // 1. ISO  "2026-06-18" / "2026.06.18"
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const y = m[1], mm = m[2].padStart(2, '0'), dd = m[3].padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }

  // 2. Numeric  "DD-MM-YYYY" / "DD.MM.YYYY" / "DD/MM/YY"
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let dd = m[1].padStart(2, '0');
    let mm = m[2].padStart(2, '0');
    let y  = m[3];
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    if (parseInt(mm, 10) > 12 && parseInt(dd, 10) <= 12) { const t = dd; dd = mm; mm = t; }
    if (parseInt(mm, 10) >= 1 && parseInt(mm, 10) <= 12 &&
        parseInt(dd, 10) >= 1 && parseInt(dd, 10) <= 31) {
      return `${y}-${mm}-${dd}`;
    }
  }

  // 3. Month-Year only  "June 2026" / "Jun 2026"  → day defaults to 01
  m = s.match(/^([a-zA-Z]{3,9})[\s\-/.]+(\d{4})$/);
  if (m) {
    const mm = MONTH_MAP[m[1].toLowerCase()];
    if (mm) return `${m[2]}-${mm}-01`;
  }

  // 4. DD Month YYYY  "18 June 2026" / "18-Jun-2026" / "18th June, 2026"
  m = s.match(/^(\d{1,2})[\s\-/.]*([a-zA-Z]{3,9})[\s\-/.,]*(\d{2,4})?$/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = MONTH_MAP[m[2].toLowerCase()];
    let y  = m[3] || new Date().getFullYear().toString();
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    if (mm) return `${y}-${mm}-${dd}`;
  }

  // 5. Month DD YYYY  "June 18, 2026" / "September 04, 2026"
  m = s.match(/^([a-zA-Z]{3,9})[\s\-/.]*(\d{1,2})[\s\-/.,]*(\d{2,4})$/);
  if (m) {
    const mm = MONTH_MAP[m[1].toLowerCase()];
    const dd = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    if (mm) return `${y}-${mm}-${dd}`;
  }

  // 6. Native JS Date fallback
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    const y  = parsed.getFullYear();
    const mm = String(parsed.getMonth() + 1).padStart(2, '0');
    const dd = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// extractEffectiveDate — main entry point
// ---------------------------------------------------------------------------
/**
 * Extract effective date from HTML text or PDF text.
 *
 * @param {string}  text
 * @param {object}  [options]
 * @param {boolean} [options.pdfMode=false]           - Enable PDF header fallback (Tier 3)
 * @param {string}  [options.sourceUrl]               - PDF/page URL — enables Tier 4 (filename date)
 * @param {object}  [options.responseHeaders]         - HTTP headers — enables Tier 5
 * @param {string}  [options.scrapedAt]               - ISO timestamp — enables Tier 6
 * @param {boolean} [options.fallbackToScrapedAt]     - Must be true to use Tier 6
 * @returns {string|null} ISO "YYYY-MM-DD" or null
 */
function extractEffectiveDate(text, {
  pdfMode = false,
  sourceUrl = null,
  responseHeaders = null,
  scrapedAt = null,
  fallbackToScrapedAt = false
} = {}) {
  const foundDates = [];

  if (text && typeof text === 'string') {
    // --- Pre-normalise text to fix common PDF artefacts ---
    text = text
      .replace(/[\u2018\u2019]/g, "'")              // smart quotes → apostrophe
      .replace(/\u00a0/g, ' ')                       // non-breaking space → space
      // Fix kerned/spaced digits ("20 2 6" → "2026", "1 4" before a month → "14")
      .replace(/(\d)\s+(\d)\s*(?:st|nd|rd|th)\b/gi, '$1$2')
      .replace(/(\d{1,2})\s+(?:st|nd|rd|th)\b/gi, '$1')
      // Fix kerned year digits "20 26" → "2026" or "202 6"
      .replace(/\b(20)\s+(\d{2})\b/g, '$1$2')
      .replace(/\b(20\d)\s+(\d)\b/g, '$1$2')
      // Fix kerned month text  "e ff ect" → "effect",  "augu st" → "august"
      .replace(/\be\s*ff\s*ect\b/gi, 'effect')
      .replace(/\baugu\s*st\b/gi, 'August')
      .replace(/\bseptem\s*ber\b/gi, 'September')
      .replace(/\bocto\s*ber\b/gi, 'October')
      .replace(/\bnov\s*ember\b/gi, 'November')
      .replace(/\bdec\s*ember\b/gi, 'December')
      // Normalise "04 th" → "04th" (space before ordinal suffix)
      .replace(/(\d)\s+(st|nd|rd|th)\b/gi, '$1$2')
      // Normalise loose comma before year  "September 30 , 2026" → "September 30, 2026"
      .replace(/(\d)\s+,\s+(\d)/g, '$1, $2');

    // --- Tier 1: Primary keywords ---
    for (const pattern of PRIMARY_KEYWORD_PATTERNS) {
      const gp = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      for (const match of text.matchAll(gp)) {
        const extracted = normaliseDateString(match[1]);
        if (extracted) foundDates.push(extracted);
      }
    }

    // --- Tier 2: Secondary keywords (only if Tier 1 found nothing) ---
    if (foundDates.length === 0) {
      for (const pattern of SECONDARY_KEYWORD_PATTERNS) {
        const gp = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
        for (const match of text.matchAll(gp)) {
          const extracted = normaliseDateString(match[1]);
          if (extracted) foundDates.push(extracted);
        }
      }
    }

    // --- Tier 3: PDF standalone header fallback (only if nothing found yet) ---
    if (pdfMode && foundDates.length === 0) {
      for (const pattern of PDF_FALLBACK_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          const extracted = normaliseDateString(match[1]);
          if (extracted) { foundDates.push(extracted); break; } // stop at first PDF header match
        }
      }
    }
  }

  // --- Tier 4: URL filename  e.g. "fcnr-rfc-deposits-04-september-26.pdf" ---
  if (foundDates.length === 0 && sourceUrl && typeof sourceUrl === 'string') {
    const urlPat = /(\d{1,2})[-_]?(jan|feb|mar|apr|may|jun|june|jul|july|aug|sep|sept|oct|nov|dec)[a-z]*[-_]?(\d{2,4})/gi;
    for (const m of sourceUrl.matchAll(urlPat)) {
      const extracted = normaliseDateString(`${m[1]} ${m[2]} ${m[3]}`);
      if (extracted) foundDates.push(extracted);
    }
  }

  // --- Tier 5: HTTP response headers ---
  if (foundDates.length === 0 && responseHeaders && typeof responseHeaders === 'object') {
    const lm = responseHeaders['last-modified'] || responseHeaders['Last-Modified'] ||
               responseHeaders['date']          || responseHeaders['Date'];
    if (lm) {
      const extracted = normaliseDateString(lm);
      if (extracted) foundDates.push(extracted);
    }
  }

  // --- Tier 6: ScrapedAt timestamp (last resort) ---
  if (foundDates.length === 0 && fallbackToScrapedAt && scrapedAt) {
    const extracted = normaliseDateString(scrapedAt);
    if (extracted) foundDates.push(extracted);
  }

  if (foundDates.length === 0) return null;

  // Filter: reject dates before 2015 or more than 1 year in the future
  const nowYear = new Date().getFullYear();
  const validDates = foundDates.filter(d => {
    const y = parseInt(d.slice(0, 4), 10);
    return y >= 2015 && y <= nowYear + 1;
  });

  const pool = validDates.length > 0 ? validDates : foundDates;
  // Return the most recent (latest) date found
  return pool.sort((a, b) => b.localeCompare(a))[0];
}

/**
 * Backward-compat alias for HTML extraction (pdfMode = false).
 */
function extractEffectiveDateFromHtml(html) {
  return extractEffectiveDate(html, { pdfMode: false });
}

module.exports = {
  extractEffectiveDate,
  extractEffectiveDateFromHtml,
  normaliseDateString
};
