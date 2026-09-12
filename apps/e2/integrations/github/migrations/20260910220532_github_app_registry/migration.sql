CREATE TABLE `github_installations` (
	`installation_id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`account_id` text NOT NULL,
	`account_login` text NOT NULL,
	`target_type` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_setup_sessions` (
	`state_hash` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `github_installations_owner` ON `github_installations` (`owner_id`);--> statement-breakpoint
CREATE INDEX `github_setup_sessions_expiry` ON `github_setup_sessions` (`expires_at`);