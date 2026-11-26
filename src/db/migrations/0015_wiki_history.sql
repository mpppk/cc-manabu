CREATE TABLE `wiki_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`wiki_id` text NOT NULL,
	`name` text NOT NULL,
	`auto` integer DEFAULT false NOT NULL,
	`seq` integer NOT NULL,
	`chat_id` text,
	`batch_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`wiki_id`) REFERENCES `wikis`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wiki_checkpoints_wiki_idx` ON `wiki_checkpoints` (`wiki_id`);--> statement-breakpoint
CREATE TABLE `wiki_page_versions` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wiki_id` text NOT NULL,
	`page_id` text NOT NULL,
	`title` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`source_chat_id` text,
	`source_message_id` text,
	`op` text NOT NULL,
	`actor` text NOT NULL,
	`batch_id` text NOT NULL,
	`reverts` text,
	`chat_id` text,
	`message_id` text,
	`tool` text,
	`restored_from` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`wiki_id`) REFERENCES `wikis`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wiki_page_versions_page_idx` ON `wiki_page_versions` (`page_id`,`seq`);--> statement-breakpoint
CREATE INDEX `wiki_page_versions_wiki_idx` ON `wiki_page_versions` (`wiki_id`,`seq`);--> statement-breakpoint
CREATE INDEX `wiki_page_versions_batch_idx` ON `wiki_page_versions` (`batch_id`);--> statement-breakpoint
CREATE INDEX `wiki_page_versions_message_idx` ON `wiki_page_versions` (`message_id`);--> statement-breakpoint
-- 履歴を記録する前からあるページは、今の内容を最初の版（baseline）にする
INSERT INTO `wiki_page_versions` (`wiki_id`, `page_id`, `title`, `aliases`, `body`, `deleted`, `origin`, `source_chat_id`, `source_message_id`, `op`, `actor`, `batch_id`, `created_at`)
	SELECT `wiki_id`, `id`, `title`, `aliases`, `body`, 0, `origin`, `source_chat_id`, `source_message_id`, 'baseline', 'system', 'baseline:' || `id`, `updated_at`
	FROM `wiki_pages`
	ORDER BY `created_at`;
