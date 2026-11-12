import { describe, it, expect } from "vitest";
import {
  bankSchema,
  bankInsertSchema,
  bankQuerySchema,
  productSchema,
  rateSlabSchema,
  scrapeRunSchema,
  scrapeFlagSchema,
  specialSchemeSchema,
} from "../schemas/index.js";
import { parseTenureText } from "../constants/tenure-maps.js";

describe("bankSchema", () => {
  it("validates a complete bank record", () => {
    const bank = {
      id: 1,
      code: "state-bank-of-india",
      name: "State Bank of India",
      category: "PSB",
      state: "Maharashtra",
      website_url: "https://sbi.co.in",
      rate_page_url: "https://sbi.co.in/web/interest-rates/deposit-rates",
      logo_url: null,
      rbi_licence_no: null,
      ifsc_prefix: "SBIN",
      deposit_insurance: true,
      assets_under_mgmt: 6100000, // in crores
      trust_score: 95,
      scraper_status: "active",
      discovery_status: "discovered",
      created_at: "2026-03-27T00:00:00Z",
      updated_at: "2026-03-27T00:00:00Z",
    };
    expect(bankSchema.parse(bank)).toEqual(bank);
  });

  it("rejects invalid category", () => {
    expect(() =>
      bankSchema.parse({
        id: 1,
        code: "test",
        name: "Test",
        category: "INVALID",
        state: null,
        website_url: null,
        rate_page_url: null,
        logo_url: null,
        rbi_licence_no: null,
        ifsc_prefix: null,
        deposit_insurance: false,
        assets_under_mgmt: null,
        trust_score: null,
        scraper_status: "pending",
        discovery_status: "pending",
        created_at: "2026-03-27T00:00:00Z",
        updated_at: "2026-03-27T00:00:00Z",
      }),
    ).toThrow();
  });

  it("defaults deposit_insurance to false", () => {
    const result = bankInsertSchema.parse({
      code: "test-bank",
      name: "Test Bank",
      category: "PVB",
      state: null,
      website_url: null,
      rate_page_url: null,
      logo_url: null,
      rbi_licence_no: null,
      ifsc_prefix: null,
      assets_under_mgmt: null,
      trust_score: null,
    });
    expect(result.deposit_insurance).toBe(false);
  });
});

describe("bankQuerySchema", () => {
  it("applies defaults for pagination", () => {
    const result = bankQuerySchema.parse({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
  });

  it("coerces string numbers for pagination", () => {
    const result = bankQuerySchema.parse({ page: "3", limit: "25" });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(25);
  });

  it("rejects limit above 100", () => {
    expect(() => bankQuerySchema.parse({ limit: "200" })).toThrow();
  });
});

describe("rateSlabSchema", () => {
  it("validates a rate slab", () => {
    const slab = {
      id: 1,
      product_id: 1,
      bank_id: 1,
      tenure_min_days: 365,
      tenure_max_days: 729,
      tenure_text: "1 year to less than 2 years",
      rate_general_pct: 6.5,
      rate_senior_pct: 7.0,
      rate_super_senior_pct: 7.1,
      compounding_frequency: "quarterly",
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
      min_deposit_for_slab: null,
      max_deposit_for_slab: null,
      source_url: "https://sbi.co.in/rates",
      scraped_at: "2026-03-27T00:00:00Z",
      created_at: "2026-03-27T00:00:00Z",
    };
    expect(rateSlabSchema.parse(slab)).toEqual(slab);
  });

  it("rejects rate above 20%", () => {
    expect(() =>
      rateSlabSchema.parse({
        id: 1,
        product_id: 1,
        bank_id: 1,
        tenure_min_days: 365,
        tenure_max_days: 365,
        tenure_text: "1 year",
        rate_general_pct: 25.0,
        rate_senior_pct: null,
        rate_super_senior_pct: null,
        compounding_frequency: null,
        effective_from: "2026-01-01T00:00:00Z",
        effective_to: null,
        min_deposit_for_slab: null,
        max_deposit_for_slab: null,
        source_url: null,
        scraped_at: "2026-03-27T00:00:00Z",
        created_at: "2026-03-27T00:00:00Z",
      }),
    ).toThrow();
  });
});

describe("parseTenureText", () => {
  it("parses preset tenure text", () => {
    expect(parseTenureText("1 year to less than 2 years")).toEqual({
      minDays: 365,
      maxDays: 729,
    });
  });

  it("parses single-value tenure", () => {
    expect(parseTenureText("444 days")).toEqual({
      minDays: 444,
      maxDays: 444,
    });
  });

  it("parses range with units", () => {
    expect(parseTenureText("7 days to 45 days")).toEqual({
      minDays: 7,
      maxDays: 45,
    });
  });

  it("handles 'above' prefix", () => {
    const result = parseTenureText("above 1 year to 2 years");
    expect(result).toEqual({ minDays: 366, maxDays: 730 });
  });

  it("handles 'less than' in range", () => {
    const result = parseTenureText("211 days to less than 1 year");
    expect(result).toEqual({ minDays: 211, maxDays: 364 });
  });

  it("returns null for unparseable text", () => {
    expect(parseTenureText("some random text")).toBeNull();
  });

  // Hyphen and en/em-dash separators (Rabobank, Punjab Sind, Akhand Anand, etc.)
  it("accepts hyphen as range separator", () => {
    expect(parseTenureText("7-14 days")).toEqual({ minDays: 7, maxDays: 14 });
    expect(parseTenureText("30-45 days")).toEqual({ minDays: 30, maxDays: 45 });
  });
  it("accepts en-dash and em-dash as range separators", () => {
    expect(parseTenureText("7 – 14 Days")).toEqual({ minDays: 7, maxDays: 14 });
    expect(parseTenureText("180 — 364 Days")).toEqual({ minDays: 180, maxDays: 364 });
  });
  it("handles missing space between digit and unit", () => {
    expect(parseTenureText("30Days - 45Days")).toEqual({ minDays: 30, maxDays: 45 });
    expect(parseTenureText("07days - 14 Days")).toEqual({ minDays: 7, maxDays: 14 });
  });
  it("treats unit on only one side of range as shared", () => {
    expect(parseTenureText("180 – 364 Days")).toEqual({ minDays: 180, maxDays: 364 });
  });

  // Abbreviated units (Punjab Sind, Rabobank)
  it("expands single-letter unit abbreviations", () => {
    expect(parseTenureText("5Y")).toEqual({ minDays: 1825, maxDays: 1825 });
    expect(parseTenureText("2Y-776 Days")).toEqual({ minDays: 730, maxDays: 776 });
  });

  // Parenthetical qualifiers (Punjab Sind: "(Callable)", "(PSB Green Earth)")
  it("strips parenthetical qualifiers", () => {
    expect(parseTenureText("375 Days (Callable)")).toEqual({ minDays: 375, maxDays: 375 });
    expect(parseTenureText("22 Month (PSB Green Earth)")).toEqual({ minDays: 660, maxDays: 660 });
    expect(parseTenureText("444 Days (Non-Callable*)")).toEqual({ minDays: 444, maxDays: 444 });
  });

  // Comparator symbols (Punjab Sind: "> 22 Month < 2Y", ">5Y<66 Month")
  it("translates > to 'above' for single-bound", () => {
    const r = parseTenureText("> 2 years");
    expect(r).toEqual({ minDays: 731, maxDays: 3650 });
  });
  it("translates compound > X < Y to between", () => {
    expect(parseTenureText("> 22 Month < 2Y")).toEqual({ minDays: 661, maxDays: 729 });
    expect(parseTenureText(">5Y<66 Month")).toEqual({ minDays: 1826, maxDays: 1979 });
  });

  // "Above X" / "More than X" phrasings (Equitas, agra-zilla)
  it("handles 'Above X' open-ended", () => {
    expect(parseTenureText("Above 5 years")).toEqual({ minDays: 1826, maxDays: 3650 });
  });
  it("handles 'Above X and upto Y'", () => {
    expect(parseTenureText("Above 3 Years and upto 5 Years")).toEqual({
      minDays: 1096,
      maxDays: 1825,
    });
  });
  it("treats 'More than' as 'above'", () => {
    expect(parseTenureText("More than 1 year to 2 year")).toEqual({ minDays: 366, maxDays: 730 });
    expect(parseTenureText("More than 3 year but less than 5 year")).toEqual({
      minDays: 1096,
      maxDays: 1824,
    });
  });

  // "Up To Less Than X Year" (akhand-anand) / "X Year Up To Less Than Y Year"
  it("handles 'X Year Up To Less Than Y Year' phrasing", () => {
    expect(parseTenureText("1 Year Up To Less Than 2 Year")).toEqual({
      minDays: 365,
      maxDays: 729,
    });
    expect(parseTenureText("3 Year Up To Less Than 5 Year")).toEqual({
      minDays: 1095,
      maxDays: 1824,
    });
  });

  // "X months < Y months" / "X months < Y years" (Equitas SFB style)
  it("handles 'X months < Y months'", () => {
    expect(parseTenureText("9 months < 10 months")).toEqual({ minDays: 270, maxDays: 299 });
    expect(parseTenureText("18 months < 2 years")).toEqual({ minDays: 540, maxDays: 729 });
  });

  // "For X" prefix (agra-zilla)
  it("strips 'For' prefix", () => {
    expect(parseTenureText("For 1 year")).toEqual({ minDays: 365, maxDays: 365 });
  });

  // "181 Days - Up to 1 Year" (akhand-anand)
  it("handles 'Up to Y unit' as max", () => {
    expect(parseTenureText("181 Days - Up to 1 Year")).toEqual({ minDays: 181, maxDays: 365 });
  });
});
