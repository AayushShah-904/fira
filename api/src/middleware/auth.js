const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/connection');

const DEFAULT_SECRET = 'fira-dev-secret-change-in-prod';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '24h';

// Refuse to start with the default secret in production
if (process.env.NODE_ENV === 'production' && JWT_SECRET === DEFAULT_SECRET) {
  throw new Error('JWT_SECRET must be set to a strong random value in production. Refusing to start.');
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, plan: user.plan },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function requireAuth(req, res, next) {
  // Check Authorization header — Bearer token or API key
  const authHeader = req.headers['authorization'] || '';

  if (authHeader.startsWith('Bearer ')) {
    // JWT auth
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE id=? AND is_active=1').get(decoded.sub);
      if (!user) return res.status(401).json({ error: 'User not found or inactive' });
      req.user = user;
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  if (authHeader.startsWith('ApiKey ')) {
    // API Key auth — use key_prefix for indexed lookup instead of scanning all keys
    const rawKey = authHeader.slice(7);
    const prefix = rawKey.substring(0, 8);
    const db = getDb();
    const keys = db.prepare(`
      SELECT ak.*, u.email, u.role, u.plan, u.name, u.firm FROM api_keys ak
      JOIN users u ON ak.user_id = u.id
      WHERE ak.key_prefix=? AND ak.is_active=1 AND u.is_active=1
        AND (ak.expires_at IS NULL OR ak.expires_at > datetime('now'))
    `).all(prefix);
    for (const k of keys) {
      if (bcrypt.compareSync(rawKey, k.key_hash)) {
        db.prepare("UPDATE api_keys SET last_used=datetime('now') WHERE id=?").run(k.id);
        req.user = { id: k.user_id, email: k.email, role: k.role, plan: k.plan, name: k.name, firm: k.firm };
        return next();
      }
    }
    return res.status(401).json({ error: 'Invalid API key' });
  }

  return res.status(401).json({ error: 'Authentication required' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole, JWT_SECRET };
