import { sql } from "drizzle-orm";
import {
	check,
	integer,
	primaryKey,
	sqliteTable,
	text,
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
	},
	(
		table,
	) => [
		primaryKey({ columns: [table.generation, table.resourceId] }),
		check("google_staging_data_json", sql`json_valid(${table.data})`),
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
