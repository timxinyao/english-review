CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`review_task_id` text,
	`learning_item_id` text NOT NULL,
	`question_id` text,
	`mode` text NOT NULL,
	`answer_text` text,
	`selected_option_id` text,
	`result` text NOT NULL,
	`viewed_source` integer DEFAULT 0 NOT NULL,
	`feedback` text,
	`correction_json` text,
	`explanation` text,
	`better_version` text,
	`ai_prompt_key` text,
	`ai_prompt_version` integer,
	`ai_prompt_hash` text,
	`ai_model` text,
	`pre_state_json` text,
	`post_state_json` text,
	`created_at` text NOT NULL,
	`voided_at` text,
	FOREIGN KEY (`review_task_id`) REFERENCES `review_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`learning_item_id`) REFERENCES `learning_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_attempts_item_created` ON `attempts` (`learning_item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_attempts_task` ON `attempts` (`review_task_id`);--> statement-breakpoint
CREATE TABLE `daily_stats` (
	`date` text PRIMARY KEY NOT NULL,
	`formal_tasks_completed` integer DEFAULT 0 NOT NULL,
	`new_items_started` integer DEFAULT 0 NOT NULL,
	`production_attempts` integer DEFAULT 0 NOT NULL,
	`production_pass` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `learning_examples` (
	`id` text PRIMARY KEY NOT NULL,
	`learning_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`original_text` text,
	`better_text` text,
	`pinned` integer DEFAULT 0 NOT NULL,
	`quality_score` real,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`learning_item_id`) REFERENCES `learning_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_examples_item_kind` ON `learning_examples` (`learning_item_id`,`kind`);--> statement-breakpoint
CREATE TABLE `learning_items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`target` text NOT NULL,
	`meaning` text NOT NULL,
	`ipa` text,
	`source` text,
	`source_url` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`queue_state` text DEFAULT 'new' NOT NULL,
	`needs_reinforcement` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_learning_items_status` ON `learning_items` (`status`);--> statement-breakpoint
CREATE INDEX `idx_learning_items_queue_state` ON `learning_items` (`queue_state`);--> statement-breakpoint
CREATE INDEX `idx_learning_items_created_at` ON `learning_items` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_learning_items_target` ON `learning_items` (`target`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`learning_item_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'fresh' NOT NULL,
	`meaning_snapshot` text NOT NULL,
	`prompt_text` text,
	`context_text` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`correct_option_id` text,
	`prompt_key` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`prompt_hash` text NOT NULL,
	`model` text NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`retired_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`learning_item_id`) REFERENCES `learning_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_questions_item_type_status` ON `questions` (`learning_item_id`,`type`,`status`);--> statement-breakpoint
CREATE INDEX `idx_questions_status_retired` ON `questions` (`status`,`retired_at`);--> statement-breakpoint
CREATE TABLE `read_article_items` (
	`read_article_id` text NOT NULL,
	`learning_item_id` text NOT NULL,
	`role` text NOT NULL,
	`highlighted` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`read_article_id`, `learning_item_id`),
	FOREIGN KEY (`read_article_id`) REFERENCES `read_articles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`learning_item_id`) REFERENCES `learning_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `read_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`content_level` text DEFAULT 'B1' NOT NULL,
	`favorite` integer DEFAULT 0 NOT NULL,
	`prompt_key` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`prompt_hash` text NOT NULL,
	`model` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE TABLE `review_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_date` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`base_task_count` integer DEFAULT 0 NOT NULL,
	`new_items_started` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_review_sessions_date` ON `review_sessions` (`session_date`);--> statement-breakpoint
CREATE TABLE `review_states` (
	`id` text PRIMARY KEY NOT NULL,
	`learning_item_id` text NOT NULL,
	`dimension` text NOT NULL,
	`level` integer DEFAULT 0 NOT NULL,
	`stable` integer DEFAULT 0 NOT NULL,
	`next_review_at` text,
	`last_review_at` text,
	`correct_streak` integer DEFAULT 0 NOT NULL,
	`wrong_streak` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`learning_item_id`) REFERENCES `learning_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_review_states_item_dim` ON `review_states` (`learning_item_id`,`dimension`);--> statement-breakpoint
CREATE TABLE `review_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`learning_item_id` text NOT NULL,
	`dimension` text NOT NULL,
	`question_id` text,
	`task_type` text NOT NULL,
	`origin` text NOT NULL,
	`sort_key` real NOT NULL,
	`defer_count` integer DEFAULT 0 NOT NULL,
	`completed_at` text,
	`canceled_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `review_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`learning_item_id`) REFERENCES `learning_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_review_tasks_session_sort` ON `review_tasks` (`session_id`,`sort_key`);--> statement-breakpoint
CREATE INDEX `idx_review_tasks_item_origin` ON `review_tasks` (`learning_item_id`,`origin`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`max_new_items_per_day` integer DEFAULT 10 NOT NULL,
	`content_level` text DEFAULT 'B1' NOT NULL,
	`preferred_tts_voice` text,
	`updated_at` text NOT NULL
);
