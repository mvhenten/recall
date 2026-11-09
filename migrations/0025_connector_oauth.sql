CREATE TABLE `oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_sha256` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`state` text NOT NULL,
	`code_challenge` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`token_sha256` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
