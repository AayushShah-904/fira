import { parse, format, isValid } from 'date-fns';

/**
 * Normalizes input dates into ISO 8601 (YYYY-MM-DD) format.
 * Supports: "15-06-2026", "15/06/2026", "2026-06-15", "15th June 2026", "June 15, 2026"
 */

export function parseEffectiveDate(rawDate) {
  if (!rawDate) return format(new Date(), 'yyyy-MM-dd');
  const str = String(rawDate).trim().replace(/(st|nd|rd|th)/gi, '');

  const formats = [
    'yyyy-MM-dd',
    'dd-MM-yyyy',
    'dd/MM/yyyy',
    'dd MMMM yyyy',
    'MMMM dd, yyyy',
    'dd MMM yyyy'
  ];

  for (const fmt of formats) {
    try {
      const parsed = parse(str, fmt, new Date());
      if (isValid(parsed)) {
        return format(parsed, 'yyyy-MM-dd');
      }
    } catch {
      // Continue trying next format
    }
  }

  // Fallback regex match for YYYY-MM-DD
  const isoMatch = str.match(/\d{4}-\d{2}-\d{2}/);
  if (isoMatch) return isoMatch[0];

  return format(new Date(), 'yyyy-MM-dd');
}

export default parseEffectiveDate;
