CREATE TABLE `github_entity_projection_outbox` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`projection_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`tag_id` text NOT NULL,
	`label` text,
	`aliases` text NOT NULL,
	`values` text,
	`deleted` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "github_entity_outbox_aliases_json" CHECK(json_valid("aliases")),
	CONSTRAINT "github_entity_outbox_values_json" CHECK("values" IS NULL OR json_valid("values"))
);
--> statement-breakpoint
CREATE TABLE `github_records` (
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`data` text NOT NULL,
	`source_revision` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`generation` text NOT NULL,
	CONSTRAINT `github_records_pk` PRIMARY KEY(`resource_type`, `resource_id`),
	CONSTRAINT "github_records_data_json" CHECK(json_valid("data"))
);
--> statement-breakpoint
CREATE TABLE `installation_state` (
	`installation_id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`account_id` text NOT NULL,
	`account_login` text NOT NULL,
	`target_type` text NOT NULL,
	`status` text NOT NULL,
	`rate_limit_until` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_success_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `github_repositories` (
	`id` text PRIMARY KEY,
	`node_id` text NOT NULL,
	`owner_login` text NOT NULL,
	`owner_type` text NOT NULL,
	`name` text NOT NULL,
	`full_name` text NOT NULL,
	`url` text NOT NULL,
	`private` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`generation` text NOT NULL,
	`source_revision` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_sync_cursors` (
	`kind` text NOT NULL,
	`repository_id` text DEFAULT '' NOT NULL,
	`cursor` text,
	`generation` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `github_sync_cursors_pk` PRIMARY KEY(`kind`, `repository_id`)
);
--> statement-breakpoint
CREATE TABLE `github_webhook_deliveries` (
	`id` text PRIMARY KEY,
	`event` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_entity_outbox_projection` ON `github_entity_projection_outbox` (`projection_id`);--> statement-breakpoint
CREATE INDEX `github_entity_outbox_delivery` ON `github_entity_projection_outbox` (`sequence`);--> statement-breakpoint
CREATE INDEX `github_records_repository` ON `github_records` (`repository_id`,`resource_type`);