// ── Auth ──────────────────────────────────────────────────────────
export interface User {
  id:              number
  email:           string
  name:            string
  firm?:           string | null
  ria_reg_no?:     string | null
  role:            'user' | 'admin' | 'viewer' | 'guest'
  plan:            'free' | 'pro' | 'enterprise' | 'guest'
  advisor_type?:   string | null
  onboarding_seen: number
  is_active?:      number
  email_verified?: number
}

export interface AuthResponse {
  token: string
  user:  User
}

// ── Bank Categories ───────────────────────────────────────────────
export interface BankCategory {
  id:           number
  code:         string
  name:         string
  description?: string | null
  regulator?:   string | null
  sort_order:   number
}

// ── Banks ──────────────────────────────────────────────────────────
export interface Bank {
  id:             number
  name:           string
  short_name?:    string | null
  state?:         string | null
  hq_city?:       string | null
  website?:       string | null
  dicgc_member:   boolean
  scheduled:      boolean
  crisil_rating?: string | null
  icra_rating?:   string | null
  care_rating?:   string | null
  deposits_cr?:   number | null
  advances_cr?:   number | null
  npa_pct?:       number | null
  crar_pct?:      number | null
  category_id:    number
  category_code:  string
  category_name:  string
  regulator?:     string | null
  updated_at?:    string | null
  rates?:         FdRate[]
}

// ── FD Rates ───────────────────────────────────────────────────────
export type ProductType =
  | 'domestic' | 'nre' | 'nro'
  | 'fcnr_usd' | 'fcnr_gbp' | 'fcnr_eur' | 'fcnr_cad' | 'fcnr_aud'
  | 'ibu_usd'  | 'ibu_eur'  | 'ibu_gbp'  | 'ibu_aed'
  | 'tax_saver'

export type CompoundingFreq = 'monthly' | 'quarterly' | 'half_yearly' | 'yearly' | 'simple'

export interface FdRate {
  id:              number
  bank_id:         number
  bank_name?:      string
  category_code?:  string
  state?:          string | null
  crisil_rating?:  string | null
  icra_rating?:    string | null
  dicgc_member?:   boolean
  product_type:    ProductType
  tenure_days_min: number
  tenure_days_max: number
  tenure_label:    string
  rate_general:    number
  rate_senior?:    number | null
  rate_bulk_1cr?:  number | null
  rate_staff?:     number | null
  min_amount?:     number | null
  max_amount?:     number | null
  compounding:     CompoundingFreq
  effective_from:  string
  effective_to?:   string | null
  source_url?:     string | null
  verified:        boolean
}

// ── Watchlists ─────────────────────────────────────────────────────
export interface Watchlist {
  id:           number
  user_id:      number
  name:         string
  description?: string | null
  created_at:   string
}

export interface WatchlistBank {
  watchlist_id: number
  bank_id:      number
  added_at:     string
}

// ── Client Profiles ────────────────────────────────────────────────
export interface ClientProfile {
  id:            number
  client_ref:    string
  tax_slab_pct:  number
  is_senior:     boolean
  is_nri:        boolean
  inflation_pct: number
  risk_profile:  'conservative' | 'moderate' | 'aggressive'
}

// ── Rate Alerts ────────────────────────────────────────────────────
export interface RateAlert {
  id:             number
  user_id?:       number
  bank_id?:       number | null
  category_id?:   number | null
  product_type:   ProductType
  threshold_rate: number
  direction:      'above' | 'below'
  is_active:      boolean
  notified_at?:   string | null
  created_at?:    string
}

// ── RIA Profile ────────────────────────────────────────────────────
export interface RiaProfile {
  id?:              number
  sebi_category?:   string | null
  city?:            string | null
  aum_bracket?:     string | null
  client_types?:    string | null
  fd_uses?:         string | null
  source?:          string | null
  onboarding_done?: number
}

// ── API Wrappers ───────────────────────────────────────────────────
export interface PaginatedResponse<T> {
  data:  T[]
  total: number
  page:  number
  limit: number
}

export interface ApiResponse<T> {
  data: T
}

// ── Trust / Freshness (from BIRD Phase 2) ──────────────────────────
export type TrustTier     = 'high' | 'medium' | 'low'
export type FreshnessTier = 'fresh' | 'aging'  | 'stale'

// ── Admin ──────────────────────────────────────────────────────────
export interface AdminStats {
  banks:          number
  rates:          number
  users:          number
  active_users:   number
  watchlists:     number
  alerts:         number
}

export interface AdminUser extends User {
  created_at: string
  last_login: string | null
}

// ── Feedback ───────────────────────────────────────────────────────
export interface FeedbackItem {
  id:         number
  user_id:    number
  category:   'bug' | 'feature' | 'general'
  message:    string
  created_at: string
}

// ── Simulator ─────────────────────────────────────────────────────
export interface SimulatorBestRate {
  bank_id:      number
  bank_name:    string
  category_code: string
  rate_general: number
  rate_senior?: number | null
  tenure_label: string
}

// ── User Mode ─────────────────────────────────────────────────────
export type UserMode = 'nri' | 'domestic'
