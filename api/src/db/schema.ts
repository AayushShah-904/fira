import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// ── USERS ────────────────────────────────────────────────────────
export const users = sqliteTable('users', {
  id:                integer('id').primaryKey({ autoIncrement: true }),
  email:             text('email').notNull().unique(),
  passwordHash:      text('password_hash').notNull(),
  name:              text('name').notNull(),
  firm:              text('firm'),
  riaRegNo:          text('ria_reg_no'),
  role:              text('role').notNull().default('user'),
  plan:              text('plan').notNull().default('free'),
  advisorType:       text('advisor_type'),
  createdAt:         text('created_at').notNull().default(sql`(datetime('now'))`),
  lastLogin:         text('last_login'),
  isActive:          integer('is_active').notNull().default(1),
  emailVerified:     integer('email_verified').notNull().default(0),
  onboardingAnswer:  text('onboarding_answer'),
  onboardingSeen:    integer('onboarding_seen').notNull().default(0),
})

// ── API KEYS ────────────────────────────────────────────────────
export const apiKeys = sqliteTable('api_keys', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  userId:    integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  keyHash:   text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  label:     text('label'),
  lastUsed:  text('last_used'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  expiresAt: text('expires_at'),
  isActive:  integer('is_active').notNull().default(1),
})

// ── BANK CATEGORIES ─────────────────────────────────────────────
export const bankCategories = sqliteTable('bank_categories', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  code:          text('code').notNull().unique(),
  name:          text('name').notNull(),
  description:   text('description'),
  regulator:     text('regulator'),
  dicgcCovered:  integer('dicgc_covered').notNull().default(1),
  sortOrder:     integer('sort_order').notNull().default(0),
})

// ── BANKS ───────────────────────────────────────────────────────
export const banks = sqliteTable('banks', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  categoryId:    integer('category_id').notNull().references(() => bankCategories.id),
  name:          text('name').notNull(),
  shortName:     text('short_name'),
  state:         text('state'),
  hqCity:        text('hq_city'),
  roRegion:      text('ro_region'),
  website:       text('website'),
  rbiLicenceNo:  text('rbi_licence_no'),
  dicgcMember:   integer('dicgc_member').notNull().default(1),
  scheduled:     integer('scheduled').notNull().default(0),
  crisilRating:  text('crisil_rating'),
  icraRating:    text('icra_rating'),
  careRating:    text('care_rating'),
  ratingDate:    text('rating_date'),
  depositsCr:    real('deposits_cr'),
  advancesCr:    real('advances_cr'),
  npaPct:        real('npa_pct'),
  crarPct:       real('crar_pct'),
  depositRetail: integer('deposit_retail').notNull().default(0),
  isActive:      integer('is_active').notNull().default(1),
  createdAt:     text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:     text('updated_at').notNull().default(sql`(datetime('now'))`),
})

// ── FD RATES ────────────────────────────────────────────────────
export const fdRates = sqliteTable('fd_rates', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  bankId:        integer('bank_id').notNull().references(() => banks.id, { onDelete: 'cascade' }),
  productType:   text('product_type').notNull(),
  tenureDaysMin: integer('tenure_days_min').notNull(),
  tenureDaysMax: integer('tenure_days_max').notNull(),
  tenureLabel:   text('tenure_label').notNull(),
  rateGeneral:   real('rate_general').notNull(),
  rateSenior:    real('rate_senior'),
  rateBulk1Cr:   real('rate_bulk_1cr'),
  rateStaff:     real('rate_staff'),
  minAmount:     real('min_amount'),
  maxAmount:     real('max_amount'),
  compounding:   text('compounding').notNull().default('quarterly'),
  effectiveFrom: text('effective_from').notNull(),
  effectiveTo:   text('effective_to'),
  sourceUrl:     text('source_url'),
  verified:      integer('verified').notNull().default(0),
  verifiedAt:    text('verified_at'),
  notes:         text('notes'),
  createdAt:     text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt:     text('updated_at').notNull().default(sql`(datetime('now'))`),
})

// ── CLIENT PROFILES ─────────────────────────────────────────────
export const clientProfiles = sqliteTable('client_profiles', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  userId:       integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientRef:    text('client_ref').notNull(),
  taxSlabPct:   real('tax_slab_pct').notNull().default(30.0),
  isSenior:     integer('is_senior').notNull().default(0),
  isNri:        integer('is_nri').notNull().default(0),
  inflationPct: real('inflation_pct').notNull().default(4.5),
  riskProfile:  text('risk_profile').notNull().default('moderate'),
  createdAt:    text('created_at').notNull().default(sql`(datetime('now'))`),
})

// ── WATCHLISTS ──────────────────────────────────────────────────
export const watchlists = sqliteTable('watchlists', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  userId:      integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name:        text('name').notNull(),
  description: text('description'),
  createdAt:   text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const watchlistBanks = sqliteTable('watchlist_banks', {
  watchlistId: integer('watchlist_id').notNull().references(() => watchlists.id, { onDelete: 'cascade' }),
  bankId:      integer('bank_id').notNull().references(() => banks.id, { onDelete: 'cascade' }),
  addedAt:     text('added_at').notNull().default(sql`(datetime('now'))`),
})

// ── RATE ALERTS ─────────────────────────────────────────────────
export const rateAlerts = sqliteTable('rate_alerts', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  userId:        integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bankId:        integer('bank_id').references(() => banks.id),
  categoryId:    integer('category_id').references(() => bankCategories.id),
  productType:   text('product_type').notNull().default('domestic'),
  thresholdRate: real('threshold_rate').notNull(),
  direction:     text('direction').notNull().default('above'),
  notifiedAt:    text('notified_at'),
  isActive:      integer('is_active').notNull().default(1),
  createdAt:     text('created_at').notNull().default(sql`(datetime('now'))`),
})

// ── FEEDBACK ────────────────────────────────────────────────────
export const feedback = sqliteTable('feedback', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  userId:    integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  category:  text('category').notNull().default('general'),
  message:   text('message').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

// ── AUDIT LOG ───────────────────────────────────────────────────
export const auditLog = sqliteTable('audit_log', {
  id:         integer('id').primaryKey({ autoIncrement: true }),
  userId:     integer('user_id').references(() => users.id),
  action:     text('action').notNull(),
  resource:   text('resource'),
  resourceId: text('resource_id'),
  ipAddress:  text('ip_address'),
  userAgent:  text('user_agent'),
  createdAt:  text('created_at').notNull().default(sql`(datetime('now'))`),
})
