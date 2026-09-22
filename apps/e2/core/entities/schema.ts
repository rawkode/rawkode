import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const supertags = sqliteTable("supertags", {
	id: text().primaryKey(),
	name: text().notNull(),
	kind: text({ enum: ["base", "integration", "user"] }).notNull(),
	parentId: text("parent_id"),
	rootId: text("root_id").notNull(),
	depth: integer().notNull(),
	revision: integer().notNull().default(1),
	archived: integer({ mode: "boolean" }).notNull().default(false),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
}, (table) => [
	check("supertags_depth", sql`${table.depth} >= 0 AND ${table.depth} <= 32`),
	index("supertags_parent").on(table.parentId),
	index("supertags_root").on(table.rootId),
]);

export const fieldDefinitions = sqliteTable(
	"field_definitions",
	{
		id: text().primaryKey(),
		tagId: text("tag_id").notNull().references(() => supertags.id),
		key: text().notNull(),
		label: text().notNull(),
		type: text().notNull(),
		cardinality: text().notNull(),
		required: integer({ mode: "boolean" }).notNull().default(false),
		options: text(),
		defaultValue: text("default_value"),
		archived: integer({ mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(
		table,
	) => [uniqueIndex("field_definitions_tag_key").on(table.tagId, table.key)],
);

export const entities = sqliteTable("entities", {
	id: text().primaryKey(),
	label: text().notNull(),
	normalizedLabel: text("normalized_label").notNull(),
	bodyDocumentId: text("body_document_id").notNull().unique(),
	archived: integer({ mode: "boolean" }).notNull().default(false),
	revision: integer().notNull().default(1),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
}, (table) => [index("entities_normalized_label").on(table.normalizedLabel)]);

export const entityTags = sqliteTable("entity_tags", {
	entityId: text("entity_id").notNull().references(() => entities.id),
	tagId: text("tag_id").notNull().references(() => supertags.id),
}, (table) => [primaryKey({ columns: [table.entityId, table.tagId] })]);

export const entityAliases = sqliteTable("entity_aliases", {
	entityId: text("entity_id").notNull().references(() => entities.id),
	alias: text().notNull(),
	normalized: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.entityId, table.normalized] }),
	index("entity_aliases_normalized").on(table.normalized),
]);

export const entityUserValues = sqliteTable("entity_user_values", {
	entityId: text("entity_id").notNull().references(() => entities.id),
	fieldId: text("field_id").notNull().references(() => fieldDefinitions.id),
	value: text().notNull(),
}, (table) => [primaryKey({ columns: [table.entityId, table.fieldId] })]);

export const sourceObservations = sqliteTable("source_observations", {
	provider: text().notNull(),
	connectionId: text("connection_id").notNull(),
	resourceType: text("resource_type").notNull(),
	resourceId: text("resource_id").notNull(),
	entityId: text("entity_id").notNull().references(() => entities.id),
	tagId: text("tag_id").notNull().references(() => supertags.id),
	sourceRevision: text("source_revision").notNull(),
	label: text().notNull(),
	values: text().notNull(),
	active: integer({ mode: "boolean" }).notNull().default(true),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
}, (table) => [
	primaryKey({
		columns: [
			table.provider,
			table.connectionId,
			table.resourceType,
			table.resourceId,
		],
	}),
	index("source_observations_entity").on(table.entityId),
]);

export const sourceAliases = sqliteTable("source_aliases", {
	provider: text().notNull(),
	connectionId: text("connection_id").notNull(),
	resourceType: text("resource_type").notNull(),
	resourceId: text("resource_id").notNull(),
	alias: text().notNull(),
	normalized: text().notNull(),
}, (table) => [
	primaryKey({
		columns: [
			table.provider,
			table.connectionId,
			table.resourceType,
			table.resourceId,
			table.normalized,
		],
	}),
	index("source_aliases_normalized").on(table.normalized),
]);

export const fieldSourcePreferences = sqliteTable("field_source_preferences", {
	entityId: text("entity_id").notNull().references(() => entities.id),
	fieldId: text("field_id").notNull().references(() => fieldDefinitions.id),
	provider: text().notNull(),
	connectionId: text("connection_id").notNull(),
	resourceType: text("resource_type").notNull(),
	resourceId: text("resource_id").notNull(),
}, (table) => [primaryKey({ columns: [table.entityId, table.fieldId] })]);

export const entityRedirects = sqliteTable("entity_redirects", {
	fromEntityId: text("from_entity_id").primaryKey().references(() =>
		entities.id
	),
	toEntityId: text("to_entity_id").notNull().references(() => entities.id),
	createdAt: text("created_at").notNull(),
});

export const auditEvents = sqliteTable(
	"audit_events",
	{
		id: text().primaryKey(),
		subjectType: text("subject_type").notNull(),
		subjectId: text("subject_id").notNull(),
		revision: integer().notNull(),
		actor: text().notNull(),
		cause: text().notNull(),
		rationale: text().notNull(),
		createdAt: text("created_at").notNull(),
	},
	(
		table,
	) => [index("audit_events_subject").on(table.subjectType, table.subjectId)],
);
