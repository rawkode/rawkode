import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect } from "expect";
import {
	accountStorage,
	migrateAccount,
} from "../integrations/google/src/storage.ts";

const initialId = "20260910101158_initial";
const initialSQL = await Deno.readTextFile(
	new URL(
		`../integrations/google/migrations/${initialId}/migration.sql`,
		import.meta.url,
	),
);
const migrationConfig = { migrations: { [initialId]: initialSQL } };

const storageFixture = () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	let alarm: number | null = null;
	const storage = {
		sql: {
			exec: (sql: string, ...values: SQLInputValue[]) => {
				const rows = sqlite.prepare(sql).all(...values);
				return {
					toArray: () => rows,
					raw: () => ({ toArray: () => rows.map((row) => Object.values(row)) }),
					one: () => {
						if (rows.length !== 1) throw new Error("Expected one row");
						return rows[0];
					},
				};
			},
		},
		transactionSync: <T>(action: () => T): T => {
			sqlite.exec("SAVEPOINT test_transaction");
			try {
				const result = action();
				sqlite.exec("RELEASE test_transaction");
				return result;
			} catch (error) {
				sqlite.exec("ROLLBACK TO test_transaction");
				sqlite.exec("RELEASE test_transaction");
				throw error;
			}
		},
		getAlarm: () => Promise.resolve(alarm),
		setAlarm: (time: number) => {
			alarm = time;
			return Promise.resolve();
		},
		deleteAlarm: () => {
			alarm = null;
			return Promise.resolve();
		},
	} as unknown as DurableObjectStorage;
	return { sqlite, storage };
};

Deno.test("account SQLite migrations are idempotent and record batches roll back atomically", async () => {
	const { sqlite, storage } = storageFixture();
	try {
		migrateAccount(storage, migrationConfig);
		migrateAccount(storage, migrationConfig);
		const { db } = accountStorage(storage);
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()
				?.count,
		).toBe(1);
		await db.prepare("INSERT INTO google_records VALUES (?, ?, ?, ?, ?)").bind(
			"account",
			"contacts",
			"one",
			'{"name":"First"}',
			0,
		).run();
		await expect(db.batch([
			db.prepare("INSERT INTO google_records VALUES (?, ?, ?, ?, ?)").bind(
				"account",
				"contacts",
				"two",
				"{}",
				0,
			),
			db.prepare("INSERT INTO google_records VALUES (?, ?, ?, ?, ?)").bind(
				"account",
				"contacts",
				"invalid",
				"invalid JSON",
				0,
			),
		])).rejects.toThrow();
		expect(
			(await db.prepare("SELECT resource_id FROM google_records").all())
				.results,
		).toEqual([{ resource_id: "one" }]);
	} finally {
		sqlite.close();
	}
});

Deno.test("account deletion clears all personal data and fences stale writes, alarms and restarts", async () => {
	const { sqlite, storage } = storageFixture();
	try {
		migrateAccount(storage, migrationConfig);
		const account = accountStorage(storage);
		await account.coordinator.put("connection", "account");
		await account.coordinator.setAlarm(Date.now() + 1000);
		await account.db.prepare(
			"INSERT INTO google_records VALUES (?, ?, ?, ?, ?)",
		).bind("account", "contacts", "one", "{}", 0).run();
		await account.db.prepare(
			"INSERT INTO gmail_watches(connection_id,email,expiration,history_id,renewed_at) VALUES ('account','person@example.test',1,'1',1)",
		).run();
		const staleWrite = account.db.prepare(
			"INSERT INTO google_records VALUES (?, ?, ?, ?, ?)",
		).bind("account", "contacts", "late", "{}", 0);
		await account.remove(1);
		await account.remove();
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM google_records").get()
				?.count,
		).toBe(0);
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM gmail_watches").get()
				?.count,
		).toBe(0);
		expect(await storage.getAlarm()).toBe(null);
		await expect(staleWrite.run()).rejects.toThrow("deleted");
		await expect(account.coordinator.put("failures", 1)).rejects.toThrow(
			"deleted",
		);
		expect(() => account.coordinator.setAlarm(Date.now())).toThrow("deleted");
		migrateAccount(storage, migrationConfig);
		const restarted = accountStorage(storage);
		expect(restarted.deleted()).toBe(true);
		expect(() => restarted.assertActive()).toThrow("deleted");
		expect(await restarted.coordinator.get("connection")).toBeUndefined();
		await expect(restarted.db.prepare("SELECT * FROM google_records").all())
			.rejects.toThrow("deleted");
		expect(() => restarted.revive(1)).toThrow("deleted");
		restarted.revive(2);
		expect(restarted.deleted()).toBe(false);
		await restarted.coordinator.put("connection", "account");
	} finally {
		sqlite.close();
	}
});

const seedLegacy = (sqlite: DatabaseSync) => {
	sqlite.exec(initialSQL);
	sqlite.exec("CREATE TABLE __account_migrations (id TEXT PRIMARY KEY)");
	sqlite.prepare("INSERT INTO __account_migrations VALUES (?)").run(initialId);
	sqlite.exec(
		"CREATE TABLE IF NOT EXISTS __account_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	);
	sqlite.exec(
		"INSERT INTO google_records VALUES ('account','contacts','person','{}',0)",
	);
	sqlite.exec("INSERT INTO __account_state VALUES ('deleted','true')");
};
Deno.test("legacy baseline adoption preserves contacts and deletion fence without replay", () => {
	const { sqlite, storage } = storageFixture();
	try {
		seedLegacy(sqlite);
		migrateAccount(storage, migrationConfig);
		migrateAccount(storage, migrationConfig);
		expect(sqlite.prepare("SELECT count(*) AS n FROM google_records").get()?.n)
			.toBe(1);
		expect(accountStorage(storage).deleted()).toBe(true);
		expect(sqlite.prepare("SELECT name FROM __drizzle_migrations").get()?.name)
			.toBe(initialId);
		expect(
			sqlite.prepare(
				"SELECT name FROM sqlite_master WHERE name='__account_migrations'",
			).get(),
		).toBeUndefined();
	} finally {
		sqlite.close();
	}
});
Deno.test("legacy adoption refuses unknown journals and divergent schemas without altering data", () => {
	for (
		const change of [
			"UPDATE __account_migrations SET id='unknown'",
			"ALTER TABLE google_records ADD COLUMN unexpected TEXT",
			"CREATE TABLE unexpected (id TEXT)",
		]
	) {
		const { sqlite, storage } = storageFixture();
		try {
			seedLegacy(sqlite);
			sqlite.exec(change);
			expect(() => migrateAccount(storage, migrationConfig)).toThrow();
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM google_records").get()?.n,
			).toBe(1);
			expect(
				sqlite.prepare(
					"SELECT name FROM sqlite_master WHERE name='__drizzle_migrations'",
				).get(),
			).toBeUndefined();
		} finally {
			sqlite.close();
		}
	}
});

Deno.test("failed upgrade rolls legacy adoption back with account data intact", () => {
	const { sqlite, storage } = storageFixture();
	try {
		seedLegacy(sqlite);
		expect(() =>
			migrateAccount(storage, {
				migrations: {
					...migrationConfig.migrations,
					"20260911101158_invalid": "NOT VALID SQL",
				},
			})
		).toThrow();
		expect(sqlite.prepare("SELECT id FROM __account_migrations").get()?.id)
			.toBe(initialId);
		expect(sqlite.prepare("SELECT count(*) AS n FROM google_records").get()?.n)
			.toBe(1);
		expect(
			sqlite.prepare(
				"SELECT name FROM sqlite_master WHERE name='__drizzle_migrations'",
			).get(),
		).toBeUndefined();
	} finally {
		sqlite.close();
	}
});
