/**
 * Normalizes tenure string inputs into integer min and max days.
 * Examples:
 * - "7 days to 14 days" => { min: 7, max: 14 }
 * - "1 Year to < 2 Years" => { min: 365, max: 729 }
 * - "18 Months to 24 Months" => { min: 548, max: 730 }
 * - "3 Years to 5 Years" => { min: 1095, max: 1825 }
 * - "Above 5 years up to 10 years" => { min: 1826, max: 3650 }
 */

export function parseTenureToDays(rawTenure) {
  if (!rawTenure || typeof rawTenure !== 'string') {
    return { min: 0, max: 0, valid: false };
  }

  const clean = rawTenure.trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/upto/g, 'up to')
    .replace(/less than/g, '<')
    .replace(/yrs/g, 'years')
    .replace(/yr/g, 'year')
    .replace(/mths/g, 'months')
    .replace(/mth/g, 'month')
    .replace(/dys/g, 'days')
    .replace(/dy/g, 'day');

  // Helper conversions
  const unitToDays = (val, unit) => {
    const num = parseFloat(val);
    if (isNaN(num)) return 0;
    if (unit.startsWith('year')) return Math.round(num * 365);
    if (unit.startsWith('month')) return Math.round(num * 30.416);
    if (unit.startsWith('day')) return Math.round(num);
    return Math.round(num);
  };

  // Pattern 1: Range X [unit] to Y [unit] or X to < Y [unit]
  // e.g., "7 days to 14 days", "1 year to < 2 years", "18 months to 24 months"
  const rangeRegex = /(\d+(?:\.\d+)?)\s*(days?|months?|years?|\b)?\s*(?:to|-|<|up to)\s*<?\s*(\d+(?:\.\d+)?)\s*(days?|months?|years?)/i;
  const matchRange = clean.match(rangeRegex);
  if (matchRange) {
    let [, val1, unit1, val2, unit2] = matchRange;
    if (!unit1) unit1 = unit2; // Inherit unit if omitted in first operand
    let minDays = unitToDays(val1, unit1);
    let maxDays = unitToDays(val2, unit2);

    if (clean.includes('<') || clean.includes('less than')) {
      maxDays = Math.max(minDays, maxDays - 1);
    }

    return {
      min: minDays,
      max: maxDays,
      valid: minDays > 0 && maxDays >= minDays
    };
  }

  // Pattern 2: Single tenure e.g. "1 year", "444 days", "10 years"
  const singleRegex = /(\d+(?:\.\d+)?)\s*(days?|months?|years?)/i;
  const matchSingle = clean.match(singleRegex);
  if (matchSingle) {
    const [, val, unit] = matchSingle;
    const days = unitToDays(val, unit);
    return {
      min: days,
      max: days,
      valid: days > 0
    };
  }

  // Fallback heuristic for number extractions
  const numbers = clean.match(/\d+(?:\.\d+)?/g);
  if (numbers && numbers.length >= 2) {
    const min = parseInt(numbers[0], 10);
    const max = parseInt(numbers[1], 10);
    return { min, max, valid: min > 0 && max >= min };
  } else if (numbers && numbers.length === 1) {
    const val = parseInt(numbers[0], 10);
    return { min: val, max: val, valid: val > 0 };
  }

  return { min: 0, max: 0, valid: false };
}

export default parseTenureToDays;
