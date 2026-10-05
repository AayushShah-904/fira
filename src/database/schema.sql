-- 1. Banks Registry Table
CREATE TABLE IF NOT EXISTS banks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    website_url TEXT NOT NULL,
    fd_rates_url TEXT NOT NULL,
    scraper_strategy TEXT NOT NULL,
    logo_url TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Normalized Fixed Deposit Rate Slabs
CREATE TABLE IF NOT EXISTS rate_slabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id TEXT NOT NULL,
    product_type TEXT NOT NULL,
    tenure_raw TEXT NOT NULL,
    tenure_days_min INTEGER NOT NULL,
    tenure_days_max INTEGER NOT NULL,
    rate_general_pct REAL NOT NULL,
    rate_senior_pct REAL,
    effective_date TEXT NOT NULL,
    extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    source_url TEXT NOT NULL,
    FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE,
    UNIQUE(bank_id, product_type, tenure_days_min, tenure_days_max, effective_date)
);

-- 3. Scraper Execution & Failure Diagnostic Logs
CREATE TABLE IF NOT EXISTS scrape_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id TEXT NOT NULL,
    scraper_strategy TEXT NOT NULL,
    status TEXT NOT NULL,
    http_status_code INTEGER,
    records_extracted INTEGER DEFAULT 0,
    error_message TEXT,
    duration_ms INTEGER,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_id) REFERENCES banks(id)
);

-- 4. Data Quality Audit Findings
CREATE TABLE IF NOT EXISTS audit_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id TEXT NOT NULL,
    slab_id INTEGER,
    issue_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    details TEXT NOT NULL,
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_id) REFERENCES banks(id),
    FOREIGN KEY (slab_id) REFERENCES rate_slabs(id) ON DELETE SET NULL
);

-- Indices for query performance
CREATE INDEX IF NOT EXISTS idx_rate_slabs_lookup ON rate_slabs(bank_id, product_type, tenure_days_min, tenure_days_max);
CREATE INDEX IF NOT EXISTS idx_rate_slabs_sort ON rate_slabs(rate_general_pct DESC, rate_senior_pct DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_logs_bank ON scrape_logs(bank_id, executed_at DESC);
