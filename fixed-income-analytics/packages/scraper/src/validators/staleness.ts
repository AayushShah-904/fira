/**
 * Layer 7: Staleness validation.
 * Checks if a bank's data hasn't been updated in too long.
 * Runs on a schedule (not during import).
 */
import type { ValidationResult, ValidationFlag } from "./types.js";

const STALE_THRESHOLD_DAYS = 60;
const WARNING_THRESHOLD_DAYS = 30;

export function validateStaleness(
  lastScrapedAt: string | null,
  bankCode: string,
): ValidationResult {
  const flags: ValidationFlag[] = [];

  if (!lastScrapedAt) {
    flags.push({
      flag_type: "staleness",
      severity: "warning",
      details: JSON.stringify({
        message: `Bank ${bankCode} has never been scraped`,
        bank_code: bankCode,
      }),
    });
    return { passed: true, flags };
  }

  const lastDate = new Date(lastScrapedAt);
  const now = new Date();
  const daysSince = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

  if (daysSince >= STALE_THRESHOLD_DAYS) {
    flags.push({
      flag_type: "staleness",
      severity: "critical",
      details: JSON.stringify({
        message: `Data is ${daysSince} days old (threshold: ${STALE_THRESHOLD_DAYS} days)`,
        bank_code: bankCode,
        last_scraped: lastScrapedAt,
        days_since: daysSince,
      }),
    });
  } else if (daysSince >= WARNING_THRESHOLD_DAYS) {
    flags.push({
      flag_type: "staleness",
      severity: "warning",
      details: JSON.stringify({
        message: `Data is ${daysSince} days old (warning at ${WARNING_THRESHOLD_DAYS} days)`,
        bank_code: bankCode,
        last_scraped: lastScrapedAt,
        days_since: daysSince,
      }),
    });
  }

  return { passed: !flags.some(f => f.severity === "critical"), flags };
}
