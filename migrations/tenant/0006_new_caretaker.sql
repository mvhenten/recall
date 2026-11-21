CREATE TABLE `inbox_counters` (
	`user_id` text PRIMARY KEY NOT NULL,
	`high_water` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbox_messages` (
	`user_id` text NOT NULL,
	`id` integer NOT NULL,
	`sender` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`link` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`read_at` integer,
	PRIMARY KEY(`user_id`, `id`)
);
