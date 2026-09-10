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
