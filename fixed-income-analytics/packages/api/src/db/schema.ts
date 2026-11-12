import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

function isoTimestamp() {
  return new Date().toISOString();
}

// ── banks ──────────────────────────────────────────────────────────
export const banks = sqliteTable(
  "banks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(), // BankCategory enum values
    state: text("state"),
    website_url: text("website_url"),
    rate_page_url: text("rate_page_url"),
    logo_url: text("logo_url"),
    rbi_licence_no: text("rbi_licence_no"),
    ifsc_prefix: text("ifsc_prefix"),
    deposit_insurance: integer("deposit_insurance", { mode: "boolean" }).notNull().default(false),
    assets_under_mgmt: real("assets_under_mgmt"),
    trust_score: real("trust_score"),
    scraper_status: text("scraper_status").notNull().default("pending"),
    discovery_status: text("discovery_status").notNull().default("pending"),
    created_at: text("created_at").notNull().$defaultFn(isoTimestamp),
    updated_at: text("updated_at").notNull().$defaultFn(isoTimestamp),
  },
  (table) => [
    uniqueIndex("banks_code_idx").on(table.code),
    index("banks_category_idx").on(table.category),
    index("banks_scraper_status_idx").on(table.scraper_status),
  ],
);

// ── products ───────────────────────────────────────────────────────
export const products = sqliteTable(
  "products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bank_id: integer("bank_id").notNull().references(() => banks.id),
    product_type: text("product_type").notNull(),
    variant: text("variant").notNull(),
    name: text("name"),
    description: text("description"),
    eligibility_notes: text("eligibility_notes"),
    sec_80c_eligible: integer("sec_80c_eligible", { mode: "boolean" }).notNull().default(false),
    premature_withdrawal_allowed: integer("premature_withdrawal_allowed", { mode: "boolean" }).notNull().default(true),
    min_deposit: real("min_deposit"),
    max_deposit: real("max_deposit"),
    created_at: text("created_at").notNull().$defaultFn(isoTimestamp),
    updated_at: text("updated_at").notNull().$defaultFn(isoTimestamp),
  },
  (table) => [
    index("products_bank_id_idx").on(table.bank_id),
    index("products_type_idx").on(table.product_type),
    index("products_bank_variant_idx").on(table.bank_id, table.product_type, table.variant),
  ],
);

// ── rate_slabs ─────────────────────────────────────────────────────
export const rateSlabs = sqliteTable(
  "rate_slabs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    product_id: integer("product_id").notNull().references(() => products.id),
    bank_id: integer("bank_id").notNull().references(() => banks.id),
    tenure_min_days: integer("tenure_min_days").notNull(),
    tenure_max_days: integer("tenure_max_days").notNull(),
    tenure_text: text("tenure_text").notNull(),
    rate_general_pct: real("rate_general_pct").notNull(),
    rate_senior_pct: real("rate_senior_pct"),
    rate_super_senior_pct: real("rate_super_senior_pct"),
    compounding_frequency: text("compounding_frequency"),
    effective_from: text("effective_from").notNull(),
    effective_to: text("effective_to"), // null = currently active
    min_deposit_for_slab: real("min_deposit_for_slab"),
    max_deposit_for_slab: real("max_deposit_for_slab"),
    currency: text("currency").notNull().default("INR"),
    source_url: text("source_url"),
    scraped_at: text("scraped_at").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoTimestamp),
  },
  (table) => [
    index("rate_slabs_bank_id_idx").on(table.bank_id),
    index("rate_slabs_product_id_idx").on(table.product_id),
    index("rate_slabs_active_idx").on(table.bank_id, table.effective_to),
    index("rate_slabs_currency_idx").on(table.currency, table.effective_to),
  ],
);

// ── rate_change_log ────────────────────────────────────────────────
export const rateChangeLog = sqliteTable(
  "rate_change_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rate_slab_id: integer("rate_slab_id").notNull().references(() => rateSlabs.id),
    bank_id: integer("bank_id").notNull().references(() => banks.id),
    product_id: integer("product_id").notNull().references(() => products.id),
    field_changed: text("field_changed").notNull(),
    old_value: text("old_value").notNull(),
    new_value: text("new_value").notNull(),
    detected_at: text("detected_at").notNull(),
    source_url: text("source_url"),
  },
  (table) => [
    index("rate_change_log_bank_id_idx").on(table.bank_id),
    index("rate_change_log_detected_at_idx").on(table.detected_at),
  ],
);

// ── scrape_runs ────────────────────────────────────────────────────
export const scrapeRuns = sqliteTable(
  "scrape_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bank_id: integer("bank_id").notNull().references(() => banks.id),
    started_at: text("started_at").notNull(),
    completed_at: text("completed_at"),
    status: text("status").notNull(),
    error_message: text("error_message"),
    records_found: integer("records_found").notNull().default(0),
    records_changed: integer("records_changed").notNull().default(0),
    records_flagged: integer("records_flagged").notNull().default(0),
    scraper_version: text("scraper_version"),
  },
  (table) => [
    index("scrape_runs_bank_id_idx").on(table.bank_id),
    index("scrape_runs_status_idx").on(table.status),
  ],
);

// ── scrape_flags ───────────────────────────────────────────────────
export const scrapeFlags = sqliteTable(
  "scrape_flags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scrape_run_id: integer("scrape_run_id").references(() => scrapeRuns.id),
    bank_id: integer("bank_id").notNull().references(() => banks.id),
    rate_slab_id: integer("rate_slab_id").references(() => rateSlabs.id),
    flag_type: text("flag_type").notNull(),
    severity: text("severity").notNull(),
    details: text("details").notNull(),
    resolution: text("resolution"),
    resolved_by: text("resolved_by"),
    resolved_at: text("resolved_at"),
  },
  (table) => [
    index("scrape_flags_bank_id_idx").on(table.bank_id),
    index("scrape_flags_resolution_idx").on(table.resolution),
  ],
);

// ── users ────────────────────────────────────────────────────────
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    name: text("name"),
    password_hash: text("password_hash").notNull(),
    role: text("role").notNull().default("user"), // user | admin
    created_at: text("created_at").notNull().$defaultFn(isoTimestamp),
    updated_at: text("updated_at").notNull().$defaultFn(isoTimestamp),
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
  ],
);

// ── sessions ─────────────────────────────────────────────────────
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: integer("user_id").notNull().references(() => users.id),
    token: text("token").notNull(),
    expires_at: text("expires_at").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoTimestamp),
  },
  (table) => [
    uniqueIndex("sessions_token_idx").on(table.token),
    index("sessions_user_id_idx").on(table.user_id),
  ],
);

// ── page_hashes ──────────────────────────────────────────────────
export const pageHashes = sqliteTable(
  "page_hashes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bank_id: integer("bank_id").notNull().references(() => banks.id),
    url: text("url").notNull(),
    content_hash: text("content_hash").notNull(),
    last_checked_at: text("last_checked_at").notNull(),
    last_changed_at: text("last_changed_at"),
    http_status: integer("http_status"),
    error_message: text("error_message"),
    created_at: text("created_at").notNull().$defaultFn(isoTimestamp),
  },
  (table) => [
    index("page_hashes_bank_id_idx").on(table.bank_id),
  ],
);

// ── special_schemes ────────────────────────────────────────────────
export const specialSchemes = sqliteTable(
  "special_schemes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bank_id: integer("bank_id").notNull().references(() => banks.id),
    name: text("name").notNull(),
    rate_pct: real("rate_pct").notNull(),
    tenure_days: integer("tenure_days"),
    launch_date: text("launch_date"),
    expiry_date: text("expiry_date"),
    min_deposit: real("min_deposit"),
    source_url: text("source_url"),
    notes: text("notes"),
  },
  (table) => [
    index("special_schemes_bank_id_idx").on(table.bank_id),
  ],
);
