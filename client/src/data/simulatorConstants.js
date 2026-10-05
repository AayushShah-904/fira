// Equity fund category returns — update quarterly
// Based on top midcap fund category average
export const EQUITY_RETURNS = {
  label: 'Top equity MF (midcap category)',
  annual: {
    2023: 44.0,
    2024: 29.0,
    2025: -8.0,
    2026: 7.0,   // YTD estimated, annualised
  },
  ter: 0.71,     // already in NAV — informational only
  exitLoad: 1.0, // % if sold within 1 year
  ltcgRate: 12.5,
  ltcgExemption: 1.25, // lakhs per person per year
}

export const PPF_RATE = 7.1

export const TAX_BRACKETS = {
  new_regime: [
    { upTo: 400000,   rate: 0 },
    { upTo: 800000,   rate: 5 },
    { upTo: 1200000,  rate: 10 },
    { upTo: 1600000,  rate: 15 },
    { upTo: 2000000,  rate: 20 },
    { upTo: 2400000,  rate: 25 },
    { upTo: Infinity, rate: 30 },
  ],
  rebate87A: 1200000, // ₹12L — zero tax below this
}

export const MONTH_LABELS = [
  'Jan 24', 'Apr 24', 'Jul 24', 'Oct 24',
  'Jan 25', 'Apr 25', 'Jul 25', 'Oct 25',
  'Jan 26', 'Apr 26',
]

// Quarterly equity wealth journey index (base 100)
// Derived from annual returns above
export const EQUITY_JOURNEY = [
  100, 106.7, 114.5, 121.8,
  130.3, 124.2, 108.1, 100.0,
  110.7, 126.5,
]

export const FD_JOURNEY_MONTHLY_RATE = 8.0 / 12 / 100

// INR <-> USD conversion for IBU normalisation (display only — actual USD return unaffected)
export const USD_TO_INR = 84

// ─── DOMESTIC MODE CONFIG ──────────────────────────────
export const DOMESTIC_CONFIG = {
  mode: 'dom',
  headline: 'At ₹24L household income, the best FD wins',
  subline: 'FD vs equity · post-tax · risk-adjusted · live rates from FIA',
  fdLabel: 'Best fixed deposit',
  fdProduct: 'domestic',
  currency: '₹',
  incomeLabel: 'Income per person (₹L)',
  taxNote: (income) => income <= 12
    ? `At ₹${income}L income, Section 87A rebate applies — FD interest is fully tax-free.`
    : `At ₹${income}L income, FD interest taxed at 30%. Consider NRE FD if you qualify.`,
  taxRate: (income) => income <= 12 ? 0 : 0.30,
  showSpouseToggle: true,
  showIbuToggle: false,
  verdictWinLabel: 'FD wins on risk-adjusted basis',
  verdictLoseLabel: 'Equity leads — risk may be justified',
}

// ─── NRI MODE CONFIG ───────────────────────────────────
export const NRI_CONFIG = {
  mode: 'nri',
  headline: 'NRE FD vs IBU USD vs equity — what wins for NRIs?',
  subline: 'All tax-free in India · post-LTCG · risk-adjusted',
  fdLabel: 'Best NRE FD',
  fdProduct: 'nre',
  ibuLabel: 'Best GIFT City IBU',
  ibuProduct: 'ibu_usd',
  currency: '₹',
  incomeLabel: 'Income per person (₹L) — NRE exempt',
  taxNote: () =>
    'NRE FD and IBU USD interest are fully tax-free in India — no TDS, no filing needed.',
  taxRate: () => 0,
  showSpouseToggle: true,
  showIbuToggle: true,
  ibuUsdNote: 'IBU is USD-denominated — no currency risk during tenure',
  verdictWinLabel: 'Deposit wins on risk-adjusted basis',
  verdictLoseLabel: 'Equity leads — consider your risk horizon',
}

// ─── INTERNATIONAL / NRI USD ──────────────────────────────────
export const INTL_INSTRUMENTS = {
  ibu: {
    id: 'ibu',
    label: 'GIFT City IBU',
    sublabel: 'USD · Tax-free in India · IFSC',
    product: 'ibu_usd',     // maps to FIA DB product
    taxIndiaRate: 0,
    color: '#d97706',       // amber-600
    type: 'deposit',
    dicgc: false,
    fdic: false,
    note: 'Regulated by IFSCA · No deposit insurance',
  },
  fcnr: {
    id: 'fcnr',
    label: 'FCNR(B) USD',
    sublabel: 'USD · Tax-free in India · 1–5yr',
    product: 'fcnr_usd',
    taxIndiaRate: 0,
    color: '#059669',       // success-600
    type: 'deposit',
    dicgc: false,
    fdic: false,
    note: 'Backed by Indian bank · No DICGC on foreign currency',
  },
  hysa: {
    id: 'hysa',
    label: 'US HYSA',
    sublabel: 'USD · FDIC insured · Liquid',
    rate: 4.50,             // static — update quarterly
    taxIndiaRate: null,
    color: '#2563eb',       // blue-600
    type: 'deposit',
    dicgc: false,
    fdic: true,
    note: 'FDIC insured up to $250K · Fully liquid',
  },
  treasury: {
    id: 'treasury',
    label: 'US Treasury (1yr)',
    sublabel: 'USD · Sovereign · Federal tax only',
    rate: 3.80,             // static — update quarterly
    taxIndiaRate: null,
    color: '#6b7280',       // gray-500
    type: 'deposit',
    dicgc: false,
    fdic: false,
    note: 'US government backed · No state tax',
  },
  sp500: {
    id: 'sp500',
    label: 'S&P 500',
    sublabel: 'USD · Market risk · ETF (SPY)',
    taxIndiaRate: null,
    color: '#dc2626',       // danger-600
    type: 'equity',
    dicgc: false,
    fdic: false,
    note: 'Past returns do not guarantee future performance',
  },
}

// S&P 500 actual annual returns (SPY total return incl dividends)
// Source: financecharts.com — update quarterly
export const SP500_RETURNS = {
  2024: 24.89,
  2025: 17.72,
  2026: 4.42,   // YTD as of Apr 17, 2026 — estimated annualised
}

// S&P 500 quarterly journey index (base 100 = Jan 2024)
export const SP500_JOURNEY = [
  100,    // Jan 2024
  108.2,  // Apr 2024
  115.6,  // Jul 2024
  122.4,  // Oct 2024
  131.2,  // Jan 2025 (end 2024 ~+24.89%)
  134.8,  // Apr 2025
  137.2,  // Jul 2025
  142.1,  // Oct 2025
  151.3,  // Jan 2026 (end 2025 ~+17.72%)
  155.0,  // Apr 2026 (+4.42% YTD)
]

// Index of soft-patch in S&P 500 journey (for max-drawdown marker)
export const SP500_WORST_IDX = 5  // Apr 2025

// Residence tax profiles
export const RESIDENCE_TAX = {
  uae: {
    label: 'UAE / Gulf',
    flag: '🇦🇪',
    ordinaryIncome: 0,
    capitalGains: 0,
    note: 'No personal income tax in UAE, Saudi, Qatar, Bahrain, Kuwait, Oman.',
  },
  us: {
    label: 'United States',
    flag: '🇺🇸',
    ordinaryIncome: 0.24,   // 24% federal bracket (typical NRI income)
    capitalGains: 0.15,     // 15% LTCG (most NRIs)
    note: 'US federal tax applies. IBU/FCNR interest taxable in US even though tax-free in India.',
  },
  uk: {
    label: 'United Kingdom',
    flag: '🇬🇧',
    ordinaryIncome: 0.20,
    capitalGains: 0.18,
    note: 'UK income tax applies on worldwide income for UK residents.',
  },
  sg: {
    label: 'Singapore',
    flag: '🇸🇬',
    ordinaryIncome: 0.17,
    capitalGains: 0,
    note: 'Singapore taxes foreign income only if remitted. Capital gains tax-free.',
  },
  other: {
    label: 'Other / Low tax',
    flag: '🌐',
    ordinaryIncome: 0.10,
    capitalGains: 0.05,
    note: 'Approximate. Check your country of residence tax rules.',
  },
}

export const INTL_MONTH_LABELS = [
  'Jan 24', 'Apr 24', 'Jul 24', 'Oct 24',
  'Jan 25', 'Apr 25', 'Jul 25', 'Oct 25',
  'Jan 26', 'Apr 26',
]
