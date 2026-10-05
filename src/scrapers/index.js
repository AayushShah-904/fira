import scrapeHtmlBank from './htmlScraper.js';
import scrapeOfflineBank from './offlineScraper.js';
import normalizeRateRecord from '../normalizer/index.js';
import classifyScrapeError from '../auditor/errorAnalysis.js';
import auditRateSlab from '../auditor/qualityAuditor.js';
import Repository from '../database/repository.js';
import { SCRAPE_STATUS } from '../config/constants.js';

export async function scrapeAndIngestBank(bank, forceOffline = false) {
  const startTime = Date.now();
  let status = SCRAPE_STATUS.SUCCESS;
  let recordsExtracted = 0;
  let errorMessage = null;
  let statusCode = 200;

  try {
    let result;
    if (forceOffline) {
      result = scrapeOfflineBank(bank.id);
    } else {
      try {
        result = await scrapeHtmlBank(bank.fd_rates_url);
      } catch (networkErr) {
        // Fallback to offline fixture if live network fails
        console.warn(`[SCRAPER] Live scrape failed for ${bank.name} (${networkErr.message}). Falling back to offline fixture.`);
        result = scrapeOfflineBank(bank.id);
        status = SCRAPE_STATUS.OFFLINE_FALLBACK;
      }
    }

    statusCode = result.statusCode || 200;
    const rawRows = result.rows || [];

    if (rawRows.length === 0) {
      const diag = classifyScrapeError(null, statusCode, '');
      status = diag.status;
      errorMessage = diag.message;
    } else {
      for (const raw of rawRows) {
        const norm = normalizeRateRecord(raw, bank.id, 'DOMESTIC_FD', bank.fd_rates_url);
        if (norm.valid) {
          const slabId = Repository.upsertRateSlab(norm.data);
          recordsExtracted++;

          // Audit Quality Check
          const auditIssues = auditRateSlab({ id: slabId, ...norm.data });
          for (const issue of auditIssues) {
            Repository.insertAuditIssue(issue);
          }
        }
      }
    }
  } catch (err) {
    const diag = classifyScrapeError(err, statusCode, '');
    status = diag.status;
    errorMessage = diag.message;
  }

  const durationMs = Date.now() - startTime;
  Repository.logScrapeExecution({
    bank_id: bank.id,
    scraper_strategy: forceOffline ? 'OFFLINE_FIXTURE' : bank.scraper_strategy,
    status,
    http_status_code: statusCode,
    records_extracted: recordsExtracted,
    error_message: errorMessage,
    duration_ms: durationMs
  });

  return { bank_id: bank.id, status, recordsExtracted, durationMs };
}

export async function scrapeAllBanks(forceOffline = false) {
  const banks = Repository.getAllBanks();
  const results = [];
  for (const bank of banks) {
    const res = await scrapeAndIngestBank(bank, forceOffline);
    results.push(res);
  }
  return results;
}
