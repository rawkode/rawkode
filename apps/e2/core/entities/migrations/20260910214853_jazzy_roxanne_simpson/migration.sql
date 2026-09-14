ALTER TABLE `entities` ADD `normalized_label` text NOT NULL;--> statement-breakpoint
CREATE INDEX `entities_normalized_label` ON `entities` (`normalized_label`);