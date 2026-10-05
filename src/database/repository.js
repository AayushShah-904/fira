import getDatabase from '../config/database.js';

export const Repository = {
  // Banks
  getAllBanks() {
    const db = getDatabase();
    return db.prepare(`SELECT * FROM banks ORDER BY name ASC`).all();
  },

  getBankById(id) {
    const db = getDatabase();
    return db.prepare(`SELECT * FROM banks WHERE id = ?`).get(id);
  },

  upsertBank(bank) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO banks (id, name, category, website_url, fd_rates_url, scraper_strategy, logo_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        website_url = excluded.website_url,
        fd_rates_url = excluded.fd_rates_url,
        scraper_strategy = excluded.scraper_strategy,
        logo_url = excluded.logo_url,
        is_active = excluded.is_active;
    `);
    stmt.run(
      bank.id,
      bank.name,
      bank.category,
      bank.website_url,
      bank.fd_rates_url,
      bank.scraper_strategy,
      bank.logo_url || '',
      bank.is_active !== undefined ? bank.is_active : 1
    );
  },

  // Rate Slabs
  upsertRateSlab(slab) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO rate_slabs (
        bank_id, product_type, tenure_raw, tenure_days_min, tenure_days_max,
        rate_general_pct, rate_senior_pct, effective_date, source_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bank_id, product_type, tenure_days_min, tenure_days_max, effective_date)
      DO UPDATE SET
        rate_general_pct = excluded.rate_general_pct,
        rate_senior_pct = excluded.rate_senior_pct,
        extracted_at = CURRENT_TIMESTAMP,
        source_url = excluded.source_url;
    `);
    const result = stmt.run(
      slab.bank_id,
      slab.product_type,
      slab.tenure_raw,
      slab.tenure_days_min,
      slab.tenure_days_max,
      slab.rate_general_pct,
      slab.rate_senior_pct,
      slab.effective_date,
      slab.source_url
    );
    return result.lastInsertRowid;
  },

  getAllRateSlabs(filters = {}) {
    const db = getDatabase();
    let sql = `
      SELECT r.*, b.name as bank_name, b.category as bank_category, b.logo_url as bank_logo
      FROM rate_slabs r
      JOIN banks b ON r.bank_id = b.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.bank_id) {
      sql += ` AND r.bank_id = ?`;
      params.push(filters.bank_id);
    }
    if (filters.category) {
      sql += ` AND b.category = ?`;
      params.push(filters.category);
    }
    if (filters.product_type) {
      sql += ` AND r.product_type = ?`;
      params.push(filters.product_type);
    }
    if (filters.tenure_days) {
      const days = parseInt(filters.tenure_days, 10);
      sql += ` AND r.tenure_days_min <= ? AND r.tenure_days_max >= ?`;
      params.push(days, days);
    }

    if (filters.sort === 'rate_desc') {
      sql += ` ORDER BY r.rate_general_pct DESC`;
    } else if (filters.sort === 'rate_senior_desc') {
      sql += ` ORDER BY r.rate_senior_pct DESC`;
    } else if (filters.sort === 'tenure_asc') {
      sql += ` ORDER BY r.tenure_days_min ASC`;
    } else {
      sql += ` ORDER BY b.name ASC, r.tenure_days_min ASC`;
    }

    return db.prepare(sql).all(...params);
  },

  getHighestRatesByStandardTenures() {
    const db = getDatabase();
    const tenures = [
      { name: '7 Days', days: 7 },
      { name: '1 Year', days: 365 },
      { name: '3 Years', days: 1095 },
      { name: '5 Years', days: 1825 }
    ];

    const results = {};
    for (const t of tenures) {
      const sql = `
        SELECT r.*, b.name as bank_name, b.category as bank_category, b.logo_url as bank_logo
        FROM rate_slabs r
        JOIN banks b ON r.bank_id = b.id
        WHERE r.tenure_days_min <= ? AND r.tenure_days_max >= ?
        ORDER BY r.rate_general_pct DESC
        LIMIT 5;
      `;
      results[t.name] = db.prepare(sql).all(t.days, t.days);
    }
    return results;
  },

  // Scrape Logs
  logScrapeExecution(log) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO scrape_logs (bank_id, scraper_strategy, status, http_status_code, records_extracted, error_message, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      log.bank_id,
      log.scraper_strategy,
      log.status,
      log.http_status_code || null,
      log.records_extracted || 0,
      log.error_message || null,
      log.duration_ms || 0
    );
  },

  getRecentScrapeLogs(limit = 50) {
    const db = getDatabase();
    return db.prepare(`
      SELECT l.*, b.name as bank_name
      FROM scrape_logs l
      JOIN banks b ON l.bank_id = b.id
      ORDER BY l.executed_at DESC
      LIMIT ?
    `).all(limit);
  },

  // Audit Issues
  insertAuditIssue(issue) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO audit_issues (bank_id, slab_id, issue_type, severity, details)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      issue.bank_id,
      issue.slab_id || null,
      issue.issue_type,
      issue.severity,
      issue.details
    );
  },

  getAuditSummary() {
    const db = getDatabase();
    const issues = db.prepare(`
      SELECT a.*, b.name as bank_name
      FROM audit_issues a
      JOIN banks b ON a.bank_id = b.id
      ORDER BY a.detected_at DESC
      LIMIT 100
    `).all();

    const logs = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM scrape_logs
      GROUP BY status
    `).all();

    const totalSlabs = db.prepare(`SELECT COUNT(*) as count FROM rate_slabs`).get().count;
    const totalBanks = db.prepare(`SELECT COUNT(*) as count FROM banks`).get().count;

    return {
      totalBanks,
      totalSlabs,
      scrapeStatusBreakdown: logs,
      recentIssues: issues
    };
  },

  clearAuditIssues() {
    const db = getDatabase();
    db.prepare(`DELETE FROM audit_issues`).run();
  }
};

export default Repository;
