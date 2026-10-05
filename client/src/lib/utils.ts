import type { ProductType } from '../types'

// ── Number formatting ──────────────────────────────────────────────
export const fmt = {
  pct:    (n: number | null | undefined, d = 2): string =>
    n == null ? '—' : `${Number(n).toFixed(d)}%`,
  cr:     (n: number | null | undefined): string =>
    n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')} Cr`,
  inr:    (n: number | null | undefined): string =>
    n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`,
  bps:    (n: number | null | undefined): string =>
    n == null ? '—' : `${n > 0 ? '+' : ''}${n} bps`,
  signed: (n: number | null | undefined, d = 2): string =>
    n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}%`,
  date:   (d: string | null | undefined): string =>
    d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—',
}

// ── FD Calculations ────────────────────────────────────────────────
export function compoundGrowth(
  principal: number,
  ratePercent: number,
  years: number,
  freq = 4
): number {
  return principal * Math.pow(1 + ratePercent / 100 / freq, freq * years)
}

// ── Credit ratings ─────────────────────────────────────────────────
export type RatingTier = 'aaa' | 'aa' | 'a' | 'bbb' | 'nr'

export function normalizeRating(
  crisil?: string | null,
  icra?: string | null,
  care?: string | null
): string | null {
  const r = crisil || icra || care
  if (!r) return null
  return r.replace(/^F|^\[ICRA\]|^CARE\s*/i, '').trim()
}

export function ratingTier(r: string | null | undefined): RatingTier {
  if (!r) return 'nr'
  const n = r.toUpperCase()
  if (n === 'AAA')       return 'aaa'
  if (n.startsWith('AA')) return 'aa'
  if (n.startsWith('A'))  return 'a'
  if (n.startsWith('BBB')) return 'bbb'
  return 'nr'
}

export function ratingColor(r: string | null | undefined): string {
  const t = ratingTier(r)
  return ({
    aaa: 'rating-aaa',
    aa:  'rating-aa',
    a:   'rating-a',
    bbb: 'rating-bbb',
    nr:  'rating-nr',
  } as Record<RatingTier, string>)[t] || 'rating-nr'
}

// ── Category Colours ───────────────────────────────────────────────
const CATEGORY_COLOR_MAP: Record<string, string> = {
  PSB:     'badge-blue',
  PVB:     'badge-blue',
  SFB:     'badge-green',
  SCH_UCB: 'badge-amber',
  NS_UCB:  'badge-gray',
  DCCB:    'badge-green',
  SCB:     'badge-amber',
  SSCB:    'badge-amber',
  NSSCB:   'badge-gray',
  FB:      'badge-brand',
  RRB:     'badge-green',
  PB:      'badge-blue',
  LAB:     'badge-gray',
  IBU:     'badge-brand',
  NBFC:    'badge-amber',
}

export function categoryColor(code: string): string {
  return CATEGORY_COLOR_MAP[code] || 'badge-gray'
}

// ── Product Labels ─────────────────────────────────────────────────
const PRODUCT_LABELS: Record<ProductType, string> = {
  domestic:  'Domestic FD',
  nre:       'NRE FD',
  nro:       'NRO FD',
  fcnr_usd:  'FCNR USD',
  fcnr_gbp:  'FCNR GBP',
  fcnr_eur:  'FCNR EUR',
  fcnr_cad:  'FCNR CAD',
  fcnr_aud:  'FCNR AUD',
  ibu_usd:   'Gift City USD',
  ibu_eur:   'Gift City EUR',
  ibu_gbp:   'Gift City GBP',
  ibu_aed:   'Gift City AED',
  tax_saver: 'Tax Saver',
}

export function productLabel(code: string): string {
  return PRODUCT_LABELS[code as ProductType] || code
}
