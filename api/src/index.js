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
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
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
