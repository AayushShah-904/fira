/**
 * Sanitizes percentage strings and converts them to floats.
 * Handles format variations: "6.80%", "7.30% p.a.", "7.50%*", "6.80 p.a.", "7.25 %"
 */

export function parseRate(rawRate) {
  if (rawRate === null || rawRate === undefined) return null;
  if (typeof rawRate === 'number') {
    return isNaN(rawRate) ? null : parseFloat(rawRate.toFixed(2));
  }

  const clean = String(rawRate)
    .replace(/[^\d.]/g, ' ')
    .trim();

  const matches = clean.match(/\d+(?:\.\d+)?/);
  if (!matches) return null;

  const rate = parseFloat(matches[0]);
  if (isNaN(rate) || rate <= 0 || rate > 100) return null;

  return parseFloat(rate.toFixed(2));
}

export default parseRate;
