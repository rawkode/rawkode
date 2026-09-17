import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

export const oauthApps = sqliteTable(
	"oauth_apps",
	{
		id: text("id"),
		name: text("name").notNull(),
		providerId: text("provider_id").notNull(),
		clientId: text("client_id").notNull(),
		clientSecret: text("client_secret").notNull(),
		scopes: text("scopes").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(
		table,
	) => [
		primaryKey({ columns: [table.id] }),
		check("oauth_apps_scopes_json", sql`json_valid(${table.scopes})`),
	],
);

export const oauthSessions = sqliteTable(
	"oauth_sessions",
	{
		stateHash: text("state_hash"),
		appId: text("app_id").notNull().references(() => oauthApps.id, {
			onDelete: "cascade",
		}),
		ownerId: text("owner_id").notNull(),
		browserBindingHash: text("browser_binding_hash").notNull(),
		verifier: text("verifier").notNull(),
		nonce: text("nonce").notNull(),
		expiresAt: integer("expires_at").notNull(),
	},
	(
		table,
	) => [
		primaryKey({ columns: [table.stateHash] }),
		index("oauth_sessions_expiry").on(table.expiresAt),
	],
);

export const oauthConnections = sqliteTable("oauth_connections", {
	id: text("id"),
	appId: text("app_id").notNull().references(() => oauthApps.id, {
		onDelete: "cascade",
	}),
	ownerId: text("owner_id").notNull(),
	accountId: text("account_id").notNull(),
	accountLabel: text("account_label").notNull(),
	scopes: text("scopes").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	expiresAt: integer("expires_at"),
	status: text("status").notNull().default("connected"),
	version: integer("version").notNull().default(1),
	grantVersion: integer("grant_version").notNull().default(1),
	refreshLease: text("refresh_lease"),
	refreshLeaseUntil: integer("refresh_lease_until"),
	createdAt: integer("created_at").notNull(),
}, (table) => [
	primaryKey({ columns: [table.id] }),
	unique("oauth_connections_account").on(
		table.appId,
		table.ownerId,
		table.accountId,
	),
	index("oauth_connections_owner").on(table.ownerId),
	check("oauth_connections_scopes_json", sql`json_valid(${table.scopes})`),
	check(
		"oauth_connections_status",
		sql`${table.status} IN ('connected', 'reconnect_required')`,
	),
]);

export const oauthServiceGrants = sqliteTable("oauth_service_grants", {
	connectionId: text("connection_id").notNull().references(
		() => oauthConnections.id,
		{ onDelete: "cascade" },
	),
	serviceId: text("service_id").notNull(),
	createdAt: integer("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.connectionId, table.serviceId] })]);
