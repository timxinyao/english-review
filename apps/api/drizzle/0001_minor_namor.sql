ALTER TABLE `read_articles` ADD `type` text DEFAULT 'story' NOT NULL;--> statement-breakpoint
ALTER TABLE `read_articles` ADD `checks_json` text DEFAULT '[]' NOT NULL;