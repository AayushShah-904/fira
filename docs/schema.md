# FIRA Database Schema

This document outlines the SQLite database schema used by the Fixed Income Rate Analytics (FIRA) application.

## Core Tables

### 1. `users` & Authentication
```sql
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

CREATE TABLE IF NOT EXISTS permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role          TEXT    NOT NULL,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_id)
);
```

### 2. `banks` & `bank_categories`
```sql
CREATE TABLE IF NOT EXISTS bank_categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  description  TEXT,
  regulator    TEXT,
  dicgc_covered INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

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
```

### 3. `fd_rates` & History
```sql
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

CREATE TABLE IF NOT EXISTS rate_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fd_rate_id      INTEGER NOT NULL REFERENCES fd_rates(id),
  bank_id         INTEGER NOT NULL REFERENCES banks(id),
  product_type    TEXT    NOT NULL,
  rate_general    REAL    NOT NULL,
  rate_senior     REAL,
  effective_from  TEXT    NOT NULL,
  effective_to    TEXT,
  change_bps      INTEGER,  
  recorded_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### 4. Advanced Features (RIA Tools)
```sql
CREATE TABLE IF NOT EXISTS client_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_ref      TEXT    NOT NULL, 
  tax_slab_pct    REAL    NOT NULL DEFAULT 30.0,
  is_senior       INTEGER NOT NULL DEFAULT 0,
  is_nri          INTEGER NOT NULL DEFAULT 0,
  inflation_pct   REAL    NOT NULL DEFAULT 4.5,
  risk_profile    TEXT    NOT NULL DEFAULT 'moderate' CHECK(risk_profile IN ('conservative','moderate','aggressive')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, client_ref)
);

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
```

### 5. Settings, Logs, Alerts, Feedback
```sql
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

CREATE TABLE IF NOT EXISTS email_verifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  otp_hash    TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  verified_at TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT    NOT NULL DEFAULT 'general' CHECK(category IN ('bug','feature','general')),
  message     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### 6. Initial Seed Data (Admin User)
```sql
-- NOTE: In production, ensure 'admin123!' is properly hashed (e.g., bcrypt/argon2) before inserting
INSERT INTO users (email, password_hash, name, role, plan, is_active, email_verified) 
VALUES (
  'admin@fira.in', 
  '$2b$12$someBcryptHashForAdmin123!', -- Replace with actual hash of 'admin123!'
  'FIRA Admin', 
  'admin', 
  'enterprise', 
  1, 
  1
);

-- Define specific permissions (Pro features & beyond)
INSERT INTO permissions (name, description) VALUES 
  ('*', 'All access (Superadmin)'),
  ('view_all_banks', 'All banks across 8 categories including Co-op, DCCBs, IBUs'),
  ('view_nri_rates', 'NRE / NRO / FCNR / IBU rate data'),
  ('manage_watchlists', 'Watchlists (up to 10)'),
  ('view_credit_ratings', 'Credit ratings (CRISIL / ICRA)'),
  ('api_access', 'REST API access'),
  ('unlimited_comparison', 'Unlimited rate comparison'),
  ('manage_client_profiles', 'Client profiles'),
  ('view_senior_rates', 'Senior citizen rates'),
  ('export_csv', 'CSV export');

-- Give 'admin' role all access to every permission listed above
INSERT INTO role_permissions (role, permission_id) 
SELECT 'admin', id FROM permissions;
```
