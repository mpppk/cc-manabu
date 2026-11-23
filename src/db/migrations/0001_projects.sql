CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `project_id` text REFERENCES projects(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `chats_project_id_idx` ON `chats` (`project_id`);