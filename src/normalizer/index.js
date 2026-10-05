import { parseTenureToDays } from './tenureParser.js';
import { parseRate } from './rateParser.js';
import { parseEffectiveDate } from './dateParser.js';
import { PRODUCT_TYPES } from '../config/constants.js';

/**
 * Normalizes raw scraped rate records into canonical schema format.
 */
export function normalizeRateRecord(raw, bankId, defaultProductType = PRODUCT_TYPES.DOMESTIC_FD, sourceUrl = '') {
  const tenure = parseTenureToDays(raw.tenure || raw.tenure_raw);
  const rateGeneral = parseRate(raw.rate_general || raw.rate_general_pct || raw.rate);
  const rateSenior = parseRate(raw.rate_senior || raw.rate_senior_pct) || (rateGeneral ? parseFloat((rateGeneral + 0.50).toFixed(2)) : null);
  const effectiveDate = parseEffectiveDate(raw.effective_date);

  if (!tenure.valid || rateGeneral === null) {
    return { valid: false, error: 'Invalid tenure or rate payload' };
  }

  return {
    valid: true,
    data: {
      bank_id: bankId,
      product_type: raw.product_type || defaultProductType,
      tenure_raw: raw.tenure || raw.tenure_raw || `${tenure.min} - ${tenure.max} days`,
      tenure_days_min: tenure.min,
      tenure_days_max: tenure.max,
      rate_general_pct: rateGeneral,
      rate_senior_pct: rateSenior,
      effective_date: effectiveDate,
      source_url: sourceUrl || raw.source_url || ''
    }
  };
}

export default normalizeRateRecord;
