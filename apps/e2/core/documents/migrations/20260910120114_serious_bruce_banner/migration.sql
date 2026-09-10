CREATE TABLE `document_chunks` (
	`document_id` text NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	CONSTRAINT `document_chunks_pk` PRIMARY KEY(`document_id`, `position`),
	CONSTRAINT `fk_document_chunks_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
