const router = require('express').Router();
const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

// Prepared statement cache — compiled once per process
let _stmt = null;
function getStmt() {
  if (!_stmt) {
    _stmt = getDb().prepare(`
      INSERT INTO audit_log(user_id, action, resource, resource_id, ip_address, user_agent)
      VALUES(?, 'page_view', ?, ?, ?, ?)
    `);
  }
  return _stmt;
}

// POST /api/v1/analytics/page-view — log a page view
// Respond first, then write async so a slow/locked DB never blocks the response
router.post('/page-view', requireAuth, (req, res) => {
  const { path, duration_ms } = req.body || {};
  if (!path || typeof path !== 'string' || path.length > 200) {
    return res.status(400).json({ error: 'path required' });
  }

  // Respond immediately — analytics is fire-and-forget from the user's POV
  res.json({ ok: true });

  // Write after response (setImmediate keeps it out of the request path)
  setImmediate(() => {
    try {
      getStmt().run(
        req.user.id,
        path,
        duration_ms ? String(Math.floor(duration_ms)) : null,
        req.ip || null,
        (req.headers['user-agent'] || '').slice(0, 200)
      );
    } catch (e) {
      console.warn('[analytics] page-view write failed:', e.message);
    }
  });
});

module.exports = router;
