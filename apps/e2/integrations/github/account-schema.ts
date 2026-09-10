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

export const installationState = sqliteTable("installation_state", {
	installationId: text("installation_id").primaryKey(),
	ownerId: text("owner_id").notNull(),
	accountId: text("account_id").notNull(),
	accountLogin: text("account_login").notNull(),
	targetType: text("target_type").notNull(),
	status: text().notNull(),
	rateLimitUntil: integer("rate_limit_until"),
	failures: integer().notNull().default(0),
	lastSuccessAt: integer("last_success_at"),
	lastError: text("last_error"),
});

export const repositories = sqliteTable("github_repositories", {
	id: text().primaryKey(),
	nodeId: text("node_id").notNull(),
	ownerLogin: text("owner_login").notNull(),
	ownerType: text("owner_type").notNull(),
	name: text().notNull(),
	fullName: text("full_name").notNull(),
	url: text().notNull(),
	private: integer({ mode: "boolean" }).notNull(),
	active: integer({ mode: "boolean" }).notNull().default(true),
	generation: text().notNull(),
	sourceRevision: text("source_revision").notNull(),
});

export const syncCursors = sqliteTable("github_sync_cursors", {
	kind: text().notNull(),
	repositoryId: text("repository_id").notNull().default(""),
	cursor: text(),
	generation: text().notNull(),
	status: text().notNull(),
	updatedAt: integer("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.kind, table.repositoryId] })]);

export const githubRecords = sqliteTable("github_records", {
	resourceType: text("resource_type").notNull(),
	resourceId: text("resource_id").notNull(),
	repositoryId: text("repository_id").notNull(),
	data: text().notNull(),
	sourceRevision: text("source_revision").notNull(),
	active: integer({ mode: "boolean" }).notNull().default(true),
	generation: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.resourceType, table.resourceId] }),
	index("github_records_repository").on(table.repositoryId, table.resourceType),
	check("github_records_data_json", sql`json_valid(${table.data})`),
]);

export const webhookDeliveries = sqliteTable("github_webhook_deliveries", {
	id: text().primaryKey(),
	event: text().notNull(),
	receivedAt: integer("received_at").notNull(),
	processed: integer({ mode: "boolean" }).notNull().default(false),
});

export const entityProjectionOutbox = sqliteTable(
	"github_entity_projection_outbox",
	{
		sequence: integer().primaryKey({ autoIncrement: true }),
		projectionId: text("projection_id").notNull(),
		resourceType: text("resource_type").notNull(),
		resourceId: text("resource_id").notNull(),
		sourceRevision: text("source_revision").notNull(),
		tagId: text("tag_id").notNull(),
		label: text(),
		aliases: text().notNull(),
		values: text(),
		deleted: integer({ mode: "boolean" }).notNull().default(false),
		attempts: integer().notNull().default(0),
		lastError: text("last_error"),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("github_entity_outbox_projection").on(table.projectionId),
		index("github_entity_outbox_delivery").on(table.sequence),
		check(
			"github_entity_outbox_aliases_json",
			sql`json_valid(${table.aliases})`,
		),
		check(
			"github_entity_outbox_values_json",
			sql`${table.values} IS NULL OR json_valid(${table.values})`,
		),
	],
);
