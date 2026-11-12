#!/usr/bin/env node
'use strict';

/**
 * Pack quality gate. Compares a freshly built rates-pack.json against a
 * baseline (typically the last delivered pack in pack/history/) and
 * classifies every observed change into REGRESSION / ANOMALY / WARN / GAIN /
 * STABLE. Emits a Markdown + JSON report and exits non-zero when there are
 * unaccepted block-class findings.
 *
 * Designed in sdlc/sprints/sprint-004/design/pack-quality-gate.md (sprint-004).
 *
 * CLI:
 *   node scripts/quality-gate.js <new-pack> <baseline-pack> [--accepts <file>] [--out-dir <dir>]
 *
 * Exit codes:
 *   0  PASS — no unaccepted regressions/anomalies
 *   1  BLOCK — one or more unaccepted regressions/anomalies
 *   2  ERROR — input file missing or unreadable
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { totalsByBank } = require('./compare-pack.js');
const { aliasToCanonical } = require('../lib/slug-aliases.js');
const { verifyAccept } = require('../lib/quality-gate/signed-accepts.js');
const { runStructuralChecks, computePeerStats } = require('../lib/checks/structural-checks.js');
const { medianRateByCategoryTenure, bucketRate, rateReasonableness, BUCKETS } = require('../lib/checks/rate-reasonableness.js');

// Fix #9 (2026-05-23): rewrite each bank's bank_code to its canonical alias
// so old baseline packs that used a historical slug spelling compare cleanly
// against new runs that emit the canonical spelling (and vice versa). Applied
// to both packs at load time so all downstream passes (totalsByBank,
// pass1and2_compare, pass3_anomalies, accepts matching) only see canonical
// slugs. When two banks in the same pack alias to the same canonical, the
// duplicate is surfaced naturally by the existing duplicate_bank_code anomaly.
function canonicalizePackSlugs(pack) {
  if (pack && Array.isArray(pack.banks)) {
    for (const b of pack.banks) {
      if (b && typeof b.bank_code === 'string') b.bank_code = aliasToCanonical(b.bank_code);
    }
  }
  return pack;
}

const THRESHOLDS = {
  REGRESSION_DELTA: -0.20,     // ≤ -20%
  WARN_DELTA_LOWER: -0.20,     // (-20%, -5%) → WARN
  WARN_DELTA_UPPER: -0.05,
  STABLE_BAND: 0.05,           // |delta| ≤ 5% → STABLE
  GAIN_DELTA_UPPER: 2.0,       // ≤ +200% → GAIN
  ANOMALY_GAIN_DELTA: 5.0,     // ≥ +500% → ANOMALY_GAIN
  RATE_MIN: 0.1,
  RATE_MAX: 15.0,
  RATE_MIN_FOREIGN_CCY: 0.0, // FCNR/GIFT can legitimately approach 0 (JPY near-zero rates)
  RATE_MAX_FOREIGN_CCY: 12.0,
  TENURE_DAYS_MAX: 3700,
  STALE_RATE_MONTHS: 6,
  // Workstream E (sprint-004 2026-05-23): basis-points tolerance for the
  // "senior >= general" invariant. Gaps inside the tolerance are surfaced
  // as WARN-class (still visible in the report) but don't BLOCK. Banks
  // routinely publish promotional / non-callable / bulk tiers where the
  // senior premium does not apply — those land 0-25bps below general and
  // are not extraction bugs. Set to 30bps as a conservative cutoff.
  SENIOR_FLOOR_GAP_BPS: 30,
  // Phase 7 (sprint-008): multi-reference rate-reasonableness.
  PEER_DEVIATION_BPS: 200,        // |rate - peer-median| beyond this fires the peer anchor
  HISTORICAL_DEVIATION_BPS: 150,  // jump from nearest recent-history rate fires the historical anchor
  HISTORY_DEPTH: 3,               // number of pack/history snapshots used as the historical reference
};

const VARIANT_KEYS = ['regular', 'nre', 'nro', 'fcnr', 'gift'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    const e = new Error(`failed to read ${file}: ${err.message}`);
    e.code = 'GATE_INPUT_ERROR';
    throw e;
  }
}

function packDateFromPath(filePath) {
  const m = path.basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : path.basename(filePath, '.json');
}

function loadPartialSilentSet(repoRoot) {
  // Banks whose newest run was silently excluded from the pack. A bank
  // dropping from the new pack is INFO (controlled), not REGRESSION, when it
  // appears here.
  const set = new Set();
  const latestDir = path.join(repoRoot, 'output', 'latest');
  if (!fs.existsSync(latestDir)) return set;
  for (const f of fs.readdirSync(latestDir)) {
    if (f.endsWith('.partial_silent.json')) {
      set.add(aliasToCanonical(f.slice(0, -'.partial_silent.json'.length)));
    }
  }
  return set;
}

// Phase 7 (sprint-008): the last N pack snapshots in pack/history/ as the
// historical reference for the rate-reasonableness detector. Sorted by the
// YYYY-MM-DD in the filename; degrades gracefully when fewer than N exist.
function loadHistoryPacks(repoRoot, depth) {
  const dir = path.join(repoRoot, 'pack', 'history');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && /\d{4}-\d{2}-\d{2}/.test(f)).sort();
  const packs = [];
  for (const f of files.slice(-depth)) {
    try { packs.push(canonicalizePackSlugs(readJson(path.join(dir, f)))); } catch { /* skip unreadable */ }
  }
  return packs;
}

// Phase 7: operator-approved macro anchor (data/macro-rates.json). Null when
// absent; the repo anchor stays inactive unless approved_by is set (ADR-017).
function loadMacroRates(repoRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'macro-rates.json'), 'utf-8')); } catch { return null; }
}

function classifyDelta(actual, baseline) {
  // Same variant present on both sides. Returns { class, delta }.
  if (baseline === 0 && actual === 0) return { class: 'STABLE', delta: 0 };
  if (baseline === 0) return { class: actual > 0 ? 'NEW_VARIANT' : 'STABLE', delta: Infinity };
  const delta = (actual - baseline) / baseline;
  if (actual === 0) return { class: 'REGRESSION', delta };
  if (delta >= THRESHOLDS.ANOMALY_GAIN_DELTA) return { class: 'ANOMALY_GAIN', delta };
  if (delta >= THRESHOLDS.STABLE_BAND) return { class: 'GAIN', delta };
  if (delta <= THRESHOLDS.REGRESSION_DELTA) return { class: 'REGRESSION', delta };
  if (delta < THRESHOLDS.WARN_DELTA_UPPER) return { class: 'WARN', delta };
  return { class: 'STABLE', delta };
}

function bankMapByCode(pack) {
  const m = new Map();
  for (const b of (pack.banks || [])) {
    if (b && b.bank_code) m.set(b.bank_code, b);
  }
  return m;
}

function pass1and2_compare({ newPack, baselinePack, partialSilent }) {
  const newT = totalsByBank(newPack);
  const oldT = totalsByBank(baselinePack);
  const findings = [];

  const allSlugs = new Set([...newT.totals.keys(), ...oldT.totals.keys()]);
  for (const slug of allSlugs) {
    const inNew = newT.totals.has(slug);
    const inOld = oldT.totals.has(slug);
    if (inNew && !inOld) {
      const v = newT.perVariant.get(slug) || {};
      findings.push({
        kind: 'bank',
        class: 'GAIN',
        bank_code: slug,
        variant: null,
        baseline: 0,
        actual: Object.values(v).reduce((a, b) => a + b, 0),
        delta: Infinity,
        detail: 'new bank added',
      });
      continue;
    }
    if (!inNew && inOld) {
      const wasSlabs = oldT.totals.get(slug) || 0;
      const controlled = partialSilent.has(slug);
      // A dropped bank that carried 0 slabs in the baseline loses no rate data,
      // so it is INFO (not a blocking REGRESSION) — same rationale as the
      // partial_silent controlled-exclusion case.
      const noData = wasSlabs === 0;
      findings.push({
        kind: 'bank',
        class: (controlled || noData) ? 'INFO' : 'REGRESSION',
        bank_code: slug,
        variant: null,
        baseline: wasSlabs,
        actual: 0,
        delta: -1,
        detail: controlled
          ? 'bank dropped — controlled exclusion (partial_silent marker present)'
          : noData
            ? 'bank dropped from pack (had 0 slabs in baseline — no rate data lost)'
            : 'bank dropped from pack',
      });
      continue;
    }
    const newVariants = newT.perVariant.get(slug) || {};
    const oldVariants = oldT.perVariant.get(slug) || {};
    const variantSet = new Set([...VARIANT_KEYS, ...Object.keys(newVariants), ...Object.keys(oldVariants)]);
    for (const variant of variantSet) {
      const a = newVariants[variant] || 0;
      const b = oldVariants[variant] || 0;
      if (a === 0 && b === 0) continue;
      const { class: cls, delta } = classifyDelta(a, b);
      if (cls === 'STABLE') continue;
      findings.push({
        kind: 'variant',
        class: cls,
        bank_code: slug,
        variant,
        baseline: b,
        actual: a,
        delta,
        detail: '',
      });
    }
  }
  return findings;
}

function monthsBetween(later, earlier) {
  // approximate; report-grade
  const ms = later.getTime() - earlier.getTime();
  return ms / (1000 * 60 * 60 * 24 * 30.44);
}

function pass3_anomalies({ newPack, baselinePack = null, history = [], macro = null }) {
  const findings = [];
  const generatedAt = newPack.generated_at ? new Date(newPack.generated_at) : null;
  const seenSlugs = new Set();
  // Sprint 008 Phase 3: per-bank_type senior-premium distribution, computed
  // once so seniorPremiumPeerOutlier can flag swaps that hide under the
  // absolute SENIOR_FLOOR_GAP_BPS threshold.
  const peerStatsByType = computePeerStats(newPack.banks || []);
  // Sprint 008 Phase 7: per-(bank_type x tenure-bucket) median rates, plus the
  // last-N history snapshots, for the multi-reference rate-reasonableness check.
  const categoryTenureMedians = medianRateByCategoryTenure(newPack.banks || []);
  const historyMaps = (history || []).map((p) => bankMapByCode(p));
  const repoActive = !!(macro && macro.approved_by && typeof macro.repo_rate === 'number');
  let repoInactiveNoted = false;
  for (const bank of (newPack.banks || [])) {
    const slug = bank.bank_code;
    if (!slug) continue;
    if (seenSlugs.has(slug)) {
      findings.push({
        kind: 'anomaly',
        class: 'ANOMALY',
        bank_code: slug,
        variant: null,
        check: 'duplicate_bank_code',
        value: slug,
        detail: 'bank_code appears multiple times in banks[]',
      });
      continue;
    }
    seenSlugs.add(slug);

    const fdVariants = (bank.products && bank.products.fd) || {};
    for (const [variant, payload] of Object.entries(fdVariants)) {
      if (!payload || !Array.isArray(payload.slabs)) continue;
      // effective_date staleness
      if (generatedAt && payload.effective_date) {
        const eff = new Date(payload.effective_date);
        if (!Number.isNaN(eff.getTime()) && monthsBetween(generatedAt, eff) > THRESHOLDS.STALE_RATE_MONTHS) {
          findings.push({
            kind: 'anomaly',
            class: 'WARN',
            bank_code: slug,
            variant,
            check: 'stale_effective_date',
            value: payload.effective_date,
            detail: `effective_date older than ${THRESHOLDS.STALE_RATE_MONTHS} months relative to pack.generated_at`,
          });
        }
      }
      // extraction_confidence visibility
      if (payload.extraction_confidence === 'low' || payload.extraction_confidence === 'none') {
        findings.push({
          kind: 'anomaly',
          class: 'INFO',
          bank_code: slug,
          variant,
          check: 'low_extraction_confidence',
          value: payload.extraction_confidence,
          detail: 'extraction_confidence is low or none',
        });
      }
      for (let i = 0; i < payload.slabs.length; i++) {
        const slab = payload.slabs[i];
        const loc = `${slug}/${variant}#${i}`;
        const g = slab.rate_general_pct;
        const s = slab.rate_senior_pct;
        const ss = slab.rate_super_senior_pct;
        const isForeignCcy = variant === 'fcnr' || variant === 'gift';
        const rateMin = isForeignCcy ? THRESHOLDS.RATE_MIN_FOREIGN_CCY : THRESHOLDS.RATE_MIN;
        const rateMax = isForeignCcy ? THRESHOLDS.RATE_MAX_FOREIGN_CCY : THRESHOLDS.RATE_MAX;
        if (typeof g === 'number' && (g < rateMin || g > rateMax)) {
          findings.push({
            kind: 'anomaly',
            class: 'ANOMALY',
            bank_code: slug,
            variant,
            check: 'rate_general_out_of_band',
            value: g,
            location: loc,
            detail: `rate_general_pct outside [${rateMin}, ${rateMax}]`,
          });
        }
        if (typeof g === 'number' && typeof s === 'number' && s < g) {
          // Workstream E (sprint-004 2026-05-23): tolerance band. The "senior
          // >= general" invariant is a strong tendency in Indian banking but
          // not a hard rule — some banks publish senior at a fractional bps
          // below general for promotional / non-callable / bulk tiers (e.g.,
          // UCO NRE: gen=6.25 / sen=6.10 = -0.15%), and the bps gap is too
          // small to be a genuine extraction bug. Flag only when the senior
          // rate is more than SENIOR_FLOOR_GAP_BPS below general. Tighter
          // gaps surface as WARN-class so operators can still audit if they
          // want, but don't BLOCK the gate.
          const gapBps = Math.round((g - s) * 100);
          if (gapBps > THRESHOLDS.SENIOR_FLOOR_GAP_BPS) {
            findings.push({
              kind: 'anomaly',
              class: 'ANOMALY',
              bank_code: slug,
              variant,
              check: 'senior_below_general',
              value: { general: g, senior: s },
              location: loc,
              detail: `rate_senior_pct < rate_general_pct by ${gapBps}bps (Indian FD invariant; threshold ${THRESHOLDS.SENIOR_FLOOR_GAP_BPS}bps)`,
            });
          } else {
            findings.push({
              kind: 'anomaly',
              class: 'WARN',
              bank_code: slug,
              variant,
              check: 'senior_below_general_minor',
              value: { general: g, senior: s },
              location: loc,
              detail: `rate_senior_pct < rate_general_pct by ${gapBps}bps (within ${THRESHOLDS.SENIOR_FLOOR_GAP_BPS}bps tolerance — likely promotional / non-callable / bulk tier where senior premium does not apply)`,
            });
          }
        }
        if (typeof s === 'number' && typeof ss === 'number' && ss < s) {
          const gapBps = Math.round((s - ss) * 100);
          if (gapBps > THRESHOLDS.SENIOR_FLOOR_GAP_BPS) {
            findings.push({
              kind: 'anomaly',
              class: 'ANOMALY',
              bank_code: slug,
              variant,
              check: 'super_senior_below_senior',
              value: { senior: s, super_senior: ss },
              location: loc,
              detail: `rate_super_senior_pct < rate_senior_pct by ${gapBps}bps`,
            });
          } else {
            findings.push({
              kind: 'anomaly',
              class: 'WARN',
              bank_code: slug,
              variant,
              check: 'super_senior_below_senior_minor',
              value: { senior: s, super_senior: ss },
              location: loc,
              detail: `rate_super_senior_pct < rate_senior_pct by ${gapBps}bps (within tolerance)`,
            });
          }
        }
        const tmin = slab.tenure_min_days;
        const tmax = slab.tenure_max_days;
        if (typeof tmin === 'number' && typeof tmax === 'number' && tmin > tmax) {
          findings.push({
            kind: 'anomaly',
            class: 'ANOMALY',
            bank_code: slug,
            variant,
            check: 'inverted_tenure_range',
            value: { tmin, tmax },
            location: loc,
            detail: 'tenure_min_days > tenure_max_days',
          });
        }
        if (typeof tmin === 'number' && tmin < 1) {
          findings.push({
            kind: 'anomaly',
            class: 'ANOMALY',
            bank_code: slug,
            variant,
            check: 'tenure_min_below_1',
            value: tmin,
            location: loc,
            detail: 'tenure_min_days < 1',
          });
        }
        if (typeof tmax === 'number' && tmax > THRESHOLDS.TENURE_DAYS_MAX) {
          findings.push({
            kind: 'anomaly',
            class: 'ANOMALY',
            bank_code: slug,
            variant,
            check: 'tenure_max_too_large',
            value: tmax,
            location: loc,
            detail: `tenure_max_days > ${THRESHOLDS.TENURE_DAYS_MAX}`,
          });
        }
        if ((variant === 'fcnr' || variant === 'gift') && !slab.currency) {
          findings.push({
            kind: 'anomaly',
            class: 'ANOMALY',
            bank_code: slug,
            variant,
            check: 'missing_currency',
            value: null,
            location: loc,
            detail: `${variant} slab missing currency field`,
          });
        }
      }
      // Sprint 008 Phase 3: structural / semantic checks over the whole
      // variant ladder (wrong-table, peer senior-premium, truncated ladder,
      // FCNR currency sanity). headerTokens is unavailable pre-snapshot
      // (Phase 1); classifyTableType falls back to the intrinsic signal.
      const structural = runStructuralChecks(payload.slabs, {
        variant,
        bankType: bank.bank_type,
        peerStats: peerStatsByType[bank.bank_type || '(unknown)'],
      });
      for (const it of structural) {
        findings.push({
          kind: 'anomaly',
          class: it.severity,
          bank_code: slug,
          variant,
          check: it.check,
          value: it.value,
          detail: it.detail,
        });
      }
    }
    // Sprint 008 Phase 7: multi-reference rate-reasonableness (regular variant,
    // canonical buckets). Peer median + repo band + own recent history; one
    // anchor = WARN, >=2 = blocking ANOMALY.
    const reg = bank.products && bank.products.fd && bank.products.fd.regular;
    if (reg && Array.isArray(reg.slabs)) {
      const bt = bank.bank_type || '(unknown)';
      for (const bucket of Object.keys(BUCKETS)) {
        const rate = bucketRate(reg.slabs, bucket);
        if (rate == null) continue;
        const priorRates = historyMaps
          .map((m) => {
            const hr = m.get(slug) && m.get(slug).products && m.get(slug).products.fd && m.get(slug).products.fd.regular;
            return hr && Array.isArray(hr.slabs) ? bucketRate(hr.slabs, bucket) : null;
          })
          .filter((r) => r != null);
        const issues = rateReasonableness({
          rate, bankType: bt, bucket,
          peerStat: (categoryTenureMedians[bt] || {})[bucket] || null,
          macro, priorRates,
          thresholds: { peerBps: THRESHOLDS.PEER_DEVIATION_BPS, histBps: THRESHOLDS.HISTORICAL_DEVIATION_BPS },
        });
        for (const it of issues) {
          findings.push({ kind: 'anomaly', class: it.severity, bank_code: slug, variant: 'regular', check: it.check, value: it.value, detail: it.detail, location: `${slug}/regular[${bucket}]` });
        }
      }
    }
  }
  if (!repoActive) {
    findings.push({ kind: 'anomaly', class: 'INFO', bank_code: null, variant: 'regular', check: 'repo_anchor_inactive', value: null, detail: 'Rate-reasonableness repo anchor inactive (data/macro-rates.json missing or unapproved); peer + historical anchors still applied. Approve via bin/approve-macro-rate.js (ADR-017).' });
  }
  return findings;
}

/**
 * Load and verify the operator key. Returns { key, warning }:
 *   - key:     Buffer/string usable by verifyAccept, or null if missing
 *   - warning: human-readable message about the key state, or null if ok
 *
 * Sprint 005 Phase D2 — the gate fails closed when the key is missing.
 * Every accept entry is rejected unless its signature verifies against
 * the operator key.
 */
function loadOperatorKey() {
  const keyPath = process.env.RDA_OPERATOR_KEY_PATH || path.join(os.homedir(), '.rate-discovery', 'operator.key');
  if (!fs.existsSync(keyPath)) {
    return { key: null, keyPath, warning: `operator key not found at ${keyPath} — all signed accepts will be rejected (fail-closed). See sdlc/sprints/sprint-005/design/observability-and-gate.md.` };
  }
  try {
    const key = fs.readFileSync(keyPath, 'utf-8');
    return { key, keyPath, warning: null };
  } catch (e) {
    return { key: null, keyPath, warning: `operator key at ${keyPath} unreadable (${e.message}) — all signed accepts will be rejected.` };
  }
}

function findingMatchesAccept(finding, accept) {
  if (finding.bank_code !== accept.bank_code) return false;
  if (accept.variant && finding.variant !== accept.variant) return false;
  if (accept.check && finding.check !== accept.check) return false;
  if (accept.class && finding.class !== accept.class) return false;
  return true;
}

function applyAccepts(findings, accepts, { operatorKey, acceptWarnings } = {}) {
  acceptWarnings = acceptWarnings || [];
  if (accepts && typeof accepts === 'object') {
    for (const list of [accepts.accepted_regressions, accepts.accepted_anomalies]) {
      if (Array.isArray(list)) {
        for (const a of list) {
          if (a && typeof a.bank_code === 'string') a.bank_code = aliasToCanonical(a.bank_code);
        }
      }
    }
  }
  const ar = Array.isArray(accepts.accepted_regressions) ? accepts.accepted_regressions : [];
  const aa = Array.isArray(accepts.accepted_anomalies) ? accepts.accepted_anomalies : [];

  // Sprint 005 Phase D2: filter accepts to verified-signature entries only.
  // Unsigned or invalid-signature entries are dropped with a loud warning so the
  // 2026-05-23 incident (agent-fabricated accepts) is structurally impossible.
  // Fail-closed: when operatorKey is null, NO entries are accepted.
  function verifyList(list, label) {
    const out = [];
    for (const a of list) {
      if (!operatorKey) {
        if (a && a.signature) acceptWarnings.push(`${label}: signature present but operator key missing — accept rejected (bank=${a.bank_code}, variant=${a.variant || '-'}).`);
        else if (a && a.bank_code) acceptWarnings.push(`${label}: unsigned accept rejected (bank=${a.bank_code}, variant=${a.variant || '-'}, reason="${a.reason || ''}"). Re-sign via bin/approve-accept.js.`);
        continue;
      }
      const v = verifyAccept(a, operatorKey);
      if (v.valid) {
        out.push(a);
      } else {
        acceptWarnings.push(`${label}: accept REJECTED for bank=${a.bank_code}, variant=${a.variant || '-'}${a.check ? `, check=${a.check}` : ''} — ${v.reason}. Re-sign via bin/approve-accept.js.`);
      }
    }
    return out;
  }

  const verifiedAr = verifyList(ar, 'accepted_regressions');
  const verifiedAa = verifyList(aa, 'accepted_anomalies');

  for (const f of findings) {
    if (f.class === 'REGRESSION') {
      const hit = verifiedAr.find((a) => findingMatchesAccept(f, a));
      if (hit) {
        f.accepted = true;
        f.accept_reason = hit.reason || '';
      }
    } else if (f.class === 'ANOMALY' || f.class === 'ANOMALY_GAIN') {
      const hit = verifiedAa.find((a) => findingMatchesAccept(f, a));
      if (hit) {
        f.accepted = true;
        f.accept_reason = hit.reason || '';
      }
    }
  }
}

function summarize(findings) {
  const summary = {
    regressions: 0, regressions_accepted: 0,
    anomalies: 0, anomalies_accepted: 0,
    warnings: 0, info: 0, gains: 0, new_variants: 0,
  };
  for (const f of findings) {
    if (f.class === 'REGRESSION') {
      summary.regressions++;
      if (f.accepted) summary.regressions_accepted++;
    } else if (f.class === 'ANOMALY' || f.class === 'ANOMALY_GAIN') {
      summary.anomalies++;
      if (f.accepted) summary.anomalies_accepted++;
    } else if (f.class === 'WARN') summary.warnings++;
    else if (f.class === 'INFO') summary.info++;
    else if (f.class === 'GAIN') summary.gains++;
    else if (f.class === 'NEW_VARIANT') summary.new_variants++;
  }
  return summary;
}

function verdictFromSummary(summary) {
  const blockingR = summary.regressions - summary.regressions_accepted;
  const blockingA = summary.anomalies - summary.anomalies_accepted;
  if (blockingR > 0 || blockingA > 0) return 'BLOCK';
  if (summary.warnings > 0) return 'PASS_WITH_WARNINGS';
  return 'PASS';
}

function formatDelta(d) {
  if (!Number.isFinite(d)) return 'NEW';
  return (d >= 0 ? '+' : '') + (d * 100).toFixed(1) + '%';
}

function renderMarkdown({ findings, summary, verdict, newPath, baselinePath, newTotals, baselineTotals, acceptWarnings = [] }) {
  const lines = [];
  lines.push(`# Pack quality gate — ${packDateFromPath(newPath)} vs ${packDateFromPath(baselinePath)}`);
  lines.push('');
  lines.push(`## Verdict: ${verdict}`);
  lines.push('');
  lines.push(`- New pack:      ${path.basename(newPath)} — ${newTotals.banks} banks, ${newTotals.slabs} slabs`);
  lines.push(`- Baseline pack: ${path.basename(baselinePath)} — ${baselineTotals.banks} banks, ${baselineTotals.slabs} slabs`);
  lines.push(`- Net bank delta: ${newTotals.banks - baselineTotals.banks >= 0 ? '+' : ''}${newTotals.banks - baselineTotals.banks}`);
  lines.push(`- Net slab delta: ${newTotals.slabs - baselineTotals.slabs >= 0 ? '+' : ''}${newTotals.slabs - baselineTotals.slabs}`);
  lines.push('');

  if (acceptWarnings.length > 0) {
    lines.push('## Accept verification warnings (Sprint 005 Phase D2)');
    lines.push('');
    lines.push('The following accept entries were REJECTED because their signatures were missing, invalid, or could not be verified against the operator key. Re-sign via `bin/approve-accept.js`.');
    lines.push('');
    for (const w of acceptWarnings) lines.push(`- ${w}`);
    lines.push('');
  }

  lines.push('## Summary counts');
  lines.push('');
  lines.push(`- REGRESSIONS: ${summary.regressions} (blocking: ${summary.regressions - summary.regressions_accepted}, accepted: ${summary.regressions_accepted})`);
  lines.push(`- ANOMALIES:   ${summary.anomalies} (blocking: ${summary.anomalies - summary.anomalies_accepted}, accepted: ${summary.anomalies_accepted})`);
  lines.push(`- WARNINGS:    ${summary.warnings}`);
  lines.push(`- INFO:        ${summary.info}`);
  lines.push(`- GAINS:       ${summary.gains}`);
  lines.push(`- NEW VARIANTS: ${summary.new_variants}`);
  lines.push('');

  const regressions = findings.filter((f) => f.class === 'REGRESSION');
  lines.push(`## Regressions (${regressions.length})`);
  lines.push('');
  if (regressions.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| bank_code | variant | baseline | new | delta | accepted | reason |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const f of regressions.slice(0, 200)) {
      lines.push(`| ${f.bank_code} | ${f.variant || '—'} | ${f.baseline} | ${f.actual} | ${formatDelta(f.delta)} | ${f.accepted ? 'yes' : 'NO'} | ${f.accept_reason || f.detail || ''} |`);
    }
    if (regressions.length > 200) lines.push(`_…${regressions.length - 200} more truncated._`);
  }
  lines.push('');

  const anomalies = findings.filter((f) => f.class === 'ANOMALY' || f.class === 'ANOMALY_GAIN');
  lines.push(`## Anomalies (${anomalies.length})`);
  lines.push('');
  if (anomalies.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| bank_code | variant | check | value | accepted | detail |');
    lines.push('|---|---|---|---|---|---|');
    for (const f of anomalies.slice(0, 200)) {
      const val = typeof f.value === 'object' && f.value !== null ? JSON.stringify(f.value) : String(f.value);
      lines.push(`| ${f.bank_code} | ${f.variant || '—'} | ${f.check || (f.class === 'ANOMALY_GAIN' ? 'anomalous_gain' : '')} | ${val} | ${f.accepted ? 'yes' : 'NO'} | ${f.detail || ''} |`);
    }
    if (anomalies.length > 200) lines.push(`_…${anomalies.length - 200} more truncated._`);
  }
  lines.push('');

  const warnings = findings.filter((f) => f.class === 'WARN');
  lines.push(`## Warnings (${warnings.length})`);
  lines.push('');
  if (warnings.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| bank_code | variant | kind | baseline | new | delta | detail |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const f of warnings.slice(0, 100)) {
      const b = f.baseline != null ? f.baseline : '—';
      const a = f.actual != null ? f.actual : '—';
      const d = f.delta != null ? formatDelta(f.delta) : '—';
      lines.push(`| ${f.bank_code} | ${f.variant || '—'} | ${f.kind} | ${b} | ${a} | ${d} | ${f.detail || ''} |`);
    }
    if (warnings.length > 100) lines.push(`_…${warnings.length - 100} more truncated._`);
  }
  lines.push('');

  const gains = findings.filter((f) => f.class === 'GAIN' || f.class === 'NEW_VARIANT').sort((a, b) => {
    const av = a.actual - a.baseline;
    const bv = b.actual - b.baseline;
    return bv - av;
  });
  lines.push(`## Top gains (${gains.length} total, showing 30)`);
  lines.push('');
  if (gains.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| bank_code | variant | baseline | new | delta | detail |');
    lines.push('|---|---|---|---|---|---|');
    for (const f of gains.slice(0, 30)) {
      lines.push(`| ${f.bank_code} | ${f.variant || '—'} | ${f.baseline} | ${f.actual} | ${formatDelta(f.delta)} | ${f.detail || ''} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { positional: [], accepts: null, outDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--accepts') { args.accepts = argv[++i]; }
    else if (a === '--out-dir') { args.outDir = argv[++i]; }
    else if (a === '--help' || a === '-h') { args.help = true; }
    else args.positional.push(a);
  }
  return args;
}

function runGate({ newPath, baselinePath, acceptsPath, outDir, repoRoot }) {
  const newPack = canonicalizePackSlugs(readJson(newPath));
  const baselinePack = canonicalizePackSlugs(readJson(baselinePath));
  let accepts = { accepted_regressions: [], accepted_anomalies: [] };
  if (acceptsPath && fs.existsSync(acceptsPath)) {
    try { accepts = readJson(acceptsPath); } catch (_) { /* fall back to empty */ }
  }
  const partialSilent = loadPartialSilentSet(repoRoot);
  const history = loadHistoryPacks(repoRoot, THRESHOLDS.HISTORY_DEPTH);
  const macro = loadMacroRates(repoRoot);

  // Sprint 005 Phase D2: load operator key for signature verification.
  // Fail-closed: missing key ⇒ no accepts honored.
  const { key: operatorKey, keyPath: operatorKeyPath, warning: keyWarning } = loadOperatorKey();
  const acceptWarnings = [];
  if (keyWarning) acceptWarnings.push(keyWarning);

  const findings = [
    ...pass1and2_compare({ newPack, baselinePack, partialSilent }),
    ...pass3_anomalies({ newPack, baselinePack, history, macro }),
  ];
  applyAccepts(findings, accepts, { operatorKey, acceptWarnings });
  const summary = summarize(findings);
  const verdict = verdictFromSummary(summary);

  const newT = totalsByBank(newPack);
  const oldT = totalsByBank(baselinePack);
  const newTotals = { banks: newT.totals.size, slabs: [...newT.totals.values()].reduce((a, b) => a + b, 0) };
  const baselineTotals = { banks: oldT.totals.size, slabs: [...oldT.totals.values()].reduce((a, b) => a + b, 0) };

  const md = renderMarkdown({ findings, summary, verdict, newPath, baselinePath, newTotals, baselineTotals, acceptWarnings });
  const json = {
    new_pack: path.basename(newPath),
    baseline_pack: path.basename(baselinePath),
    verdict,
    summary,
    new_totals: newTotals,
    baseline_totals: baselineTotals,
    findings,
    accept_warnings: acceptWarnings,
    signed_accepts: { operator_key_path: operatorKeyPath, operator_key_loaded: operatorKey != null },
    generated_at: new Date().toISOString(),
    thresholds: THRESHOLDS,
  };

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    // safe-write-exempt: quality-gate aggregator output (pack-level report), not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(path.join(outDir, 'quality-report.md'), md);
    // safe-write-exempt: quality-gate aggregator output (pack-level report), not a per-bank canonical artifact (ADR-012).
    fs.writeFileSync(path.join(outDir, 'quality-report.json'), JSON.stringify(json, null, 2));
  }
  return { md, json, verdict, summary, findings, acceptWarnings };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positional.length < 2) {
    console.error('Usage: node scripts/quality-gate.js <new-pack> <baseline-pack> [--accepts <file>] [--out-dir <dir>]');
    process.exit(2);
  }
  const repoRoot = process.cwd();
  const [newPath, baselinePath] = args.positional;
  const acceptsPath = args.accepts || path.join(repoRoot, 'pack', 'quality-gate-accepts.json');
  const outDir = args.outDir || path.join(repoRoot, 'pack', 'dist');

  let result;
  try {
    result = runGate({ newPath, baselinePath, acceptsPath, outDir, repoRoot });
  } catch (err) {
    if (err.code === 'GATE_INPUT_ERROR') {
      console.error('ERROR:', err.message);
      process.exit(2);
    }
    throw err;
  }
  process.stdout.write(result.md + '\n');
  console.error(`\nVerdict: ${result.verdict}`);
  console.error(`Reports written to ${outDir}/quality-report.{md,json}`);
  if (result.verdict === 'BLOCK') process.exit(1);
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  THRESHOLDS,
  classifyDelta,
  pass1and2_compare,
  pass3_anomalies,
  applyAccepts,
  summarize,
  verdictFromSummary,
  renderMarkdown,
  runGate,
  loadPartialSilentSet,
};
