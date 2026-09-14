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

export const calendarSyncs = sqliteTable("calendar_syncs", {
	connectionId: text("connection_id"),
	ownerId: text("owner_id").notNull(),
	syncToken: text("sync_token"),
	syncedAt: integer("synced_at"),
	lease: text("lease"),
	leaseUntil: integer("lease_until"),
}, (table) => [primaryKey({ columns: [table.connectionId] })]);

export const calendarEvents = sqliteTable(
	"calendar_events",
	{
		connectionId: text("connection_id").notNull().references(
			() => calendarSyncs.connectionId,
			{ onDelete: "cascade" },
		),
		eventId: text("event_id").notNull(),
		data: text("data").notNull(),
	},
	(
		table,
	) => [
		primaryKey({ columns: [table.connectionId, table.eventId] }),
		check("calendar_events_data_json", sql`json_valid(${table.data})`),
	],
);

export const calendarStaging = sqliteTable(
	"calendar_staging",
	{
		runId: text("run_id").notNull(),
		eventId: text("event_id").notNull(),
		data: text("data").notNull(),
		cancelled: integer("cancelled").notNull(),
	},
	(
		table,
	) => [
		primaryKey({ columns: [table.runId, table.eventId] }),
		check("calendar_staging_data_json", sql`json_valid(${table.data})`),
	],
);

export const googleSyncs = sqliteTable(
	"google_syncs",
	{
		connectionId: text("connection_id").notNull(),
		collection: text("collection").notNull(),
		ownerId: text("owner_id").notNull(),
		syncToken: text("sync_token"),
		pageToken: text("page_token"),
		generation: text("generation").notNull(),
		syncedAt: integer("synced_at"),
		lease: text("lease"),
		leaseUntil: integer("lease_until"),
	},
	(table) => [primaryKey({ columns: [table.connectionId, table.collection] })],
);

export const googleRecords = sqliteTable(
	"google_records",
	{
		connectionId: text("connection_id").notNull(),
		collection: text("collection").notNull(),
		resourceId: text("resource_id").notNull(),
		data: text("data").notNull(),
		deleted: integer("deleted").notNull().default(0),
		sourceRevision: text("source_revision"),
	},
	(
		table,
	) => [
		primaryKey({
			columns: [table.connectionId, table.collection, table.resourceId],
		}),
		check("google_records_data_json", sql`json_valid(${table.data})`),
	],
);

export const googleStaging = sqliteTable(
	"google_staging",
	{
		generation: text("generation").notNull(),
		resourceId: text("resource_id").notNull(),
		data: text("data").notNull(),
		deleted: integer("deleted").notNull(),
		sourceRevision: text("source_revision"),
	},
	(
		table,
	) => [
		primaryKey({ columns: [table.generation, table.resourceId] }),
		check("google_staging_data_json", sql`json_valid(${table.data})`),
	],
);

/**
 * Provider pages and projection intents commit together. Delivery is a separate,
 * retryable cross-Durable-Object effect keyed by the stable projection ID.
 */
export const entityProjectionOutbox = sqliteTable(
	"entity_projection_outbox",
	{
		sequence: integer().primaryKey({ autoIncrement: true }),
		projectionId: text("projection_id").notNull(),
		connectionId: text("connection_id").notNull(),
		ownerId: text("owner_id").notNull(),
		resourceType: text("resource_type").notNull(),
		resourceId: text("resource_id").notNull(),
		sourceRevision: text("source_revision").notNull(),
		label: text(),
		aliases: text().notNull(),
		values: text(),
		deleted: integer({ mode: "boolean" }).notNull().default(false),
		attempts: integer().notNull().default(0),
		lastError: text("last_error"),
		quarantinedAt: integer("quarantined_at"),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("entity_projection_outbox_projection").on(table.projectionId),
		index("entity_projection_outbox_active_delivery").on(
			table.connectionId,
			table.quarantinedAt,
			table.sequence,
		),
		check(
			"entity_projection_outbox_aliases_json",
			sql`json_valid(${table.aliases})`,
		),
		check(
			"entity_projection_outbox_values_json",
			sql`${table.values} IS NULL OR json_valid(${table.values})`,
		),
	],
);

export const gmailWatches = sqliteTable("gmail_watches", {
	connectionId: text("connection_id"),
	email: text("email").notNull(),
	expiration: integer("expiration").notNull(),
	historyId: text("history_id").notNull(),
	notifiedAt: integer("notified_at"),
	renewedAt: integer("renewed_at").notNull(),
}, (table) => [primaryKey({ columns: [table.connectionId] })]);
