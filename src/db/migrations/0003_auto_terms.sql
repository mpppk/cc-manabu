ALTER TABLE `projects` ADD `auto_terms` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `wiki_pages` ADD `origin` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `wiki_pages` ADD `source_chat_id` text REFERENCES chats(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `wiki_pages` ADD `source_message_id` text;