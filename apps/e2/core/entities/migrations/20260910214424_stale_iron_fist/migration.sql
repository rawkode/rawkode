CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor` text NOT NULL,
	`cause` text NOT NULL,
	`rationale` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`body_document_id` text NOT NULL UNIQUE,
	`archived` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entity_aliases` (
	`entity_id` text NOT NULL,
	`alias` text NOT NULL,
	`normalized` text NOT NULL,
	CONSTRAINT `entity_aliases_pk` PRIMARY KEY(`entity_id`, `normalized`),
	CONSTRAINT `fk_entity_aliases_entity_id_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `entity_redirects` (
	`from_entity_id` text PRIMARY KEY,
	`to_entity_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_entity_redirects_from_entity_id_entities_id_fk` FOREIGN KEY (`from_entity_id`) REFERENCES `entities`(`id`),
	CONSTRAINT `fk_entity_redirects_to_entity_id_entities_id_fk` FOREIGN KEY (`to_entity_id`) REFERENCES `entities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `entity_tags` (
	`entity_id` text NOT NULL,
	`tag_id` text NOT NULL,
	CONSTRAINT `entity_tags_pk` PRIMARY KEY(`entity_id`, `tag_id`),
	CONSTRAINT `fk_entity_tags_entity_id_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`),
	CONSTRAINT `fk_entity_tags_tag_id_supertags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `supertags`(`id`)
);
--> statement-breakpoint
CREATE TABLE `entity_user_values` (
	`entity_id` text NOT NULL,
	`field_id` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `entity_user_values_pk` PRIMARY KEY(`entity_id`, `field_id`),
	CONSTRAINT `fk_entity_user_values_entity_id_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`),
	CONSTRAINT `fk_entity_user_values_field_id_field_definitions_id_fk` FOREIGN KEY (`field_id`) REFERENCES `field_definitions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `field_definitions` (
	`id` text PRIMARY KEY,
	`tag_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`cardinality` text NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`options` text,
	`default_value` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_field_definitions_tag_id_supertags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `supertags`(`id`)
);
--> statement-breakpoint
CREATE TABLE `field_source_preferences` (
	`entity_id` text NOT NULL,
	`field_id` text NOT NULL,
	`provider` text NOT NULL,
	`connection_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	CONSTRAINT `field_source_preferences_pk` PRIMARY KEY(`entity_id`, `field_id`),
	CONSTRAINT `fk_field_source_preferences_entity_id_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`),
	CONSTRAINT `fk_field_source_preferences_field_id_field_definitions_id_fk` FOREIGN KEY (`field_id`) REFERENCES `field_definitions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `source_aliases` (
	`provider` text NOT NULL,
	`connection_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`alias` text NOT NULL,
	`normalized` text NOT NULL,
	CONSTRAINT `source_aliases_pk` PRIMARY KEY(`provider`, `connection_id`, `resource_type`, `resource_id`, `normalized`)
);
--> statement-breakpoint
CREATE TABLE `source_observations` (
	`provider` text NOT NULL,
	`connection_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`label` text NOT NULL,
	`values` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `source_observations_pk` PRIMARY KEY(`provider`, `connection_id`, `resource_type`, `resource_id`),
	CONSTRAINT `fk_source_observations_entity_id_entities_id_fk` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`),
	CONSTRAINT `fk_source_observations_tag_id_supertags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `supertags`(`id`)
);
--> statement-breakpoint
CREATE TABLE `supertags` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`root_id` text NOT NULL,
	`depth` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "supertags_depth" CHECK("depth" >= 0 AND "depth" <= 32)
);
--> statement-breakpoint
CREATE INDEX `audit_events_subject` ON `audit_events` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `entity_aliases_normalized` ON `entity_aliases` (`normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `field_definitions_tag_key` ON `field_definitions` (`tag_id`,`key`);--> statement-breakpoint
CREATE INDEX `source_observations_entity` ON `source_observations` (`entity_id`);--> statement-breakpoint
CREATE INDEX `supertags_parent` ON `supertags` (`parent_id`);--> statement-breakpoint
CREATE INDEX `supertags_root` ON `supertags` (`root_id`);