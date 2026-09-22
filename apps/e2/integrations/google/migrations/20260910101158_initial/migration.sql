CREATE TABLE `calendar_events` (
	`connection_id` text NOT NULL,
	`event_id` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `calendar_events_pk` PRIMARY KEY(`connection_id`, `event_id`),
	CONSTRAINT `fk_calendar_events_connection_id_calendar_syncs_connection_id_fk` FOREIGN KEY (`connection_id`) REFERENCES `calendar_syncs`(`connection_id`) ON DELETE CASCADE,
	CONSTRAINT "calendar_events_data_json" CHECK(json_valid("data"))
);
--> statement-breakpoint
CREATE TABLE `calendar_staging` (
	`run_id` text NOT NULL,
	`event_id` text NOT NULL,
	`data` text NOT NULL,
	`cancelled` integer NOT NULL,
	CONSTRAINT `calendar_staging_pk` PRIMARY KEY(`run_id`, `event_id`),
	CONSTRAINT "calendar_staging_data_json" CHECK(json_valid("data"))
);
--> statement-breakpoint
CREATE TABLE `calendar_syncs` (
	`connection_id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`sync_token` text,
	`synced_at` integer,
	`lease` text,
	`lease_until` integer
);
--> statement-breakpoint
CREATE TABLE `gmail_watches` (
	`connection_id` text PRIMARY KEY,
	`email` text NOT NULL,
	`expiration` integer NOT NULL,
	`history_id` text NOT NULL,
	`notified_at` integer,
	`renewed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `google_records` (
	`connection_id` text NOT NULL,
	`collection` text NOT NULL,
	`resource_id` text NOT NULL,
	`data` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `google_records_pk` PRIMARY KEY(`connection_id`, `collection`, `resource_id`),
	CONSTRAINT "google_records_data_json" CHECK(json_valid("data"))
);
--> statement-breakpoint
CREATE TABLE `google_staging` (
	`generation` text NOT NULL,
	`resource_id` text NOT NULL,
	`data` text NOT NULL,
	`deleted` integer NOT NULL,
	CONSTRAINT `google_staging_pk` PRIMARY KEY(`generation`, `resource_id`),
	CONSTRAINT "google_staging_data_json" CHECK(json_valid("data"))
);
--> statement-breakpoint
CREATE TABLE `google_syncs` (
	`connection_id` text NOT NULL,
	`collection` text NOT NULL,
	`owner_id` text NOT NULL,
	`sync_token` text,
	`page_token` text,
	`generation` text NOT NULL,
	`synced_at` integer,
	`lease` text,
	`lease_until` integer,
	CONSTRAINT `google_syncs_pk` PRIMARY KEY(`connection_id`, `collection`)
);
