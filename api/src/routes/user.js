const router = require('express').Router();
const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

const ALLOWED_ANSWERS = [
  'comparing_ibu',
  'comparing_nre_fcnr',
  'deposits_vs_mf',
  'just_exploring',
];

// GET /api/v1/user/onboarding — check if user has seen the onboarding question
router.get('/onboarding', requireAuth, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT onboarding_seen, onboarding_answer FROM users WHERE id = ?')
    .get(req.user.id);
  res.json({
    seen: (row?.onboarding_seen ?? 0) === 1,
    answer: row?.onboarding_answer || null,
  });
});

// POST /api/v1/user/onboarding — save user's answer
router.post('/onboarding', requireAuth, (req, res) => {
  const { answer } = req.body || {};
  if (!ALLOWED_ANSWERS.includes(answer)) {
    return res.status(400).json({ error: 'Invalid answer' });
  }
  const db = getDb();
  db.prepare('UPDATE users SET onboarding_answer = ?, onboarding_seen = 1 WHERE id = ?')
    .run(answer, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
