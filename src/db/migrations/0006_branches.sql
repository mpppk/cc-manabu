ALTER TABLE `chats` ADD `group_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `fork_message_id` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `inherited_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `branch_title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `fork_session_id` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `fork_from_uuid` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `last_selected_at` integer;--> statement-breakpoint
CREATE INDEX `chats_group_id_idx` ON `chats` (`group_id`);--> statement-breakpoint
-- 既存の会話は、元の履歴を持つ 1 つの分岐（自分自身が会話）として移行する
UPDATE `chats` SET `group_id` = `id` WHERE `group_id` = '';
