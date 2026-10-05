export const PRODUCT_TYPES = {
  DOMESTIC_FD: 'DOMESTIC_FD',
  NRE_FD: 'NRE_FD',
  NRO_FD: 'NRO_FD',
  SENIOR_CITIZEN: 'SENIOR_CITIZEN',
  TAX_SAVER: 'TAX_SAVER'
};

export const BANK_CATEGORIES = {
  PSU: 'PSU',
  PRIVATE: 'PRIVATE',
  SMALL_FINANCE: 'SMALL_FINANCE',
  NBFC: 'NBFC'
};

export const SCRAPER_STRATEGIES = {
  HTML_STATIC: 'HTML_STATIC',
  PLAYWRIGHT_DOM: 'PLAYWRIGHT_DOM',
  PDF_CIRCULAR: 'PDF_CIRCULAR',
  OFFLINE_FIXTURE: 'OFFLINE_FIXTURE'
};

export const SCRAPE_STATUS = {
  SUCCESS: 'SUCCESS',
  WAF_BLOCKED: 'WAF_BLOCKED',
  HTTP_ERROR: 'HTTP_ERROR',
  PARSE_FAILED: 'PARSE_FAILED',
  EMPTY_DATA: 'EMPTY_DATA',
  OFFLINE_FALLBACK: 'OFFLINE_FALLBACK'
};

export const AUDIT_SEVERITY = {
  CRITICAL: 'CRITICAL',
  WARNING: 'WARNING',
  INFO: 'INFO'
};

export const ANOMALY_RULES = {
  VAL_01_RATE_UPPER_BOUND: { id: 'VAL-01', name: 'Rate Upper Bound Exceeded', limit: 10.0 },
  VAL_02_RATE_LOWER_BOUND: { id: 'VAL-02', name: 'Rate Below Minimum Floor', limit: 2.5 },
  VAL_03_INVERTED_TENURE: { id: 'VAL-03', name: 'Inverted Tenure Range' },
  VAL_04_SENIOR_LOWER_THAN_GENERAL: { id: 'VAL-04', name: 'Senior Rate Lower Than General' },
  VAL_05_HIGH_SENIOR_SPREAD: { id: 'VAL-05', name: 'Abnormally High Senior Spread', maxSpread: 1.25 },
  VAL_06_STALE_PUBLICATION: { id: 'VAL-06', name: 'Stale Publication Date', maxDaysOld: 180 }
};
