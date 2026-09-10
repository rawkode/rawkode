import {
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const documents = sqliteTable("documents", {
	id: text().primaryKey(),
	revision: integer().notNull(),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

export const documentChunks = sqliteTable("document_chunks", {
	documentId: text("document_id").notNull().references(() => documents.id, {
		onDelete: "cascade",
	}),
	position: integer().notNull(),
	content: text().notNull(),
}, (table) => [primaryKey({ columns: [table.documentId, table.position] })]);

export const documentEntityRefs = sqliteTable("document_entity_refs", {
	documentId: text("document_id").notNull().references(() => documents.id, {
		onDelete: "cascade",
	}),
	entityId: text("entity_id").notNull(),
}, (table) => [primaryKey({ columns: [table.documentId, table.entityId] })]);
