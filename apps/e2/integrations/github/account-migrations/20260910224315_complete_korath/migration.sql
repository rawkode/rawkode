CREATE TABLE `github_record_repositories` (
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`repository_id` text NOT NULL,
	CONSTRAINT `github_record_repositories_pk` PRIMARY KEY(`resource_type`, `resource_id`, `repository_id`)
);
--> statement-breakpoint
CREATE INDEX `github_record_repositories_repository` ON `github_record_repositories` (`repository_id`);