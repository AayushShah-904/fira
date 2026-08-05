-- FIA DB Schema v1 (Fixed Income Rate Analytics)
-- Designed for RIA (Registered Investment Advisor) use

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── USERS & AUTH ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL UNIQUE,
  password_hash TEXT   NOT NULL,
  name         TEXT    NOT NULL,
  firm         TEXT,
  ria_reg_no   TEXT,
  role         TEXT    NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin','viewer','guest')),
  plan         TEXT    NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro','enterprise','guest')),
  advisor_type    TEXT,   -- 'ria','mfd','ca','wealth_manager','corporate_treasury','nri_advisor','other'
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login      TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  onboarding_answer TEXT,
  onboarding_seen INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash     TEXT    NOT NULL UNIQUE,
  key_prefix   TEXT    NOT NULL,
  label        TEXT,
  last_used    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ─── BANK CATEGORIES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  description  TEXT,
  regulator    TEXT,
  dicgc_covered INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- ─── BANKS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS banks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id     INTEGER NOT NULL REFERENCES bank_categories(id),
  name            TEXT    NOT NULL,
  short_name      TEXT,
  state           TEXT,
  hq_city         TEXT,
  ro_region       TEXT,
  website         TEXT,
  rbi_licence_no  TEXT,
  dicgc_member    INTEGER NOT NULL DEFAULT 1,
  scheduled       INTEGER NOT NULL DEFAULT 0,
  crisil_rating   TEXT,
  icra_rating     TEXT,
  care_rating      TEXT,
  rating_date     TEXT,
  deposits_cr     REAL,
  advances_cr     REAL,
  npa_pct         REAL,
  crar_pct        REAL,
  deposit_retail  INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_banks_category ON banks(category_id);
CREATE INDEX IF NOT EXISTS idx_banks_state ON banks(state);

-- ─── FD RATES ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fd_rates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id         INTEGER NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  product_type    TEXT    NOT NULL CHECK(product_type IN (
                    'domestic','nre','nro','fcnr_usd','fcnr_gbp',
                    'fcnr_eur','fcnr_cad','fcnr_aud','ibu_usd',
                    'ibu_eur','ibu_gbp','ibu_aed','tax_saver')),
  tenure_days_min INTEGER NOT NULL,
  tenure_days_max INTEGER NOT NULL,
  tenure_label    TEXT    NOT NULL,
  rate_general    REAL    NOT NULL,
  rate_senior     REAL,
  rate_bulk_1cr   REAL,
  rate_staff      REAL,
  min_amount      REAL,
  max_amount      REAL,
  compounding     TEXT    NOT NULL DEFAULT 'quarterly' CHECK(compounding IN ('monthly','quarterly','half_yearly','yearly','simple')),
  effective_from  TEXT    NOT NULL,
  effective_to    TEXT,
  source_url      TEXT,
  verified        INTEGER NOT NULL DEFAULT 0,
  verified_at     TEXT,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fd_rates_bank ON fd_rates(bank_id);
CREATE INDEX IF NOT EXISTS idx_fd_rates_product ON fd_rates(product_type);
CREATE INDEX IF NOT EXISTS idx_fd_rates_effective ON fd_rates(effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_rates_unique ON fd_rates(bank_id, product_type, tenure_days_min, tenure_days_max);

-- ─── RATE HISTORY ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fd_rate_id      INTEGER NOT NULL REFERENCES fd_rates(id),
  bank_id         INTEGER NOT NULL REFERENCES banks(id),
  product_type    TEXT    NOT NULL,
  rate_general    REAL    NOT NULL,
  rate_senior     REAL,
  effective_from  TEXT    NOT NULL,
  effective_to    TEXT,
  change_bps      INTEGER,  -- basis points change from previous
  recorded_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── CLIENT PORTFOLIOS (RIA feature) ─────────────────────────────
CREATE TABLE IF NOT EXISTS client_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_ref      TEXT    NOT NULL,  -- anonymized ref, no PII
  tax_slab_pct    REAL    NOT NULL DEFAULT 30.0,
  is_senior       INTEGER NOT NULL DEFAULT 0,
  is_nri          INTEGER NOT NULL DEFAULT 0,
  inflation_pct   REAL    NOT NULL DEFAULT 4.5,
  risk_profile    TEXT    NOT NULL DEFAULT 'moderate' CHECK(risk_profile IN ('conservative','moderate','aggressive')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, client_ref)
);

-- ─── WATCHLISTS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlists (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  description     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watchlist_banks (
  watchlist_id    INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  bank_id         INTEGER NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  added_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(watchlist_id, bank_id)
);

-- ─── AUDIT LOG ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id),
  action          TEXT    NOT NULL,
  resource        TEXT,
  resource_id     TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── RIA ONBOARDING PROFILE ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS ria_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  sebi_category   TEXT,
  city            TEXT,
  aum_bracket     TEXT,
  client_types    TEXT,   -- JSON array stored as text
  fd_uses         TEXT,   -- JSON array stored as text
  source          TEXT,
  onboarding_done INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── RATE ALERTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_id         INTEGER REFERENCES banks(id),
  category_id     INTEGER REFERENCES bank_categories(id),
  product_type    TEXT    NOT NULL DEFAULT 'domestic',
  threshold_rate  REAL    NOT NULL,
  direction       TEXT    NOT NULL DEFAULT 'above' CHECK(direction IN ('above','below')),
  notified_at     TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── EMAIL VERIFICATIONS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_verifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  otp_hash    TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  verified_at TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);

-- ─── USER FEEDBACK ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT    NOT NULL DEFAULT 'general' CHECK(category IN ('bug','feature','general')),
  message     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
