CREATE TABLE `wikis` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
-- 既存のプロジェクトは、それぞれ同じ ID・名前の Wiki を 1 つ持つ形で移行する
INSERT INTO `wikis` (`id`, `name`, `created_at`, `updated_at`)
	SELECT `id`, `name`, `created_at`, `updated_at` FROM `projects`;
--> statement-breakpoint
ALTER TABLE `projects` ADD `wiki_id` text REFERENCES wikis(id);--> statement-breakpoint
UPDATE `projects` SET `wiki_id` = `id`;--> statement-breakpoint
-- ページの所属をプロジェクトから Wiki に移す（project_id は外部キーなので、表を作り直して外す）
CREATE TABLE `__new_wiki_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`wiki_id` text NOT NULL,
	`title` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`source_chat_id` text,
	`source_message_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`wiki_id`) REFERENCES `wikis`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_wiki_pages`("id", "wiki_id", "title", "aliases", "body", "origin", "source_chat_id", "source_message_id", "created_at", "updated_at")
	SELECT "id", "project_id", "title", "aliases", "body", "origin", "source_chat_id", "source_message_id", "created_at", "updated_at" FROM `wiki_pages`;--> statement-breakpoint
DROP TABLE `wiki_pages`;--> statement-breakpoint
ALTER TABLE `__new_wiki_pages` RENAME TO `wiki_pages`;--> statement-breakpoint
CREATE INDEX `wiki_pages_wiki_id_idx` ON `wiki_pages` (`wiki_id`);
