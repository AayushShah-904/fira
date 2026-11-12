'use strict';
//
// Structural / semantic correctness checks (Sprint 008, Phase 3).
//
// Pure functions, no I/O. Consumed by BOTH:
//   - scripts/analysis/rate-sanity-audit.js   (per-bank loop over output/latest)
//   - scripts/quality-gate.js#pass3_anomalies (per-variant loop over the built pack)
// so the logic never forks. See sdlc/sprints/sprint-008/design/semantic-checks.md.
//
// Each function takes a variant's full slab array (+ light context) and returns
// an Issue (or null / Issue[]):
//   Issue = { check: string, severity: 'ANOMALY'|'WARN'|'INFO', detail: string, value: any }
// The two call sites adapt the Issue into their own finding/issue shape.
//
// These catch the Sprint-007 bug classes that pass bounds + vs-baseline gates
// because their numbers are *plausible*:
//   wrong_table_suspected        loan/savings table read as FD
//   senior_premium_peer_outlier  senior/general column swap (peer-relative)
//   truncated_ladder             a ladder that lost most of its rungs
//   fcnr_currency_anomaly        collapsed / mislabeled FCNR currencies

const KNOWN_FCNR_CURRENCIES = new Set([
  'USD', 'GBP', 'EUR', 'JPY', 'CAD', 'AUD', 'SGD', 'CHF', 'HKD', 'NZD', 'SEK', 'AED', 'DKK',
]);

// Minimum plausible slab count for a *complete* FD ladder, by bank_type. Below
// this AND missing the >=365d band ⇒ likely truncated. Foreign banks / IBUs
// legitimately publish very short ladders, so their floors are low.
const LADDER_FLOORS = {
  PSB: 6, PVB: 6, SFB: 5, SUCB: 4, NSUCB: 4, SSCB: 4, NSSCB: 4,
  DCCB: 4, RRB: 4, FB: 3, IBU: 2, LAB: 4, PB: 3, FI: 3, HFC: 4,
};
const DEFAULT_LADDER_FLOOR = 4;

const LOAN_RE = /\b(loan|advance|advances|mclr|base rate|lending|overdraft|cash credit|emi)\b/;
const SAVINGS_RE = /\b(savings?\s+(?:bank\s+)?account|savings?\s+deposit)\b/;
const FD_RE = /\b(fixed deposit|term deposit|recurring deposit|fd rate|deposit rate|fd interest|td rate)\b|\bfds?\b/;

function num(x) { return typeof x === 'number' && Number.isFinite(x) ? x : null; }
function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }
function issue(check, severity, detail, value) {
  return { check, severity, detail, value: value === undefined ? null : value };
}
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function quantile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(p * sortedArr.length)));
  return sortedArr[idx];
}

// ── 1. Table-type classifier — "is this actually an FD table?" ──────────────
// Catches: loan/MCLR/savings table read as FD (kerala-state, bank-of-ceylon).
function classifyTableType(slabs, opts = {}) {
  const { headerTokens, variant } = opts;
  if (!Array.isArray(slabs) || slabs.length === 0) return null;

  const maxDays = slabs.map((s) => num(s.tenure_max_days));
  const parsed = maxDays.filter((d) => d != null);
  const hasShort = parsed.some((d) => d <= 90);
  const hasLong = parsed.some((d) => d >= 365);

  const tokens = String(headerTokens || '').toLowerCase();
  const hasHeader = tokens.trim().length > 0;
  const loanish = LOAN_RE.test(tokens);
  const savingsish = SAVINGS_RE.test(tokens);
  const fdish = FD_RE.test(tokens);

  // Header is authoritative when available: a header that names loan/savings
  // and never names FD is a wrong-table read regardless of the rate values.
  if (hasHeader && (loanish || savingsish) && !fdish) {
    return issue(
      'wrong_table_suspected', 'ANOMALY',
      `header indicates a ${loanish ? 'loan/lending' : 'savings'} table, not a fixed-deposit table`,
      { headerTokens: tokens.slice(0, 160), fdLadder: hasShort && hasLong },
    );
  }

  // Intrinsic (header-free) signal: a real FD ladder has both a short (<=90d)
  // and a long (>=365d) band. A table with neither — when most tenures parsed
  // — does not look like a retail FD ladder. Guarded so banks whose tenure
  // text didn't parse (Devanagari co-ops) don't false-fire.
  if (parsed.length >= Math.max(3, Math.ceil(slabs.length * 0.6)) && !hasShort && !hasLong) {
    return issue(
      'wrong_table_suspected', 'ANOMALY',
      'tenure structure lacks both a short (<=90d) and a long (>=365d) band typical of an FD ladder',
      { fdLadder: false, parsedTenures: parsed.length, slabs: slabs.length },
    );
  }
  return null;
}

// ── 2. Peer-relative senior-premium outlier — catches column swaps ──────────
// The gate's absolute `senior_below_general` only BLOCKs when senior is >30bps
// BELOW general. A swap where senior≈general (or just under) hides under that.
// Peers tell us whether this bank_type *should* have a premium.
function seniorPremiumPeerOutlier(slabs, opts = {}) {
  const { peerStats, variant } = opts;
  if (variant && variant !== 'regular') return null; // nre/nro/fcnr/gift carry no senior premium
  if (!Array.isArray(slabs)) return null;
  if (!peerStats || peerStats.n < 8 || peerStats.median == null || peerStats.median < 0.25) return null;

  const premiums = slabs
    .filter((s) => typeof s.rate_general_pct === 'number' && typeof s.rate_senior_pct === 'number')
    .map((s) => s.rate_senior_pct - s.rate_general_pct);
  if (premiums.length < 3) return null;

  const med = median(premiums);
  if (med != null && med <= 0) {
    return issue(
      'senior_premium_peer_outlier', 'WARN',
      `median senior premium ${med.toFixed(2)}pp (~0/negative) while ${peerStats.bankType || 'peer'} banks median +${peerStats.median.toFixed(2)}pp — possible senior/general column swap`,
      { bankMedianPremium: round2(med), peerMedianPremium: round2(peerStats.median), peerN: peerStats.n },
    );
  }
  return null;
}

// ── 3. Truncated-ladder detector — intrinsic, not just vs-baseline ──────────
// Catches: bhatinda 11→1. Below the per-type floor AND missing the long end.
function ladderPlausibility(slabs, opts = {}) {
  const { bankType, variant } = opts;
  if (!Array.isArray(slabs)) return null;
  const n = slabs.length;
  if (n === 0) return null;
  const maxDays = slabs.map((s) => num(s.tenure_max_days)).filter((d) => d != null);
  // Can't assess a "ladder" when no slab has a parsed tenure — e.g. a bank that
  // publishes a single headline FD rate with no per-tenure breakdown
  // (thanjavur-central). Skip rather than false-flag a truncation.
  if (maxDays.length === 0) return null;
  const hasLong = maxDays.some((d) => d >= 365);
  const floor = LADDER_FLOORS[bankType] || DEFAULT_LADDER_FLOOR;

  if (n < floor && !hasLong) {
    return issue(
      'truncated_ladder', 'ANOMALY',
      `only ${n} slab(s) (expected >= ${floor} for ${bankType || 'this type'}) and no >=365d band — likely a truncated ladder`,
      { slabs: n, floor, hasLong, variant: variant || 'regular' },
    );
  }
  return null;
}

// ── 4. FCNR/GIFT currency sanity — beyond the gate's missing_currency ───────
function fcnrCurrencySanity(slabs, opts = {}) {
  const { variant } = opts;
  if (!Array.isArray(slabs)) return [];
  if (variant && variant !== 'fcnr' && variant !== 'gift') return [];

  const issues = [];
  const seenRate = new Map();
  const byCurrency = new Map();
  for (const s of slabs) {
    const raw = s.currency;
    if (!raw) continue;
    const c = String(raw).toUpperCase();
    if (!KNOWN_FCNR_CURRENCIES.has(c)) {
      issues.push(issue('fcnr_currency_anomaly', 'WARN', `unrecognised currency '${raw}'`, { currency: raw }));
    }
    // Key on deposit_range too: the same currency+tenure legitimately appears
    // once per amount tier (below_1m / above_1m …) with different rates. Only a
    // collision within the SAME amount tier is a collapsed-section bug. Fall
    // back to tenure_text when days are unparsed (FCNR cards often leave
    // tenure_min/max null), else distinct tenures collapse to one key.
    const tkey = (s.tenure_min_days == null && s.tenure_max_days == null)
      ? String(s.tenure_text || '').trim().toLowerCase()
      : `${s.tenure_min_days}|${s.tenure_max_days}`;
    const key = `${c}|${tkey}|${s.deposit_range || ''}`;
    if (seenRate.has(key) && seenRate.get(key) !== s.rate_general_pct) {
      issues.push(issue(
        'fcnr_currency_anomaly', 'WARN',
        `duplicate ${c} tenure+amount-tier with differing rate (collapsed currency section?)`,
        { currency: c, tenure: s.tenure_text, depositRange: s.deposit_range || null, rates: [seenRate.get(key), s.rate_general_pct] },
      ));
    } else {
      seenRate.set(key, s.rate_general_pct);
    }
    byCurrency.set(c, (byCurrency.get(c) || 0) + 1);
  }

  // Single currency stamped across a long, domestic-looking ladder with
  // sub-365d tenures. FCNR minimum tenure is 1 year — sub-year FCNR rows are
  // the "INR table stamped USD" fingerprint (pnb/emirates). GIFT/IBU deposits
  // legitimately go sub-year, so this fires for fcnr only.
  const currencies = [...byCurrency.keys()];
  if (variant === 'fcnr' && currencies.length === 1) {
    const subYear = slabs.filter((s) => num(s.tenure_max_days) != null && s.tenure_max_days < 365).length;
    if (slabs.length >= 10 && subYear >= 3) {
      issues.push(issue(
        'fcnr_currency_anomaly', 'WARN',
        `single currency ${currencies[0]} across ${slabs.length} slabs incl. ${subYear} sub-365d — possible domestic table mislabeled as ${currencies[0]}`,
        { currency: currencies[0], slabs: slabs.length, subYear },
      ));
    }
  }
  return issues;
}

// ── Peer-stats: per-bank_type distribution of the median senior premium ─────
// Computed once over the built pack and passed into seniorPremiumPeerOutlier.
function computePeerStats(banks) {
  const byType = new Map();
  for (const b of banks || []) {
    const t = (b && b.bank_type) || '(unknown)';
    const reg = b && b.products && b.products.fd && b.products.fd.regular;
    if (!reg || !Array.isArray(reg.slabs)) continue;
    const premiums = reg.slabs
      .filter((s) => typeof s.rate_general_pct === 'number' && typeof s.rate_senior_pct === 'number')
      .map((s) => s.rate_senior_pct - s.rate_general_pct);
    const med = median(premiums);
    if (med == null) continue;
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(med);
  }
  const out = {};
  for (const [t, arr] of byType) {
    const sorted = [...arr].sort((x, y) => x - y);
    out[t] = {
      bankType: t,
      n: sorted.length,
      median: round2(median(sorted)),
      p25: round2(quantile(sorted, 0.25)),
      p75: round2(quantile(sorted, 0.75)),
    };
  }
  return out;
}

// Convenience: run every variant-level check and return a flat Issue[].
// `peerStats` is the single per-type entry for THIS bank (out[bank_type]).
function runStructuralChecks(slabs, opts = {}) {
  const issues = [];
  const t = classifyTableType(slabs, opts);
  if (t) issues.push(t);
  const sp = seniorPremiumPeerOutlier(slabs, opts);
  if (sp) issues.push(sp);
  const l = ladderPlausibility(slabs, opts);
  if (l) issues.push(l);
  for (const f of fcnrCurrencySanity(slabs, opts)) issues.push(f);
  return issues;
}

module.exports = {
  KNOWN_FCNR_CURRENCIES,
  LADDER_FLOORS,
  classifyTableType,
  seniorPremiumPeerOutlier,
  ladderPlausibility,
  fcnrCurrencySanity,
  computePeerStats,
  runStructuralChecks,
  // shared helpers reused by lib/checks/rate-reasonableness.js (Sprint 008 Phase 7)
  median,
  quantile,
  round2,
  issue,
};
