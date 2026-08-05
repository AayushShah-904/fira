const router = require('express').Router();
const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

// GET /api/v1/simulator/best-rates
// Returns best verified live FD rate per key category, plus top IBU/NRE/FCNR
router.get('/best-rates', requireAuth, (req, res) => {
  const db = getDb();

  const products = ['domestic', 'nre', 'fcnr_usd', 'ibu_usd'];
  const results = {};

  for (const product of products) {
    const row = db.prepare(`
      SELECT r.rate_general, r.tenure_label, r.effective_from, r.verified,
             b.name as bank_name, b.short_name, c.code as category_code
      FROM fd_rates r
      JOIN banks b ON b.id = r.bank_id
      JOIN bank_categories c ON c.id = b.category_id
      WHERE r.product_type = ?
        AND b.is_active = 1
        AND r.effective_from >= '2025-10-01'
        AND r.effective_from <= '2026-04-30'
        AND (r.effective_to IS NULL OR r.effective_to >= date('now'))
        ${product === 'domestic' ? "AND c.code NOT IN ('FB','IBU')" : ''}
      ORDER BY r.rate_general DESC
      LIMIT 1
    `).get(product);
    if (row) results[product] = row;
  }

  res.json({
    rates: results,
    as_of: new Date().toISOString(),
  });
});

module.exports = router;
