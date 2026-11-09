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
	`state_sent` integer NOT NULL,
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
--> statement-breakpoint
-- The four tables above are written by requests carrying no credential of this service, so each
-- one is swept rather than left to grow: the three with an expiry by the next write that needs
-- them, and the registrations by the registration that follows. These indexes are what make those
-- sweeps a range read instead of a scan of the table. They are hand-written, as every index here
-- is, because drizzle's SQLite schema says nothing about them.
CREATE INDEX oauth_requests_by_expiry ON oauth_requests (expires_at);--> statement-breakpoint
CREATE INDEX oauth_codes_by_expiry ON oauth_codes (expires_at);--> statement-breakpoint
CREATE INDEX oauth_tokens_by_expiry ON oauth_tokens (expires_at);--> statement-breakpoint
CREATE INDEX oauth_clients_by_age ON oauth_clients (created_at);--> statement-breakpoint
-- Which client a token or a pending authorization belongs to, which is how the registration sweep
-- asks whether a row still has either, and how the deploy drops the tokens of a withdrawn user.
CREATE INDEX oauth_tokens_by_client ON oauth_tokens (client_id);--> statement-breakpoint
CREATE INDEX oauth_tokens_by_user ON oauth_tokens (user_id);--> statement-breakpoint
CREATE INDEX oauth_requests_by_client ON oauth_requests (client_id);
