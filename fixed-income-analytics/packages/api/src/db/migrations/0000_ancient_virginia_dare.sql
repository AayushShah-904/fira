CREATE TABLE `banks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`state` text,
	`website_url` text,
	`rate_page_url` text,
	`logo_url` text,
	`rbi_licence_no` text,
	`ifsc_prefix` text,
	`deposit_insurance` integer DEFAULT false NOT NULL,
	`assets_under_mgmt` real,
	`trust_score` real,
	`scraper_status` text DEFAULT 'pending' NOT NULL,
	`discovery_status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `banks_code_idx` ON `banks` (`code`);--> statement-breakpoint
CREATE INDEX `banks_category_idx` ON `banks` (`category`);--> statement-breakpoint
CREATE INDEX `banks_scraper_status_idx` ON `banks` (`scraper_status`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank_id` integer NOT NULL,
	`product_type` text NOT NULL,
	`variant` text NOT NULL,
	`name` text,
	`description` text,
	`eligibility_notes` text,
	`sec_80c_eligible` integer DEFAULT false NOT NULL,
	`premature_withdrawal_allowed` integer DEFAULT true NOT NULL,
	`min_deposit` real,
	`max_deposit` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `products_bank_id_idx` ON `products` (`bank_id`);--> statement-breakpoint
CREATE INDEX `products_type_idx` ON `products` (`product_type`);--> statement-breakpoint
CREATE TABLE `rate_change_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rate_slab_id` integer NOT NULL,
	`bank_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`field_changed` text NOT NULL,
	`old_value` text NOT NULL,
	`new_value` text NOT NULL,
	`detected_at` text NOT NULL,
	`source_url` text,
	FOREIGN KEY (`rate_slab_id`) REFERENCES `rate_slabs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rate_change_log_bank_id_idx` ON `rate_change_log` (`bank_id`);--> statement-breakpoint
CREATE INDEX `rate_change_log_detected_at_idx` ON `rate_change_log` (`detected_at`);--> statement-breakpoint
CREATE TABLE `rate_slabs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`bank_id` integer NOT NULL,
	`tenure_min_days` integer NOT NULL,
	`tenure_max_days` integer NOT NULL,
	`tenure_text` text NOT NULL,
	`rate_general_pct` real NOT NULL,
	`rate_senior_pct` real,
	`rate_super_senior_pct` real,
	`compounding_frequency` text,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`min_deposit_for_slab` real,
	`max_deposit_for_slab` real,
	`source_url` text,
	`scraped_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rate_slabs_bank_id_idx` ON `rate_slabs` (`bank_id`);--> statement-breakpoint
CREATE INDEX `rate_slabs_product_id_idx` ON `rate_slabs` (`product_id`);--> statement-breakpoint
CREATE INDEX `rate_slabs_active_idx` ON `rate_slabs` (`bank_id`,`effective_to`);--> statement-breakpoint
CREATE TABLE `scrape_flags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scrape_run_id` integer,
	`bank_id` integer NOT NULL,
	`rate_slab_id` integer,
	`flag_type` text NOT NULL,
	`severity` text NOT NULL,
	`details` text NOT NULL,
	`resolution` text,
	`resolved_by` text,
	`resolved_at` text,
	FOREIGN KEY (`scrape_run_id`) REFERENCES `scrape_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rate_slab_id`) REFERENCES `rate_slabs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scrape_flags_bank_id_idx` ON `scrape_flags` (`bank_id`);--> statement-breakpoint
CREATE INDEX `scrape_flags_resolution_idx` ON `scrape_flags` (`resolution`);--> statement-breakpoint
CREATE TABLE `scrape_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank_id` integer NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`status` text NOT NULL,
	`error_message` text,
	`records_found` integer DEFAULT 0 NOT NULL,
	`records_changed` integer DEFAULT 0 NOT NULL,
	`records_flagged` integer DEFAULT 0 NOT NULL,
	`scraper_version` text,
	FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scrape_runs_bank_id_idx` ON `scrape_runs` (`bank_id`);--> statement-breakpoint
CREATE INDEX `scrape_runs_status_idx` ON `scrape_runs` (`status`);--> statement-breakpoint
CREATE TABLE `special_schemes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank_id` integer NOT NULL,
	`name` text NOT NULL,
	`rate_pct` real NOT NULL,
	`tenure_days` integer,
	`launch_date` text,
	`expiry_date` text,
	`min_deposit` real,
	`source_url` text,
	`notes` text,
	FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `special_schemes_bank_id_idx` ON `special_schemes` (`bank_id`);