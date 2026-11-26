CREATE TABLE `goal_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`goal` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `goal_runs_task_id_idx` ON `goal_runs` (`task_id`);--> statement-breakpoint
CREATE INDEX `goal_runs_chat_id_idx` ON `goal_runs` (`chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `goal_runs_active_task_idx` ON `goal_runs` (`task_id`) WHERE "goal_runs"."state" in ('running', 'needs_review');