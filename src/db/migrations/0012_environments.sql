CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`wiki_id` text NOT NULL,
	`directories` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`wiki_id`) REFERENCES `wikis`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `environment_id` text REFERENCES environments(id);--> statement-breakpoint
CREATE INDEX `tasks_environment_id_idx` ON `tasks` (`environment_id`);--> statement-breakpoint
-- 古い行で未設定の Wiki は、移行で作った同じ ID の Wiki（0009）
UPDATE `tasks` SET `wiki_id` = `id` WHERE `wiki_id` IS NULL;--> statement-breakpoint
-- タスクが参照している Wiki ごとに、同じ ID・名前の環境を作る。
-- ディレクトリは、その Wiki のタスクで最後に使った作業ディレクトリ。
-- 会話が無ければ空にしておき、起動時に起動したディレクトリで埋める。
INSERT INTO `environments` (`id`, `name`, `wiki_id`, `directories`, `created_at`, `updated_at`)
	SELECT `w`.`id`, `w`.`name`, `w`.`id`,
		COALESCE((
			SELECT json_array(`c`.`cwd`) FROM `chats` `c`
				JOIN `tasks` `t` ON `c`.`task_id` = `t`.`id`
				WHERE `t`.`wiki_id` = `w`.`id`
				ORDER BY `c`.`updated_at` DESC LIMIT 1
		), '[]'),
		`w`.`created_at`, `w`.`updated_at`
	FROM `wikis` `w`
	WHERE EXISTS (SELECT 1 FROM `tasks` `t` WHERE `t`.`wiki_id` = `w`.`id`);--> statement-breakpoint
UPDATE `tasks` SET `environment_id` = `wiki_id`;
