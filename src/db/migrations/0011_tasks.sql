-- 「プロジェクト」を「タスク」に改名する（データはそのまま）。
-- テーブル・列の改名は、ほかのテーブルの外部キーとインデックスの参照も書き換える。
ALTER TABLE `projects` RENAME TO `tasks`;--> statement-breakpoint
ALTER TABLE `project_links` RENAME TO `task_links`;--> statement-breakpoint
ALTER TABLE `task_links` RENAME COLUMN `project_id` TO `task_id`;--> statement-breakpoint
ALTER TABLE `chats` RENAME COLUMN `project_id` TO `task_id`;--> statement-breakpoint
DROP INDEX `chats_project_id_idx`;--> statement-breakpoint
CREATE INDEX `chats_task_id_idx` ON `chats` (`task_id`);--> statement-breakpoint
DROP INDEX `chats_project_wiki_page_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `chats_task_wiki_page_idx` ON `chats` (`task_id`,`wiki_page_id`) WHERE "chats"."parent_id" IS NULL AND "chats"."wiki_page_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX `project_links_project_id_idx`;--> statement-breakpoint
CREATE INDEX `task_links_task_id_idx` ON `task_links` (`task_id`);
