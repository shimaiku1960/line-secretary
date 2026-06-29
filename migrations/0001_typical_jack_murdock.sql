ALTER TABLE `tasks` ADD `due_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `reminded` integer DEFAULT 0 NOT NULL;