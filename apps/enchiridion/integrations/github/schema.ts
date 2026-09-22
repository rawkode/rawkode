import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const githubInstallations = sqliteTable("github_installations", {
	installationId: text("installation_id").primaryKey(),
	ownerId: text("owner_id").notNull(),
	accountId: text("account_id").notNull(),
	accountLogin: text("account_login").notNull(),
	targetType: text("target_type").notNull(),
	status: text().notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
}, (table) => [index("github_installations_owner").on(table.ownerId)]);

export const githubSetupSessions = sqliteTable("github_setup_sessions", {
	stateHash: text("state_hash").primaryKey(),
	ownerId: text("owner_id").notNull(),
	expiresAt: integer("expires_at").notNull(),
}, (table) => [index("github_setup_sessions_expiry").on(table.expiresAt)]);
