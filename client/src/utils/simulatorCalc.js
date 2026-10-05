import {
  TAX_BRACKETS, EQUITY_RETURNS, EQUITY_JOURNEY, USD_TO_INR,
  RESIDENCE_TAX, SP500_JOURNEY,
} from '../data/simulatorConstants'

// Check if income qualifies for 87A rebate (zero tax)
// incomePerSpouse is in lakhs
export function isZeroTax(incomePerSpouseL) {
  return incomePerSpouseL <= TAX_BRACKETS.rebate87A / 100000
}

// FD wealth after n months at given annual rate (compounded monthly)
export function fdWealth(principalL, annualRate, months) {
  const monthlyRate = annualRate / 12 / 100
  return parseFloat((principalL * Math.pow(1 + monthlyRate, months)).toFixed(2))
}

// FD tax drag (30% slab above 87A rebate)
export function fdTax(gainL, incomePerSpouseL) {
  if (isZeroTax(incomePerSpouseL)) return 0
  return parseFloat((gainL * 0.30).toFixed(2))
}

// Equity net wealth after LTCG tax
export function equityNetWealth(rawWealthL, principalL, numSpouses = 2) {
  const totalGain = rawWealthL - principalL
  const exemptionTotal = EQUITY_RETURNS.ltcgExemption * numSpouses
  const taxableGain = Math.max(0, totalGain - exemptionTotal)
  const tax = taxableGain * (EQUITY_RETURNS.ltcgRate / 100)
  return parseFloat((rawWealthL - tax).toFixed(2))
}

// Build FD journey array (quarterly points)
export function buildFdJourney(principalL, annualRate, points = 10) {
  return Array.from({ length: points }, (_, i) => {
    const months = i * 3
    return parseFloat(fdWealth(principalL, annualRate, months).toFixed(2))
  })
}

// Build equity journey from index
export function buildEquityJourney(principalL, indexArr) {
  return indexArr.map(idx => parseFloat((principalL * idx / 100).toFixed(2)))
}

// Risk-adjusted ratio: extra gain / max drawdown
export function riskRewardRatio(equityJourney, fdJourney, netEquity, netFd) {
  const extraGain = netEquity - netFd
  const peak = Math.max(...equityJourney)
  const trough = Math.min(...equityJourney)
  const maxDrawdown = peak - trough
  if (maxDrawdown <= 0) return null
  return parseFloat((extraGain / maxDrawdown).toFixed(2))
}

// NRE FD — always tax-free in India, INR
export function nreFdWealth(principalL, annualRate, months) {
  const monthlyRate = annualRate / 12 / 100
  return parseFloat((principalL * Math.pow(1 + monthlyRate, months)).toFixed(2))
}

// IBU USD wealth in INR equivalent (for display comparison)
// principalUSD = principal in USD units
// Returns the end value in INR lakhs
export function ibuWealthINR(principalUSD, annualRate, months) {
  const monthlyRate = annualRate / 12 / 100
  const finalUSD = principalUSD * Math.pow(1 + monthlyRate, months)
  return parseFloat((finalUSD * USD_TO_INR / 100000).toFixed(2))
}

// ─── USD / INTERNATIONAL CALCULATIONS ────────────────

// Deposit wealth in USD (compounded monthly)
export function usdDepositWealth(principalUSD, annualRate, months) {
  const monthlyRate = annualRate / 12 / 100
  return parseFloat((principalUSD * Math.pow(1 + monthlyRate, months)).toFixed(2))
}

// Net deposit wealth after residence tax
export function usdDepositNet(principalUSD, annualRate, months, residenceKey) {
  const gross = usdDepositWealth(principalUSD, annualRate, months)
  const gain = gross - principalUSD
  const taxRate = RESIDENCE_TAX[residenceKey]?.ordinaryIncome || 0
  return parseFloat((gross - gain * taxRate).toFixed(2))
}

// Build quarterly USD deposit journey
export function buildUsdJourney(principalUSD, annualRate, points = 10) {
  return Array.from({ length: points }, (_, i) => {
    const months = i * 3
    return parseFloat(usdDepositWealth(principalUSD, annualRate, months).toFixed(2))
  })
}

// S&P 500 quarterly journey in USD
export function buildSP500Journey(principalUSD) {
  return SP500_JOURNEY.map(idx => parseFloat((principalUSD * idx / 100).toFixed(2)))
}

// S&P 500 net after capital gains tax in residence country
export function sp500Net(rawUSD, principalUSD, residenceKey) {
  const gain = rawUSD - principalUSD
  if (gain <= 0) return rawUSD
  const cgRate = RESIDENCE_TAX[residenceKey]?.capitalGains || 0
  return parseFloat((rawUSD - gain * cgRate).toFixed(2))
}

// Effective yield after tax
export function effectiveYield(grossRate, taxRate) {
  return parseFloat((grossRate * (1 - taxRate)).toFixed(2))
}

// USD risk-reward ratio
export function usdRiskReward(sp500Journey, depositNet, sp500NetVal) {
  const peak = Math.max(...sp500Journey)
  const trough = Math.min(...sp500Journey)
  const maxDrawdownUSD = parseFloat((peak - trough).toFixed(2))
  const extraGain = parseFloat((sp500NetVal - depositNet).toFixed(2))
  if (maxDrawdownUSD <= 0) return { ratio: null, extraGain, maxDrawdownUSD }
  const ratio = parseFloat((extraGain / maxDrawdownUSD).toFixed(2))
  return { ratio, extraGain, maxDrawdownUSD }
}

// Three-way NRI verdict (NRE vs IBU vs equity)
export function nriVerdict(nreNet, ibuNetL, equityNet, totalInvestment) {
  const equityJourneyL = EQUITY_JOURNEY.map(i => totalInvestment * i / 100)
  const maxDrawdown = parseFloat(
    (Math.max(...equityJourneyL) - Math.min(...equityJourneyL)).toFixed(2)
  )
  const extraOverNre = parseFloat((equityNet - nreNet).toFixed(2))
  const rrRatioNre = maxDrawdown > 0
    ? parseFloat((extraOverNre / maxDrawdown).toFixed(2))
    : null

  const candidates = [
    { key: 'nre', value: nreNet },
    { key: 'ibu', value: ibuNetL || 0 },
    { key: 'equity', value: equityNet },
  ]
  candidates.sort((a, b) => b.value - a.value)
  const winner = candidates[0].key

  return { winner, rrRatioNre, extraOverNre, maxDrawdown }
}
