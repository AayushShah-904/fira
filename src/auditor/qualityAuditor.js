import { ANOMALY_RULES, AUDIT_SEVERITY } from '../config/constants.js';
import { differenceInDays, parseISO } from 'date-fns';

/**
 * Evaluates normalized rate slabs against domain validation rules.
 */
export function auditRateSlab(slab) {
  const issues = [];

  // VAL-01: Rate Upper Bound Check
  if (slab.rate_general_pct > ANOMALY_RULES.VAL_01_RATE_UPPER_BOUND.limit ||
      (slab.rate_senior_pct && slab.rate_senior_pct > 10.50)) {
    issues.push({
      bank_id: slab.bank_id,
      slab_id: slab.id || null,
      issue_type: ANOMALY_RULES.VAL_01_RATE_UPPER_BOUND.id,
      severity: AUDIT_SEVERITY.CRITICAL,
      details: `General rate (${slab.rate_general_pct}%) or Senior rate (${slab.rate_senior_pct}%) exceeds realistic maximum threshold of 10.0%`
    });
  }

  // VAL-02: Rate Lower Bound Check
  if (slab.rate_general_pct < ANOMALY_RULES.VAL_02_RATE_LOWER_BOUND.limit) {
    issues.push({
      bank_id: slab.bank_id,
      slab_id: slab.id || null,
      issue_type: ANOMALY_RULES.VAL_02_RATE_LOWER_BOUND.id,
      severity: AUDIT_SEVERITY.CRITICAL,
      details: `General rate (${slab.rate_general_pct}%) is below minimum realistic floor of 2.50%`
    });
  }

  // VAL-03: Inverted Tenure Range Check
  if (slab.tenure_days_min > slab.tenure_days_max) {
    issues.push({
      bank_id: slab.bank_id,
      slab_id: slab.id || null,
      issue_type: ANOMALY_RULES.VAL_03_INVERTED_TENURE.id,
      severity: AUDIT_SEVERITY.CRITICAL,
      details: `Inverted tenure range detected: tenure_days_min (${slab.tenure_days_min}) > tenure_days_max (${slab.tenure_days_max})`
    });
  }

  // VAL-04: Senior Citizen Rate Lower Than General Check
  if (slab.rate_senior_pct && slab.rate_senior_pct < slab.rate_general_pct) {
    issues.push({
      bank_id: slab.bank_id,
      slab_id: slab.id || null,
      issue_type: ANOMALY_RULES.VAL_04_SENIOR_LOWER_THAN_GENERAL.id,
      severity: AUDIT_SEVERITY.CRITICAL,
      details: `Senior citizen rate (${slab.rate_senior_pct}%) is lower than general rate (${slab.rate_general_pct}%)`
    });
  }

  // VAL-05: Unusually High Senior Citizen Spread Check
  if (slab.rate_senior_pct && (slab.rate_senior_pct - slab.rate_general_pct) > ANOMALY_RULES.VAL_05_HIGH_SENIOR_SPREAD.maxSpread) {
    issues.push({
      bank_id: slab.bank_id,
      slab_id: slab.id || null,
      issue_type: ANOMALY_RULES.VAL_05_HIGH_SENIOR_SPREAD.id,
      severity: AUDIT_SEVERITY.WARNING,
      details: `Senior rate spread (${(slab.rate_senior_pct - slab.rate_general_pct).toFixed(2)}%) exceeds standard spread threshold of 1.25%`
    });
  }

  // VAL-06: Stale Effective Date Check
  if (slab.effective_date) {
    try {
      const daysOld = Math.abs(differenceInDays(new Date(), parseISO(slab.effective_date)));
      if (daysOld > ANOMALY_RULES.VAL_06_STALE_PUBLICATION.maxDaysOld) {
        issues.push({
          bank_id: slab.bank_id,
          slab_id: slab.id || null,
          issue_type: ANOMALY_RULES.VAL_06_STALE_PUBLICATION.id,
          severity: AUDIT_SEVERITY.WARNING,
          details: `Effective rate date (${slab.effective_date}) is older than 180 days (${daysOld} days old)`
        });
      }
    } catch {
      // Ignore date parsing error here
    }
  }

  return issues;
}

export default auditRateSlab;
