// IMPORTANT: Indian FDs use SIMPLE interest paid at maturity (for guide
// scenarios where we show total maturity across a fixed tenure).
// Do NOT use compound monthly here — that overstates returns vs banks'
// standard way of quoting interest on FD advisories.

// Convert INR amount (rupees) to USD
export function inrToUsd(amountINR, usdRate = 84) {
  return Math.round(amountINR / usdRate)
}

// FD maturity in USD — simple interest
// principal × (1 + rate/100 × months/12)
export function usdFdMaturity(principalUSD, annualRate, months) {
  const interest = principalUSD * (annualRate / 100) * (months / 12)
  return Math.round(principalUSD + interest)
}

// FD maturity in INR — simple interest
export function inrFdMaturity(principalINR, annualRate, months) {
  const interest = principalINR * (annualRate / 100) * (months / 12)
  return Math.round(principalINR + interest)
}

// TCS calculation for LRS remittance
// Purpose: 'investment' (IBU/GIFT City) = 20% above ₹10L
// Purpose: 'education_self' = 5% above ₹10L (Budget 2025) / 2% from Apr 2026
// Purpose: 'education_loan' = 0%
export function calcTCS(amountINR, purpose = 'investment', fyFrom2026 = true) {
  const thresholdINR = 1000000 // ₹10L
  if (amountINR <= thresholdINR) return 0
  const taxableINR = amountINR - thresholdINR
  const rates = {
    investment:     0.20,                    // 20% — always
    education_self: fyFrom2026 ? 0.02 : 0.05, // 2% from Apr 1 2026, was 5%
    education_loan: 0,                       // 0% — fully exempt
  }
  const rate = rates[purpose] ?? 0.20
  return Math.round(taxableINR * rate)
}

// Split-FY TCS saving
// Remit threshold (₹10L) in FY1, remainder in FY2 — both TCS-free
export function splitFyTcsSaving(totalINR, purpose = 'investment') {
  const tcsIfSingleFY = calcTCS(totalINR, purpose)
  const tcsIfSplit = 0 // both tranches ≤ ₹10L
  return { tcsIfSingleFY, tcsIfSplit, saving: tcsIfSingleFY - tcsIfSplit }
}

// Format currency
export const fmtINR = (n) => '₹' + (n / 100000).toFixed(2) + 'L'
export const fmtUSD = (n) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
}).format(n)

// Opportunity cost vs benchmark (USD, annual)
export function opportunityCostUSD(principalUSD, bestRate, currentRate) {
  return Math.round(principalUSD * (bestRate - currentRate) / 100)
}
