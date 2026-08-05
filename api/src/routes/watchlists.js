const router = require('express').Router();
const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

// ─── WATCHLISTS ───────────────────────────────────────────────────

// GET /api/v1/watchlists
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const lists = db.prepare(`
    SELECT w.*, COUNT(wb.bank_id) as bank_count
    FROM watchlists w
    LEFT JOIN watchlist_banks wb ON wb.watchlist_id = w.id
    WHERE w.user_id=? GROUP BY w.id ORDER BY w.created_at DESC
  `).all(req.user.id);
  res.json({ data: lists });
});

// POST /api/v1/watchlists
router.post('/', requireAuth, (req, res) => {
  const isPro = req.user.plan === 'pro' || req.user.plan === 'enterprise';
  if (!isPro) return res.status(403).json({ error: 'Watchlists require a Pro plan', upgrade: true });
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const db = getDb();
  const r = db.prepare('INSERT INTO watchlists(user_id,name,description) VALUES(?,?,?)').run(req.user.id, name, description || null);
  res.status(201).json({ data: db.prepare('SELECT * FROM watchlists WHERE id=?').get(r.lastInsertRowid) });
});

// DELETE /api/v1/watchlists/:id
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const wl = db.prepare('SELECT * FROM watchlists WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!wl) return res.status(404).json({ error: 'Watchlist not found' });
  db.prepare('DELETE FROM watchlists WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/v1/watchlists/:id/banks
router.get('/:id/banks', requireAuth, (req, res) => {
  const db = getDb();
  const wl = db.prepare('SELECT * FROM watchlists WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!wl) return res.status(404).json({ error: 'Watchlist not found' });

  const banks = db.prepare(`
    SELECT b.*, c.code AS category_code, c.name AS category_name, c.dicgc_covered,
           MAX(r.rate_general) AS best_domestic,
           wb.added_at
    FROM watchlist_banks wb
    JOIN banks b ON wb.bank_id = b.id
    JOIN bank_categories c ON b.category_id = c.id
    LEFT JOIN fd_rates r ON r.bank_id = b.id AND r.product_type='domestic'
      AND (r.effective_to IS NULL OR r.effective_to >= date('now'))
    WHERE wb.watchlist_id=?
    GROUP BY b.id ORDER BY wb.added_at DESC
  `).all(req.params.id);

  res.json({ data: { ...wl, banks } });
});

// POST /api/v1/watchlists/:id/banks
router.post('/:id/banks', requireAuth, (req, res) => {
  const { bank_id } = req.body;
  if (!bank_id) return res.status(400).json({ error: 'bank_id required' });
  const db = getDb();
  const wl = db.prepare('SELECT * FROM watchlists WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!wl) return res.status(404).json({ error: 'Watchlist not found' });
  try {
    db.prepare('INSERT INTO watchlist_banks(watchlist_id,bank_id) VALUES(?,?)').run(req.params.id, bank_id);
    res.status(201).json({ success: true });
  } catch {
    res.status(409).json({ error: 'Bank already in watchlist' });
  }
});

// DELETE /api/v1/watchlists/:id/banks/:bankId
router.delete('/:id/banks/:bankId', requireAuth, (req, res) => {
  const db = getDb();
  const wl = db.prepare('SELECT * FROM watchlists WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!wl) return res.status(404).json({ error: 'Watchlist not found' });
  db.prepare('DELETE FROM watchlist_banks WHERE watchlist_id=? AND bank_id=?').run(req.params.id, req.params.bankId);
  res.json({ success: true });
});

// ─── CLIENT PROFILES ─────────────────────────────────────────────

// GET /api/v1/watchlists/clients (sub-path)
router.get('/clients/list', requireAuth, (req, res) => {
  const db = getDb();
  const clients = db.prepare('SELECT * FROM client_profiles WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({ data: clients });
});

// POST /api/v1/watchlists/clients
router.post('/clients', requireAuth, (req, res) => {
  const { client_ref, tax_slab_pct, is_senior, is_nri, inflation_pct, risk_profile } = req.body;
  if (!client_ref) return res.status(400).json({ error: 'client_ref required' });
  const db = getDb();
  try {
    const r = db.prepare(`
      INSERT INTO client_profiles(user_id,client_ref,tax_slab_pct,is_senior,is_nri,inflation_pct,risk_profile)
      VALUES(?,?,?,?,?,?,?)
    `).run(req.user.id, client_ref, tax_slab_pct ?? 30, is_senior ? 1 : 0,
           is_nri ? 1 : 0, inflation_pct ?? 4.5, risk_profile || 'moderate');
    res.status(201).json({ data: db.prepare('SELECT * FROM client_profiles WHERE id=?').get(r.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'Client ref already exists' });
  }
});

module.exports = router;
