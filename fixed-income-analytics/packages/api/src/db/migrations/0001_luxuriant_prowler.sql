CREATE TABLE `page_hashes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank_id` integer NOT NULL,
	`url` text NOT NULL,
	`content_hash` text NOT NULL,
	`last_checked_at` text NOT NULL,
	`last_changed_at` text,
	`http_status` integer,
	`error_message` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `page_hashes_bank_id_idx` ON `page_hashes` (`bank_id`);