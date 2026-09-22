import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";

// Captured before the undeployed workspace's SQL was replaced by Drizzle output.
// Column signature: name | type | not-null | default | primary-key position.
const originalSchema = {
	"integrations-oauth": {
		"oauth_apps": {
			"columns": [
				"id|TEXT|0||1",
				"name|TEXT|1||0",
				"provider_id|TEXT|1||0",
				"client_id|TEXT|1||0",
				"client_secret|TEXT|1||0",
				"scopes|TEXT|1||0",
				"created_at|INTEGER|1||0",
			],
			"foreignKeys": [],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"id",
					],
				},
			],
		},
		"oauth_connections": {
			"columns": [
				"id|TEXT|0||1",
				"app_id|TEXT|1||0",
				"owner_id|TEXT|1||0",
				"account_id|TEXT|1||0",
				"account_label|TEXT|1||0",
				"scopes|TEXT|1||0",
				"access_token|TEXT|0||0",
				"refresh_token|TEXT|0||0",
				"expires_at|INTEGER|0||0",
				"status|TEXT|1|'connected'|0",
				"version|INTEGER|1|1|0",
				"refresh_lease|TEXT|0||0",
				"refresh_lease_until|INTEGER|0||0",
				"created_at|INTEGER|1||0",
			],
			"foreignKeys": [
				[
					"oauth_apps",
					"app_id",
					"id",
					"NO ACTION",
					"CASCADE",
					"NONE",
				],
			],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"app_id",
						"owner_id",
						"account_id",
					],
				},
				{
					"unique": true,
					"columns": [
						"id",
					],
				},
				{
					"unique": false,
					"columns": [
						"owner_id",
					],
				},
			],
		},
		"oauth_service_grants": {
			"columns": [
				"connection_id|TEXT|1||1",
				"service_id|TEXT|1||2",
				"created_at|INTEGER|1||0",
			],
			"foreignKeys": [
				[
					"oauth_connections",
					"connection_id",
					"id",
					"NO ACTION",
					"CASCADE",
					"NONE",
				],
			],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"connection_id",
						"service_id",
					],
				},
			],
		},
		"oauth_sessions": {
			"columns": [
				"state_hash|TEXT|0||1",
				"app_id|TEXT|1||0",
				"owner_id|TEXT|1||0",
				"browser_binding_hash|TEXT|1||0",
				"verifier|TEXT|1||0",
				"nonce|TEXT|1||0",
				"expires_at|INTEGER|1||0",
			],
			"foreignKeys": [
				[
					"oauth_apps",
					"app_id",
					"id",
					"NO ACTION",
					"CASCADE",
					"NONE",
				],
			],
			"indexes": [
				{
					"unique": false,
					"columns": [
						"expires_at",
					],
				},
				{
					"unique": true,
					"columns": [
						"state_hash",
					],
				},
			],
		},
	},
	"integrations-google": {
		"calendar_events": {
			"columns": [
				"connection_id|TEXT|1||1",
				"event_id|TEXT|1||2",
				"data|TEXT|1||0",
			],
			"foreignKeys": [
				[
					"calendar_syncs",
					"connection_id",
					"connection_id",
					"NO ACTION",
					"CASCADE",
					"NONE",
				],
			],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"connection_id",
						"event_id",
					],
				},
			],
		},
		"calendar_staging": {
			"columns": [
				"run_id|TEXT|1||1",
				"event_id|TEXT|1||2",
				"data|TEXT|1||0",
				"cancelled|INTEGER|1||0",
			],
			"foreignKeys": [],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"run_id",
						"event_id",
					],
				},
			],
		},
		"calendar_syncs": {
			"columns": [
				"connection_id|TEXT|0||1",
				"owner_id|TEXT|1||0",
				"sync_token|TEXT|0||0",
				"synced_at|INTEGER|0||0",
				"lease|TEXT|0||0",
				"lease_until|INTEGER|0||0",
			],
			"foreignKeys": [],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"connection_id",
					],
				},
			],
		},
		"gmail_watches": {
			"columns": [
				"connection_id|TEXT|0||1",
				"email|TEXT|1||0",
				"expiration|INTEGER|1||0",
				"history_id|TEXT|1||0",
				"notified_at|INTEGER|0||0",
				"renewed_at|INTEGER|1||0",
			],
			"foreignKeys": [],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"connection_id",
					],
				},
			],
		},
		"google_records": {
			"columns": [
				"connection_id|TEXT|1||1",
				"collection|TEXT|1||2",
				"resource_id|TEXT|1||3",
				"data|TEXT|1||0",
				"deleted|INTEGER|1|0|0",
			],
			"foreignKeys": [],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"connection_id",
						"collection",
						"resource_id",
					],
				},
			],
		},
		"google_staging": {
			"columns": [
				"generation|TEXT|1||1",
				"resource_id|TEXT|1||2",
				"data|TEXT|1||0",
				"deleted|INTEGER|1||0",
			],
			"foreignKeys": [],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"generation",
						"resource_id",
					],
				},
			],
		},
		"google_syncs": {
			"columns": [
				"connection_id|TEXT|1||1",
				"collection|TEXT|1||2",
				"owner_id|TEXT|1||0",
				"sync_token|TEXT|0||0",
				"page_token|TEXT|0||0",
				"generation|TEXT|1||0",
				"synced_at|INTEGER|0||0",
				"lease|TEXT|0||0",
				"lease_until|INTEGER|0||0",
			],
			"foreignKeys": [],
			"indexes": [
				{
					"unique": true,
					"columns": [
						"connection_id",
						"collection",
					],
				},
			],
		},
	},
} as const;

const initialDatabase = async (worker: string) => {
	const directory = new URL(
		`../integrations/${worker.replace("integrations-", "")}/migrations/`,
		import.meta.url,
	);
	const initial = [];
	for await (const entry of Deno.readDir(directory)) {
		if (entry.isDirectory && /^\d{14}_initial$/.test(entry.name)) {
			initial.push(entry.name);
		}
	}
	assert.equal(
		initial.length,
		1,
		"Expected exactly one initial baseline migration",
	);
	const sql = await Deno.readTextFile(
		new URL(`${initial[0]}/migration.sql`, directory),
	);
	const database = new DatabaseSync(":memory:");
	try {
		database.exec("PRAGMA foreign_keys = ON");
		database.exec(sql);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
};

Deno.test("Drizzle baselines preserve existing columns, keys, indexes, defaults, and foreign keys", async () => {
	for (const [worker, tables] of Object.entries(originalSchema)) {
		const database = await initialDatabase(worker);
		try {
			const names = database.prepare(
				"SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
			).all().map((row) => row.name);
			assert.deepEqual(names, Object.keys(tables));
			for (const [name, expected] of Object.entries(tables)) {
				const columns = database.prepare(`PRAGMA table_info(${name})`).all()
					.map((column) =>
						[
							column.name,
							column.type,
							column.notnull,
							column.dflt_value,
							column.pk,
						].map((value) => value ?? "").join("|")
					);
				const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${name})`)
					.all().map((
						key,
					) => [
						key.table,
						key.from,
						key.to,
						key.on_update,
						key.on_delete,
						key.match,
					]);
				const indexes = database.prepare(`PRAGMA index_list(${name})`).all()
					.map((index) => ({
						unique: Boolean(index.unique),
						columns: database.prepare(`PRAGMA index_info(${index.name})`).all()
							.map((column) => column.name),
					})).sort((a, b) =>
						JSON.stringify(a.columns).localeCompare(JSON.stringify(b.columns))
					);
				assert.deepEqual(
					{ columns, foreignKeys, indexes },
					expected,
					`${worker}/${name}`,
				);
			}
		} finally {
			database.close();
		}
	}
});

Deno.test("OAuth initial migration enforces JSON, status, account uniqueness, and cascading grants", async () => {
	const database = await initialDatabase("integrations-oauth");
	try {
		const app = database.prepare(
			"INSERT INTO oauth_apps(id,name,provider_id,client_id,client_secret,scopes,created_at) VALUES (?, 'Google', 'google', 'client', 'secret', ?, 0)",
		);
		assert.throws(() => app.run("bad", "not-json"), /CHECK constraint/);
		app.run("app", "[]");
		const connection = database.prepare(
			"INSERT INTO oauth_connections(id,app_id,owner_id,account_id,account_label,scopes,created_at) VALUES (?, 'app', 'owner', 'account', 'user@example.com', ?, 0)",
		);
		assert.throws(() => connection.run("bad", "not-json"), /CHECK constraint/);
		connection.run("connection", "[]");
		assert.throws(() => connection.run("duplicate", "[]"), /UNIQUE constraint/);
		assert.throws(
			() => database.exec("UPDATE oauth_connections SET status = 'invalid'"),
			/CHECK constraint/,
		);
		database.exec(
			"INSERT INTO oauth_service_grants VALUES ('connection', 'integrations-google', 0)",
		);
		assert.throws(
			() =>
				database.exec(
					"INSERT INTO oauth_service_grants VALUES ('missing', 'integrations-google', 0)",
				),
			/FOREIGN KEY constraint/,
		);
		database.exec("DELETE FROM oauth_apps WHERE id = 'app'");
		assert.equal(
			database.prepare("SELECT COUNT(*) AS count FROM oauth_connections").get()
				?.count,
			0,
		);
		assert.equal(
			database.prepare("SELECT COUNT(*) AS count FROM oauth_service_grants")
				.get()?.count,
			0,
		);
	} finally {
		database.close();
	}
});

Deno.test("Google initial migration enforces JSON and cascading calendar events", async () => {
	const database = await initialDatabase("integrations-google");
	try {
		database.exec(
			"INSERT INTO calendar_syncs(connection_id,owner_id) VALUES ('connection', 'owner')",
		);
		const event = database.prepare(
			"INSERT INTO calendar_events VALUES ('connection', 'event', ?)",
		);
		assert.throws(() => event.run("not-json"), /CHECK constraint/);
		event.run("{}");
		assert.throws(
			() =>
				database.exec(
					"INSERT INTO calendar_staging VALUES ('run', 'event', 'invalid', 0)",
				),
			/CHECK constraint/,
		);
		assert.throws(
			() =>
				database.exec(
					"INSERT INTO google_records(connection_id,collection,resource_id,data) VALUES ('connection', 'contacts', 'contact', 'invalid')",
				),
			/CHECK constraint/,
		);
		assert.throws(
			() =>
				database.exec(
					"INSERT INTO google_staging VALUES ('generation', 'resource', 'invalid', 0)",
				),
			/CHECK constraint/,
		);
		database.exec(
			"DELETE FROM calendar_syncs WHERE connection_id = 'connection'",
		);
		assert.equal(
			database.prepare("SELECT COUNT(*) AS count FROM calendar_events").get()
				?.count,
			0,
		);
	} finally {
		database.close();
	}
});
