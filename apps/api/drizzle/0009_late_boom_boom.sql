ALTER TABLE `review_sessions` ADD `abandoned_at` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `today_review_limit` integer DEFAULT 15 NOT NULL;