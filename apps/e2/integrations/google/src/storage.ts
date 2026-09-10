import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

const resultPromise = <T>(action: () => T): Promise<T> =>
	new Promise((resolve) => resolve(action()));

interface QueryResult<T> {
	results: T[];
	meta: { changes: number };
}
export interface AccountStatement {
	bind(...values: unknown[]): AccountStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<QueryResult<T>>;
	run(): Promise<QueryResult<Record<string, unknown>>>;
}
export interface AccountDatabase {
	prepare(query: string): AccountStatement;
	batch(
		statements: AccountStatement[],
	): Promise<QueryResult<Record<string, unknown>>[]>;
}

const legacyId = "20260910101158_initial";
const stateSQL =
	"CREATE TABLE IF NOT EXISTS __account_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)";
const normalizeSQL = (value: string) =>
	value.replace(/IF NOT EXISTS/gi, "").replace(/[\s`";]/g, "").toLowerCase();

/** Adopt only the exact deployed baseline; never replay CREATE TABLE over account data. */
const adoptLegacyAccount = (
	storage: DurableObjectStorage,
	migrations: Record<string, string>,
) => {
	const objects = storage.sql.exec<
		{ name: string; type: string; sql: string | null }
	>(
		"SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
	).toArray();
	if (!objects.some(({ name }) => name === "__account_migrations")) return;
	if (objects.some(({ name }) => name === "__drizzle_migrations")) {
		throw new Error("Conflicting Google migration journals");
	}
	const ids = storage.sql.exec<{ id: string }>(
		"SELECT id FROM __account_migrations ORDER BY id",
	).toArray();
	if (ids.length !== 1 || ids[0]?.id !== legacyId || !migrations[legacyId]) {
		throw new Error("Unknown legacy Google migrations");
	}
	const baseline = migrations[legacyId].split("--> statement-breakpoint").map(
		(sql) => sql.trim(),
	).filter(Boolean);
	const expected = [
		...baseline,
		stateSQL,
		"CREATE TABLE __account_migrations (id TEXT PRIMARY KEY)",
	];
	if (
		objects.length !== expected.length ||
		objects.some((object) =>
			object.type !== "table" || !object.sql ||
			!expected.some((sql) => normalizeSQL(sql) === normalizeSQL(object.sql!))
		)
	) {
		throw new Error("Legacy Google schema differs from the deployed baseline");
	}
	const initConfig = {
		migrations: { [legacyId]: migrations[legacyId] },
		init: true,
	};
	const result = migrate(drizzle(storage), initConfig);
	if (result) throw new Error("Could not adopt legacy Google migrations");
	storage.sql.exec("DROP TABLE __account_migrations");
};

export const migrateAccount = (
	storage: DurableObjectStorage,
	config: { migrations: Record<string, string> },
) => {
	storage.transactionSync(() => {
		adoptLegacyAccount(storage, config.migrations);
		const result = migrate(drizzle(storage), config);
		if (result) throw new Error("Could not migrate Google account");
		storage.sql.exec(stateSQL);
	});
};

export const accountStorage = (storage: DurableObjectStorage) => {
	const read = <T>(key: string): T | undefined => {
		const row = storage.sql.exec<{ value: string }>(
			"SELECT value FROM __account_state WHERE key = ?",
			key,
		).toArray()[0];
		return row ? JSON.parse(row.value) as T : undefined;
	};
	const assertActive = () => {
		if (read<boolean>("deleted")) throw new Error("Account has been deleted");
	};
	const write = (key: string, value: unknown) => {
		assertActive();
		storage.sql.exec(
			"INSERT INTO __account_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			key,
			JSON.stringify(value),
		);
	};
	const execute = <T>(query: string, values: unknown[]): QueryResult<T> => {
		assertActive();
		const cursor = storage.sql.exec(
			query,
			...values as (string | number | null)[],
		);
		const results = cursor.toArray() as T[];
		const changes =
			storage.sql.exec<{ changes: number }>("SELECT changes() AS changes").one()
				.changes;
		return { results, meta: { changes } };
	};
	const runners = new WeakMap<
		AccountStatement,
		() => QueryResult<Record<string, unknown>>
	>();
	const prepare = (query: string, values: unknown[] = []): AccountStatement => {
		const statement: AccountStatement = {
			bind: (...bindings) => prepare(query, bindings),
			first: <T>() =>
				resultPromise(() => execute<T>(query, values).results[0] ?? null),
			all: <T>() => resultPromise(() => execute<T>(query, values)),
			run: () => resultPromise(() => execute(query, values)),
		};
		runners.set(statement, () => execute(query, values));
		return statement;
	};
	const db: AccountDatabase = {
		prepare,
		batch: (statements) =>
			resultPromise(() =>
				storage.transactionSync(() =>
					statements.map((statement) => {
						const run = runners.get(statement);
						if (!run) {
							throw new Error("Statement belongs to a different account");
						}
						return run();
					})
				)
			),
	};
	const coordinator = {
		get: <T>(key: string) => resultPromise(() => read<T>(key)),
		put: (key: string, value: unknown) =>
			resultPromise(() => write(key, value)),
		getAlarm: () => storage.getAlarm(),
		setAlarm: (time: number) => {
			assertActive();
			return storage.setAlarm(time);
		},
		deleteAlarm: () => storage.deleteAlarm(),
	};
	const remove = async (deletedGrantVersion?: number) => {
		storage.transactionSync(() => {
			const preservedGrantVersion = Number.isSafeInteger(deletedGrantVersion)
				? deletedGrantVersion
				: read<number>("deleted_grant_version");
			// Keep only a durable fence: even stale RPC stubs cannot resurrect deleted data.
			const tables = storage.sql.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('__drizzle_migrations', '__account_state')",
			).toArray();
			for (const { name } of tables) {
				storage.sql.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
			}
			storage.sql.exec("DELETE FROM __account_state");
			storage.sql.exec(
				"INSERT INTO __account_state (key, value) VALUES ('deleted', 'true')",
			);
			if (Number.isSafeInteger(preservedGrantVersion)) {
				storage.sql.exec(
					"INSERT INTO __account_state (key, value) VALUES ('deleted_grant_version', ?)",
					JSON.stringify(preservedGrantVersion),
				);
			}
		});
		await storage.deleteAlarm();
	};
	const revive = (grantVersion: number) => {
		storage.transactionSync(() => {
			if (!read<boolean>("deleted")) return;
			const deletedGrantVersion = read<number>("deleted_grant_version");
			if (
				!Number.isSafeInteger(grantVersion) ||
				!Number.isSafeInteger(deletedGrantVersion) ||
				grantVersion <= (deletedGrantVersion as number)
			) throw new Error("Account has been deleted");
			storage.sql.exec(
				"DELETE FROM __account_state WHERE key IN ('deleted', 'deleted_grant_version')",
			);
		});
	};
	return {
		db,
		coordinator,
		assertActive,
		remove,
		revive,
		deleted: () => read<boolean>("deleted") === true,
	};
};
