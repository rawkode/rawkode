CREATE TABLE `oauth_apps` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`provider_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "oauth_apps_scopes_json" CHECK(json_valid("scopes"))
);
--> statement-breakpoint
CREATE TABLE `oauth_connections` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`account_id` text NOT NULL,
	`account_label` text NOT NULL,
	`scopes` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`expires_at` integer,
	`status` text DEFAULT 'connected' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`refresh_lease` text,
	`refresh_lease_until` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_oauth_connections_app_id_oauth_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `oauth_apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `oauth_connections_account` UNIQUE(`app_id`,`owner_id`,`account_id`),
	CONSTRAINT "oauth_connections_scopes_json" CHECK(json_valid("scopes")),
	CONSTRAINT "oauth_connections_status" CHECK("status" IN ('connected', 'reconnect_required'))
);
--> statement-breakpoint
CREATE TABLE `oauth_service_grants` (
	`connection_id` text NOT NULL,
	`service_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `oauth_service_grants_pk` PRIMARY KEY(`connection_id`, `service_id`),
	CONSTRAINT `fk_oauth_service_grants_connection_id_oauth_connections_id_fk` FOREIGN KEY (`connection_id`) REFERENCES `oauth_connections`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `oauth_sessions` (
	`state_hash` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`browser_binding_hash` text NOT NULL,
	`verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_oauth_sessions_app_id_oauth_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `oauth_apps`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `oauth_connections_owner` ON `oauth_connections` (`owner_id`);--> statement-breakpoint
CREATE INDEX `oauth_sessions_expiry` ON `oauth_sessions` (`expires_at`);