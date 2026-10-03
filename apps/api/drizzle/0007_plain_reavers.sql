ALTER TABLE `review_states` ADD `difficulty` real;--> statement-breakpoint
ALTER TABLE `review_states` ADD `stability` real;--> statement-breakpoint
ALTER TABLE `review_states` ADD `reps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `review_states` ADD `lapses` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `review_states` DROP COLUMN `level`;--> statement-breakpoint
ALTER TABLE `review_states` DROP COLUMN `stable`;