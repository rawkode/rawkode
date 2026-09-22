CREATE TABLE `entity_projection_outbox` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`projection_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`label` text,
	`aliases` text NOT NULL,
	`values` text,
	`deleted` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "entity_projection_outbox_aliases_json" CHECK(json_valid("aliases")),
	CONSTRAINT "entity_projection_outbox_values_json" CHECK("values" IS NULL OR json_valid("values"))
);
--> statement-breakpoint
ALTER TABLE `google_records` ADD `source_revision` text;--> statement-breakpoint
ALTER TABLE `google_staging` ADD `source_revision` text;--> statement-breakpoint
CREATE UNIQUE INDEX `entity_projection_outbox_projection` ON `entity_projection_outbox` (`projection_id`);--> statement-breakpoint
CREATE INDEX `entity_projection_outbox_delivery` ON `entity_projection_outbox` (`connection_id`,`sequence`);