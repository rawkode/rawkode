CREATE TABLE `document_entity_refs` (
	`document_id` text NOT NULL,
	`entity_id` text NOT NULL,
	CONSTRAINT `document_entity_refs_pk` PRIMARY KEY(`document_id`, `entity_id`),
	CONSTRAINT `fk_document_entity_refs_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE CASCADE
);
