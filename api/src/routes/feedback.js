const router = require('express').Router();
const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

const VALID_CATEGORIES = ['bug', 'feature', 'general'];

// POST /api/v1/feedback
router.post('/', requireAuth, (req, res) => {
  const { category = 'general', message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const db = getDb();
  const result = db.prepare(
    'INSERT INTO feedback(user_id, category, message) VALUES(?, ?, ?)'
  ).run(req.user.id, category, message.trim());

  res.status(201).json({
    data: db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid),
  });
});

module.exports = router;
