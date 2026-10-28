CREATE TABLE `attempt_item_results` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`learning_item_id` text NOT NULL,
	`result` text NOT NULL,
	`detail_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`learning_item_id`) REFERENCES `learning_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_attempt_item_results_attempt_item` ON `attempt_item_results` (`attempt_id`,`learning_item_id`);--> statement-breakpoint
CREATE INDEX `idx_attempt_item_results_item` ON `attempt_item_results` (`learning_item_id`);--> statement-breakpoint
CREATE TABLE `question_items` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`learning_item_id` text NOT NULL,
	`sort_index` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`learning_item_id`) REFERENCES `learning_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_question_items_q_item` ON `question_items` (`question_id`,`learning_item_id`);--> statement-breakpoint
CREATE INDEX `idx_question_items_item` ON `question_items` (`learning_item_id`);--> statement-breakpoint
CREATE TABLE `review_task_items` (
	`id` text PRIMARY KEY NOT NULL,
	`review_task_id` text NOT NULL,
	`learning_item_id` text NOT NULL,
	`role` text NOT NULL,
	`result` text,
	`sort_index` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_task_id`) REFERENCES `review_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`learning_item_id`) REFERENCES `learning_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_review_task_items_task_item` ON `review_task_items` (`review_task_id`,`learning_item_id`);--> statement-breakpoint
CREATE INDEX `idx_review_task_items_item` ON `review_task_items` (`learning_item_id`);