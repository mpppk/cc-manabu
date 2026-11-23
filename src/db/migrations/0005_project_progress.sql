ALTER TABLE `projects` ADD `status` text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `progress_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `next_action` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `progress_updated_at` integer;