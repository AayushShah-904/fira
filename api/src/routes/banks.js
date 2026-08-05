const router = require('express').Router();
const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

// GET /api/v1/banks  — list banks with filters
router.get('/', requireAuth, (req, res) => {
  const {
    category, state, scheduled, rated, search, mode,
    page = 1, limit = 50, sort = 'name',
  } = req.query;

  const MODE_CATEGORIES = {
    dom: ['PSB','PVB','SFB','SCH_UCB','NS_UCB','DCCB','SSCB','NSSCB','RRB','PB','LAB','NBFC'],
    nri: ['PSB','PVB','SFB','IBU','FB','SCH_UCB'],
  };

  const db = getDb();
  const SORT_MAP = {
    name: 'b.name',
    state: 'b.state',
    deposits_cr: 'b.deposits_cr',
    crar_pct: 'b.crar_pct',
    npa_pct: 'b.npa_pct',
  };
  const orderCol = SORT_MAP[sort] || 'b.name';

  let where = ['b.is_active=1'];
  const params = [];

  if (category) {
    where.push('c.code=?'); params.push(category);
  } else if (mode && MODE_CATEGORIES[mode]) {
    const cats = MODE_CATEGORIES[mode];
    where.push(`c.code IN (${cats.map(() => '?').join(',')})`);
    params.push(...cats);
  }
  if (state)    { where.push('b.state=?'); params.push(state); }
  if (scheduled !== undefined) { where.push('b.scheduled=?'); params.push(scheduled === 'true' ? 1 : 0); }
  if (rated === 'true') { where.push("(b.crisil_rating IS NOT NULL OR b.icra_rating IS NOT NULL)"); }
  if (search) {
    where.push('(b.name LIKE ? OR b.short_name LIKE ? OR b.hq_city LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const lim = Math.min(100, parseInt(limit) || 50);

  const sql = `
    SELECT b.*, c.code AS category_code, c.name AS category_name,
           c.dicgc_covered, c.regulator
    FROM banks b
    JOIN bank_categories c ON b.category_id = c.id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderCol} ASC
    LIMIT ? OFFSET ?
  `;

  const countSql = `
    SELECT COUNT(*) as total FROM banks b
    JOIN bank_categories c ON b.category_id = c.id
    WHERE ${where.join(' AND ')}
  `;

  const banks = db.prepare(sql).all(...params, lim, offset);
  const { total } = db.prepare(countSql).get(...params);

  res.json({
    data: banks,
    pagination: { page: parseInt(page), limit: lim, total, pages: Math.ceil(total / lim) },
  });
});

// GET /api/v1/banks/stats  — live bank count for UI
router.get('/stats', requireAuth, (req, res) => {
  const db = getDb();
  const { total } = db.prepare('SELECT COUNT(*) as total FROM banks WHERE is_active=1').get();
  const byCategory = db.prepare(`
    SELECT c.code, COUNT(b.id) as count
    FROM bank_categories c
    LEFT JOIN banks b ON b.category_id = c.id AND b.is_active=1
    GROUP BY c.id ORDER BY c.sort_order
  `).all();
  res.json({ total, by_category: byCategory });
});

// GET /api/v1/banks/category-rates?mode=dom|nri
router.get('/category-rates', requireAuth, (req, res) => {
  const mode = req.query.mode === 'dom' ? 'dom' : 'nri';

  // Domestic mode: Indian banks (PSB/PVB/SFB/UCB/DCCB/SCB/SSCB/NSSCB/RRB/PB/LAB)
  // NRI mode: only IBU (Gift City) — NRE/NRO/FCNR are products of domestic banks
  const NRI_CATEGORIES = ['IBU'];
  const DOM_CATEGORIES = ['PSB','PVB','SFB','SCH_UCB','NS_UCB','DCCB','SCB','SSCB','NSSCB','RRB','PB','LAB','NBFC'];
  const cats = mode === 'nri' ? NRI_CATEGORIES : DOM_CATEGORIES;
  const catFilter = `c.code IN ('${cats.join("','")}')`;

  const db = getDb();
  const rows = db.prepare(`
    SELECT
      c.id,
      c.code,
      c.name,
      c.description,
      c.dicgc_covered,
      c.regulator,
      c.sort_order,
      COUNT(DISTINCT b.id) AS bank_count,
      COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN b.id END) AS banks_with_rates,
      MAX(r.rate_general)  AS best_rate,
      MAX(r.rate_senior)   AS best_rate_senior,
      (
        SELECT r2.product_type
        FROM fd_rates r2
        JOIN banks b2 ON r2.bank_id = b2.id
        WHERE b2.category_id = c.id
          AND (r2.effective_to IS NULL OR r2.effective_to >= date('now'))
          AND r2.effective_from = (
            SELECT MAX(r3.effective_from)
            FROM fd_rates r3
            WHERE r3.bank_id = r2.bank_id 
              AND r3.product_type = r2.product_type
              AND r3.tenure_days_min = r2.tenure_days_min
              AND r3.tenure_days_max = r2.tenure_days_max
          )
          AND b2.is_active = 1
        ORDER BY r2.rate_general DESC
        LIMIT 1
      ) AS best_product_type,
      (
        SELECT b2.name
        FROM fd_rates r2
        JOIN banks b2 ON r2.bank_id = b2.id
        WHERE b2.category_id = c.id
          AND (r2.effective_to IS NULL OR r2.effective_to >= date('now'))
          AND r2.effective_from = (
            SELECT MAX(r3.effective_from)
            FROM fd_rates r3
            WHERE r3.bank_id = r2.bank_id 
              AND r3.product_type = r2.product_type
              AND r3.tenure_days_min = r2.tenure_days_min
              AND r3.tenure_days_max = r2.tenure_days_max
          )
          AND b2.is_active = 1
        ORDER BY r2.rate_general DESC
        LIMIT 1
      ) AS best_bank_name
    FROM bank_categories c
    LEFT JOIN banks b ON b.category_id = c.id AND b.is_active = 1
    LEFT JOIN fd_rates r
      ON r.bank_id = b.id
      AND (r.effective_to IS NULL OR r.effective_to >= date('now'))
      AND r.effective_from = (
        SELECT MAX(r2.effective_from)
        FROM fd_rates r2
        WHERE r2.bank_id = r.bank_id 
          AND r2.product_type = r.product_type
          AND r2.tenure_days_min = r.tenure_days_min
          AND r2.tenure_days_max = r.tenure_days_max
      )
    WHERE ${catFilter}
    GROUP BY c.id
    ORDER BY c.sort_order
  `).all();
  res.json({ data: rows });
});

// GET /api/v1/banks/categories
router.get('/categories', requireAuth, (req, res) => {
  const db = getDb();
  const categories = db.prepare(`
    SELECT c.*, COUNT(b.id) as bank_count
    FROM bank_categories c
    LEFT JOIN banks b ON b.category_id = c.id AND b.is_active=1
    GROUP BY c.id ORDER BY c.sort_order
  `).all();
  res.json({ data: categories });
});

// GET /api/v1/banks/:id
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const bank = db.prepare(`
    SELECT b.*, c.code AS category_code, c.name AS category_name,
           c.dicgc_covered, c.regulator
    FROM banks b JOIN bank_categories c ON b.category_id = c.id
    WHERE b.id=? AND b.is_active=1
  `).get(req.params.id);

  if (!bank) return res.status(404).json({ error: 'Bank not found' });

  // Attach only the latest rates (by maximum effective_from date) for each product type
  const rates = db.prepare(`
    SELECT r.* FROM fd_rates r
    WHERE r.bank_id=? AND (r.effective_to IS NULL OR r.effective_to >= date('now'))
      AND r.effective_from = (
        SELECT MAX(r2.effective_from)
        FROM fd_rates r2
        WHERE r2.bank_id = r.bank_id 
          AND r2.product_type = r.product_type
          AND r2.tenure_days_min = r.tenure_days_min
          AND r2.tenure_days_max = r.tenure_days_max
      )
    ORDER BY r.product_type, r.tenure_days_min
  `).all(req.params.id);

  res.json({ data: { ...bank, rates } });
});

// GET /api/v1/banks/:id/rates
router.get('/:id/rates', requireAuth, (req, res) => {
  const db = getDb();
  const { product } = req.query;

  // Filter for the latest rates by maximum effective_from date
  let where = `r.bank_id=? AND (r.effective_to IS NULL OR r.effective_to >= date('now'))
    AND r.effective_from = (
      SELECT MAX(r2.effective_from)
      FROM fd_rates r2
      WHERE r2.bank_id = r.bank_id 
        AND r2.product_type = r.product_type
        AND r2.tenure_days_min = r.tenure_days_min
        AND r2.tenure_days_max = r.tenure_days_max
    )`;
  const params = [req.params.id];
  if (product) { where += ' AND r.product_type=?'; params.push(product); }

  const rates = db.prepare(`
    SELECT r.* FROM fd_rates r WHERE ${where}
    ORDER BY r.product_type, r.tenure_days_min
  `).all(...params);

  res.json({ data: rates });
});

module.exports = router;
