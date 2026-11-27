PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`wiki_id` text,
	`directories` text DEFAULT '[]' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`wiki_id`) REFERENCES `wikis`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_environments`("id", "name", "wiki_id", "directories", "description", "created_at", "updated_at") SELECT "id", "name", "wiki_id", "directories", "description", "created_at", "updated_at" FROM `environments`;--> statement-breakpoint
DROP TABLE `environments`;--> statement-breakpoint
ALTER TABLE `__new_environments` RENAME TO `environments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;