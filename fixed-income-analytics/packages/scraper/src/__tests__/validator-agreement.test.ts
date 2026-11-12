/**
 * Integration test — agent ↔ scraper validator agreement.
 *
 * Sprint 003 #2b deliverable: after ADR-014 consolidated rate-bounds and
 * delta-thresholds into `@bird/shared/validation`, both the agent-side
 * `scripts/utils/validate-rates.js` (CJS twin via validation-constants) and
 * the scraper-side `validators/range.ts` + `validators/delta.ts` (TS adapters)
 * should agree on severity for the same input.
 *
 * These tests assert that agreement directly: for each synthetic slab
 * designed to trigger a specific rule, the agent's validateSlabs and the
 * scraper's validateImport produce matching severity assignments.
 *
 * If a test fails, the shared module's constants and the per-side adapters
 * have drifted; per ADR-014 the shared module wins.
 */

import { describe, test, expect } from "vitest";
import { validateImport, type RawSlab } from "../validators/index.js";
import { createRequire } from "node:module";

// Pull in the agent's CJS validator from the sibling rate-discovery-agent workspace.
const requireFromHere = createRequire(import.meta.url);
const agentValidateRates = requireFromHere(
  "../../../../rate-discovery-agent/scripts/utils/validate-rates.js",
) as {
  validateSlabs: (slabs: RawSlab[], variant?: string) => { valid: boolean; warnings: string[]; errors: string[] };
};

const ctxRegular = {
  productType: "FD",
  variant: "regular" as const,
  activeSlabs: [],
  expectedSlabCount: null,
};

function validSlab(over: Partial<RawSlab> = {}): RawSlab {
  return {
    tenure_text: "7 days to 14 days",
    tenure_min_days: 7,
    tenure_max_days: 14,
    rate_general_pct: 3.5,
    rate_senior_pct: 4.0,
    rate_super_senior_pct: null,
    ...over,
  };
}

describe("agent ↔ scraper validator agreement on the same input", () => {
  test("happy slab (regular FD, mid-range rates) — both produce no criticals", () => {
    const slabs = [validSlab()];
    const scraperResult = validateImport(slabs, ctxRegular);
    const agentResult = agentValidateRates.validateSlabs(slabs, "regular");
    expect(scraperResult.criticalCount).toBe(0);
    expect(agentResult.errors).toHaveLength(0);
  });

  test("tenure_min > tenure_max — both flag a critical/error", () => {
    const slabs = [validSlab({ tenure_min_days: 30, tenure_max_days: 7 })];
    const scraperResult = validateImport(slabs, ctxRegular);
    const agentResult = agentValidateRates.validateSlabs(slabs, "regular");
    expect(scraperResult.criticalCount).toBeGreaterThan(0);
    expect(agentResult.errors.length).toBeGreaterThan(0);
  });

  test("rate above max but within max+CRITICAL_OVERSHOOT (10.5%) — scraper warning, agent warning", () => {
    const slabs = [validSlab({ rate_general_pct: 10.5 })];
    const scraperResult = validateImport(slabs, ctxRegular);
    const agentResult = agentValidateRates.validateSlabs(slabs, "regular");
    expect(scraperResult.criticalCount).toBe(0);
    expect(scraperResult.warningCount).toBeGreaterThan(0);
    // Agent records all rate-bound issues as warnings (no critical for in-bound-band overshoots)
    expect(agentResult.warnings.some((w) => w.includes("9.5"))).toBe(true);
  });

  test("rate above max + CRITICAL_OVERSHOOT (12%) — scraper critical, agent warning (agent doesn't critical on range)", () => {
    const slabs = [validSlab({ rate_general_pct: 12.0 })];
    const scraperResult = validateImport(slabs, ctxRegular);
    const agentResult = agentValidateRates.validateSlabs(slabs, "regular");
    // Scraper escalates to critical when rate > max + 2
    expect(scraperResult.criticalCount).toBeGreaterThan(0);
    // Agent's validateSlabs records out-of-range as warning only (no critical class for this)
    // This documents the asymmetry: the scraper has a harder block than the agent's pre-write gate.
    expect(agentResult.warnings.some((w) => w.includes("12"))).toBe(true);
  });

  test("rate below min (1.0%) — both produce warnings, no criticals", () => {
    const slabs = [validSlab({ rate_general_pct: 1.0 })];
    const scraperResult = validateImport(slabs, ctxRegular);
    const agentResult = agentValidateRates.validateSlabs(slabs, "regular");
    expect(scraperResult.criticalCount).toBe(0);
    expect(scraperResult.warningCount).toBeGreaterThan(0);
    expect(agentResult.warnings.length).toBeGreaterThan(0);
  });

  test("rate in the [1.5, 2.5] band (PSB 7-day pattern) — both pass clean (ADR-014 floor reconciliation)", () => {
    // This is the case that produces the 22-warning drop after ADR-014. Confirms the
    // consolidated floor of 1.5% is in effect on both sides.
    const slabs = [validSlab({ rate_general_pct: 2.0 })];
    const scraperResult = validateImport(slabs, ctxRegular);
    const agentResult = agentValidateRates.validateSlabs(slabs, "regular");
    expect(scraperResult.criticalCount).toBe(0);
    expect(agentResult.errors).toHaveLength(0);
    // Should NOT produce a "below floor" warning for 2.0%
    expect(scraperResult.flags.find((f) => f.flag_type === "range" && f.details.includes("below"))).toBeUndefined();
    expect(agentResult.warnings.find((w) => w.includes("below floor"))).toBeUndefined();
  });

  test("senior < general — both warn", () => {
    const slabs = [validSlab({ rate_general_pct: 7.0, rate_senior_pct: 6.5 })];
    const scraperResult = validateImport(slabs, ctxRegular);
    const agentResult = agentValidateRates.validateSlabs(slabs, "regular");
    expect(scraperResult.warningCount).toBeGreaterThan(0);
    expect(agentResult.warnings.some((w) => w.toLowerCase().includes("senior"))).toBe(true);
  });

  test("super-senior at +1.5% over max (11.0%) — both accept (ADR-014 SUPER_SENIOR_PREMIUM reconciliation)", () => {
    // SUPER_SENIOR_PREMIUM = 1.5; max + 1.5 = 11.0. A super-senior rate AT the ceiling should NOT warn.
    const slabs = [validSlab({ rate_general_pct: 7.0, rate_senior_pct: 7.5, rate_super_senior_pct: 11.0 })];
    const scraperResult = validateImport(slabs, ctxRegular);
    const agentResult = agentValidateRates.validateSlabs(slabs, "regular");
    expect(scraperResult.criticalCount).toBe(0);
    // No "super-senior outside" warning for a value at the ceiling
    expect(scraperResult.flags.find((f) => f.flag_type === "range" && f.details.includes("super_senior") && f.details.includes("outside"))).toBeUndefined();
    expect(agentResult.warnings.find((w) => w.toLowerCase().includes("super_senior") && w.includes("11"))).toBeUndefined();
  });

  test("FCNR variant uses foreign-currency bounds (0.5-8.0%) — 4.5% USD passes", () => {
    const slabs = [
      {
        tenure_text: "1 year to 2 years",
        tenure_min_days: 365,
        tenure_max_days: 730,
        rate_general_pct: 4.5,
        rate_senior_pct: null,
        rate_super_senior_pct: null,
        currency: "USD",
      },
    ];
    const scraperResult = validateImport(slabs, { ...ctxRegular, variant: "fcnr" });
    const agentResult = agentValidateRates.validateSlabs(slabs, "fcnr");
    expect(scraperResult.criticalCount).toBe(0);
    expect(agentResult.errors).toHaveLength(0);
    // Should not produce a "below floor" warning for 4.5% in fcnr context
    expect(scraperResult.flags.find((f) => f.flag_type === "range" && f.details.includes("below"))).toBeUndefined();
  });

  test("FCNR variant: 9% rate is above max (8.0%) — both flag", () => {
    const slabs = [
      {
        tenure_text: "1 year to 2 years",
        tenure_min_days: 365,
        tenure_max_days: 730,
        rate_general_pct: 9.0,
        rate_senior_pct: null,
        rate_super_senior_pct: null,
        currency: "USD",
      },
    ];
    const scraperResult = validateImport(slabs, { ...ctxRegular, variant: "fcnr" });
    const agentResult = agentValidateRates.validateSlabs(slabs, "fcnr");
    expect(scraperResult.warningCount).toBeGreaterThan(0);
    expect(agentResult.warnings.some((w) => w.includes("9") || w.toLowerCase().includes("ceiling") || w.toLowerCase().includes("above"))).toBe(true);
  });
});

describe("delta threshold agreement (ADR-014 getDeltaThreshold)", () => {
  test("PSB-category delta uses 50 bps default; 60 bps movement produces warning", () => {
    const active = [
      {
        id: 1,
        tenure_text: "1 year",
        tenure_min_days: 365,
        tenure_max_days: 365,
        rate_general_pct: 7.0,
        rate_senior_pct: 7.5,
        rate_super_senior_pct: null,
        currency: null,
      },
    ];
    const slabs = [
      {
        tenure_text: "1 year",
        tenure_min_days: 365,
        tenure_max_days: 365,
        rate_general_pct: 7.6, // +60 bps from 7.0
        rate_senior_pct: 8.1,
        rate_super_senior_pct: null,
      },
    ];
    const scraperResult = validateImport(slabs, {
      ...ctxRegular,
      activeSlabs: active,
      bankCategory: "PSB",
    });
    expect(scraperResult.flags.find((f) => f.flag_type === "delta" && f.severity === "warning")).toBeDefined();
    expect(scraperResult.criticalCount).toBe(0);
  });

  test("SFB-category delta uses 75 bps threshold; 60 bps movement does NOT warn", () => {
    const active = [
      {
        id: 1,
        tenure_text: "1 year",
        tenure_min_days: 365,
        tenure_max_days: 365,
        rate_general_pct: 7.0,
        rate_senior_pct: 7.5,
        rate_super_senior_pct: null,
        currency: null,
      },
    ];
    const slabs = [
      {
        tenure_text: "1 year",
        tenure_min_days: 365,
        tenure_max_days: 365,
        rate_general_pct: 7.6,
        rate_senior_pct: 8.1,
        rate_super_senior_pct: null,
      },
    ];
    const scraperResult = validateImport(slabs, {
      ...ctxRegular,
      activeSlabs: active,
      bankCategory: "SFB",
    });
    expect(scraperResult.flags.find((f) => f.flag_type === "delta")).toBeUndefined();
  });

  test("PSB-category critical at 110 bps (2× threshold)", () => {
    const active = [
      {
        id: 1,
        tenure_text: "1 year",
        tenure_min_days: 365,
        tenure_max_days: 365,
        rate_general_pct: 7.0,
        rate_senior_pct: 7.5,
        rate_super_senior_pct: null,
        currency: null,
      },
    ];
    const slabs = [
      {
        tenure_text: "1 year",
        tenure_min_days: 365,
        tenure_max_days: 365,
        rate_general_pct: 8.2, // +120 bps
        rate_senior_pct: 8.7,
        rate_super_senior_pct: null,
      },
    ];
    const scraperResult = validateImport(slabs, {
      ...ctxRegular,
      activeSlabs: active,
      bankCategory: "PSB",
    });
    expect(scraperResult.criticalCount).toBeGreaterThan(0);
    expect(scraperResult.flags.find((f) => f.flag_type === "delta" && f.severity === "critical")).toBeDefined();
  });
});

describe("shared constants exposure", () => {
  test("scraper's range validator picks up SUPER_SENIOR_PREMIUM = 1.5 from shared", async () => {
    // Indirect: a super-senior rate at max+1.5 should pass; at max+1.6 should warn.
    const passSlabs = [validSlab({ rate_general_pct: 7.0, rate_senior_pct: 8.0, rate_super_senior_pct: 11.0 })];
    const warnSlabs = [validSlab({ rate_general_pct: 7.0, rate_senior_pct: 8.0, rate_super_senior_pct: 11.1 })];
    const passResult = validateImport(passSlabs, ctxRegular);
    const warnResult = validateImport(warnSlabs, ctxRegular);
    const passSuperFlag = passResult.flags.find((f) => f.flag_type === "range" && f.details.includes("super_senior") && f.details.includes("outside"));
    const warnSuperFlag = warnResult.flags.find((f) => f.flag_type === "range" && f.details.includes("super_senior") && f.details.includes("outside"));
    expect(passSuperFlag).toBeUndefined();
    expect(warnSuperFlag).toBeDefined();
  });
});
