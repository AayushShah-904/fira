const router = require('express').Router();
const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

// ── Plan limits ───────────────────────────────────────────────────
// free: top 20 results, domestic only, major bank categories only (PSB/PVB/SFB)
// pro/enterprise: all results, all products, all categories
function isPro(user) {
  return user && (user.plan === 'pro' || user.plan === 'enterprise');
}

const FREE_CATEGORIES = ['PSB','PVB','SFB'];
const FREE_PRODUCTS   = ['domestic'];
const FREE_LIMIT      = 20;

// GET /api/v1/rates/best
router.get('/best', requireAuth, (req, res) => {
  const { product = 'domestic', senior = 'false', category, limit } = req.query;
  const pro = isPro(req.user);
  const db  = getDb();

  // Enforce free tier restrictions (allow all products for best-rate headline queries)
  const effectiveProduct = product;
  const effectiveLimit   = pro ? Math.min(100, parseInt(limit) || 40) : FREE_LIMIT;
  const rateCol = senior === 'true'
    ? 'COALESCE(r.rate_senior, r.rate_general)'
    : 'r.rate_general';

  let catFilter = '';
  const params  = [effectiveProduct];

  // Exclude foreign banks and IBUs from domestic product queries
  // unless a specific category is requested
  const EXCLUDE_FROM_DOMESTIC = ['FB', 'IBU'];

  if (category) {
    // Respect user's category request (both pro and free)
    // Free users can still filter to PSB/PVB/SFB since those are in FREE_CATEGORIES
    if (!pro && !FREE_CATEGORIES.includes(category)) {
      // Free user requested a Pro-only category — fall back to free filter
      catFilter = ` AND c.code IN ('${FREE_CATEGORIES.join("','")}')`;
    } else {
      catFilter = ' AND c.code=?';
      params.push(category);
    }
  } else if (!pro && product === 'domestic') {
    catFilter = ` AND c.code IN ('${FREE_CATEGORIES.join("','")}')`;
  } else if (product === 'domestic') {
    // Pro users without category filter: exclude FB and IBU from domestic
    catFilter = ` AND c.code NOT IN ('${EXCLUDE_FROM_DOMESTIC.join("','")}')`;
  }

  const sql = `
    SELECT r.*, b.name AS bank_name, b.short_name, b.state, b.hq_city,
           b.crisil_rating, b.icra_rating, b.dicgc_member, b.website,
           c.code AS category_code, c.name AS category_name,
           c.dicgc_covered, c.regulator,
           ${rateCol} AS sort_rate
    FROM fd_rates r
    JOIN banks b ON r.bank_id = b.id
    JOIN bank_categories c ON b.category_id = c.id
    WHERE r.product_type=?
      AND (r.effective_to IS NULL OR r.effective_to >= date('now'))
      AND b.is_active=1
      AND r.effective_from = (
        SELECT MAX(r2.effective_from)
        FROM fd_rates r2
        WHERE r2.bank_id = r.bank_id 
          AND r2.product_type = r.product_type
          AND r2.tenure_days_min = r.tenure_days_min
          AND r2.tenure_days_max = r.tenure_days_max
      )
      ${catFilter}
    ORDER BY sort_rate DESC
    LIMIT ?
  `;
  params.push(effectiveLimit);
  const rates = db.prepare(sql).all(...params);

  res.json({
    data: rates,
    as_of: new Date().toISOString().split('T')[0],
    plan: req.user.plan,
    limited: !pro,
    limit_reason: !pro ? 'Upgrade to Pro to unlock all categories, products and unlimited results' : null,
  });
});

// GET /api/v1/rates/products
router.get('/products', requireAuth, (req, res) => {
  const pro = isPro(req.user);
  const all = [
    { code: 'domestic',  label: 'Domestic FD',         currency: 'INR', nri_only: false, free: true  },
    { code: 'nre',       label: 'NRE FD',               currency: 'INR', nri_only: true,  free: false },
    { code: 'nro',       label: 'NRO FD',               currency: 'INR', nri_only: true,  free: false },
    { code: 'fcnr_usd',  label: 'FCNR(B) — USD',        currency: 'USD', nri_only: true,  free: false },
    { code: 'fcnr_gbp',  label: 'FCNR(B) — GBP',        currency: 'GBP', nri_only: true,  free: false },
    { code: 'fcnr_eur',  label: 'FCNR(B) — EUR',        currency: 'EUR', nri_only: true,  free: false },
    { code: 'fcnr_cad',  label: 'FCNR(B) — CAD',        currency: 'CAD', nri_only: true,  free: false },
    { code: 'fcnr_aud',  label: 'FCNR(B) — AUD',        currency: 'AUD', nri_only: true,  free: false },
    { code: 'ibu_usd',   label: 'Gift City IBU — USD',  currency: 'USD', nri_only: true,  free: false },
    { code: 'ibu_eur',   label: 'Gift City IBU — EUR',  currency: 'EUR', nri_only: true,  free: false },
    { code: 'ibu_gbp',   label: 'Gift City IBU — GBP',  currency: 'GBP', nri_only: true,  free: false },
    { code: 'ibu_aed',   label: 'Gift City IBU — AED',  currency: 'AED', nri_only: true,  free: false },
    { code: 'tax_saver', label: 'Tax Saver FD (80C)',   currency: 'INR', nri_only: false, free: false },
  ];
  res.json({ data: pro ? all : all.map(p => ({ ...p, locked: !p.free })) });
});

module.exports = router;
