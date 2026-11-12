const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const bankRoutes = require('./routes/banks');
const rateRoutes = require('./routes/rates');
const watchlistRoutes = require('./routes/watchlists');
const adminRoutes = require('./routes/admin');
const feedbackRoutes = require('./routes/feedback');
const analyticsRoutes = require('./routes/analytics');
const userRoutes = require('./routes/user');
const simulatorRoutes = require('./routes/simulator');

const app = express();
const PORT = process.env.PORT || 4000;

// ─── SECURITY ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
}));

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://52.172.225.199,http://fia-bharatomni.centralindia.cloudapp.azure.com,https://fia.bharatomni.com')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      allowedOrigins.includes('*') ||
      allowedOrigins.includes(origin) ||
      origin.includes('cloudapp.azure.com') ||
      origin.includes('52.172.225.199') ||
      origin.includes('bharatomni.com') ||
      origin.includes('localhost')
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
}));

// ─── RATE LIMITING ───────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', limiter);

// Auth endpoints get a stricter limit
const authLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
app.use('/api/v1/auth/', authLimiter);

// ─── PARSING & LOGGING ───────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// ─── HEALTH CHECK ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0-beta',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// ─── ROUTES ──────────────────────────────────────────────────────
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/banks', bankRoutes);
app.use('/api/v1/rates', rateRoutes);
app.use('/api/v1/watchlists', watchlistRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/feedback', feedbackRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/user', userRoutes);
app.use('/api/v1/simulator', simulatorRoutes);
// app.use('/api/v1/evaluation', require('../../evaluation-ui/api/evaluation-routes'));

// ─── STATIC UI (Fallback if ui/dist exists) ───────────────────────
const fs = require('fs');
const uiDist = path.resolve(__dirname, '../../ui/dist');
if (fs.existsSync(uiDist)) {
  app.use(express.static(uiDist));
  app.get('*', (req, res, next) => {
    if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/health')) {
      return next();
    }
    res.sendFile(path.join(uiDist, 'index.html'));
  });
}

// ─── 404 ─────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ error: `Route ${req.originalUrl} not found` });
});

// ─── ERROR HANDLER ───────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ─── PROCESS-LEVEL CRASH GUARDS ──────────────────────────────────
// Log but don't crash on unexpected errors (common causes: DB locks,
// unhandled async errors inside fire-and-forget paths like analytics).
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// ─── BOOT ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 FIA API v0.1.0-beta`);
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);

  // Start scheduler service
  try {
    const scheduler = require('./services/scheduler');
    scheduler.init();
  } catch (err) {
    console.error('Failed to initialize scheduler service:', err);
  }
});

module.exports = app;
