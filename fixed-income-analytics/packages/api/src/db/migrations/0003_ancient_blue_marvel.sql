ALTER TABLE `rate_slabs` ADD `currency` text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
CREATE INDEX `rate_slabs_currency_idx` ON `rate_slabs` (`currency`,`effective_to`);--> statement-breakpoint
CREATE INDEX `products_bank_variant_idx` ON `products` (`bank_id`,`product_type`,`variant`);