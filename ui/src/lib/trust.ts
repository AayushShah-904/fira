import type { TrustTier, FreshnessTier } from '../types'

/** Days since a date string. Returns Infinity if null/invalid. */
function daysSince(isoDate: string | null | undefined): number {
  if (!isoDate) return Infinity
  const ms = Date.now() - new Date(isoDate).getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

const HIGH_TRUST_CATEGORIES = new Set(['PSB', 'PVB', 'SFB'])

export function getTrustTier(depositInsurance: boolean, category: string): TrustTier {
  if (!depositInsurance) return 'low'
  if (HIGH_TRUST_CATEGORIES.has(category)) return 'high'
  return 'medium'
}

export function trustLabel(tier: TrustTier): string {
  switch (tier) {
    case 'high':   return 'High Safety'
    case 'medium': return 'DICGC Insured'
    case 'low':    return 'Verify Safety'
  }
}

export function trustColor(tier: TrustTier): string {
  switch (tier) {
    case 'high':   return 'trust-high'
    case 'medium': return 'trust-medium'
    case 'low':    return 'trust-low'
  }
}

export function getFreshness(scrapedAt: string | null | undefined): FreshnessTier {
  const age = daysSince(scrapedAt)
  if (age <= 7)  return 'fresh'
  if (age <= 30) return 'aging'
  return 'stale'
}

export function freshnessLabel(tier: FreshnessTier): string {
  switch (tier) {
    case 'fresh': return 'Verified recently'
    case 'aging': return 'Verified this month'
    case 'stale': return 'May be outdated'
  }
}

export function freshnessColor(tier: FreshnessTier): string {
  switch (tier) {
    case 'fresh': return 'text-success-600'
    case 'aging': return 'text-warning-600'
    case 'stale': return 'text-danger-600'
  }
}
