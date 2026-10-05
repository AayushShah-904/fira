import { SCRAPE_STATUS } from '../config/constants.js';

/**
 * Classifies scrape errors into diagnostic categories for pipeline health monitoring.
 */
export function classifyScrapeError(error, statusCode, responseBody = '') {
  if (statusCode === 403 || statusCode === 429 || (responseBody && /cloudflare|captcha|access denied|block/i.test(responseBody))) {
    return {
      status: SCRAPE_STATUS.WAF_BLOCKED,
      message: 'Blocked by Cloudflare/WAF anti-scraping challenge or rate limit'
    };
  }

  if (statusCode >= 400) {
    return {
      status: SCRAPE_STATUS.HTTP_ERROR,
      message: `HTTP Error Response ${statusCode}`
    };
  }

  if (error && error.message && /timeout|econnrefused|enotfound/i.test(error.message)) {
    return {
      status: SCRAPE_STATUS.HTTP_ERROR,
      message: `Network Connectivity Timeout / Error: ${error.message}`
    };
  }

  if (responseBody && responseBody.length < 500 && !responseBody.includes('<table')) {
    return {
      status: SCRAPE_STATUS.EMPTY_DATA,
      message: 'Scraped DOM returned empty payload or structural table missing'
    };
  }

  return {
    status: SCRAPE_STATUS.PARSE_FAILED,
    message: error ? error.message : 'DOM Selector parse failure or empty table extract'
  };
}

export default classifyScrapeError;
