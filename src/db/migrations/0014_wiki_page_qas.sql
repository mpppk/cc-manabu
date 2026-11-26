CREATE TABLE `wiki_page_qas` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`wiki_page_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_page_qas_message_idx` ON `wiki_page_qas` (`message_id`);--> statement-breakpoint
CREATE INDEX `wiki_page_qas_task_page_idx` ON `wiki_page_qas` (`task_id`,`wiki_page_id`);