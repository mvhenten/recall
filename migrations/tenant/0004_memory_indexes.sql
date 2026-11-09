CREATE INDEX `memories_by_user_memory` ON `memories` (`user_id`,`memory_id`);--> statement-breakpoint
CREATE INDEX `memory_tags_by_tag` ON `memory_tags` (`tag`,`memory_id`);