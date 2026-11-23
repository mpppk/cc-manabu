CREATE TABLE `queued_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`position` integer NOT NULL,
	`parts` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `queued_messages_chat_id_idx` ON `queued_messages` (`chat_id`);--> statement-breakpoint
ALTER TABLE `chats` ADD `queue_paused` integer DEFAULT false NOT NULL;