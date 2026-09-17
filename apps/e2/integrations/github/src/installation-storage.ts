import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

interface QueryResult<T> {
	results: T[];
	meta: { changes: number };
}

export interface InstallationStatement {
	bind(...values: unknown[]): InstallationStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<QueryResult<T>>;
	run(): Promise<QueryResult<Record<string, unknown>>>;
}

export interface InstallationDatabase {
	prepare(query: string): InstallationStatement;
	batch(
		statements: InstallationStatement[],
	): Promise<QueryResult<Record<string, unknown>>[]>;
}

const promised = <T>(action: () => T): Promise<T> =>
	new Promise((resolve) => resolve(action()));

export const migrateInstallation = (
	storage: DurableObjectStorage,
	migrations: { migrations: Record<string, string> },
) => {
	const result = migrate(drizzle(storage), migrations);
	if (result) throw new Error("Could not migrate GitHub installation");
};

export const installationDatabase = (
	storage: DurableObjectStorage,
): InstallationDatabase => {
	const runners = new WeakMap<
		InstallationStatement,
		() => QueryResult<Record<string, unknown>>
	>();
	const execute = <T>(query: string, values: unknown[]): QueryResult<T> => {
		const cursor = storage.sql.exec(
			query,
			...values as (string | number | null)[],
		);
		const results = cursor.toArray() as T[];
		const changes = storage.sql.exec<{ changes: number }>(
			"SELECT changes() AS changes",
		).one().changes;
		return { results, meta: { changes } };
	};
	const prepare = (
		query: string,
		values: unknown[] = [],
	): InstallationStatement => {
		const statement: InstallationStatement = {
			bind: (...bindings) => prepare(query, bindings),
			first: <T>() =>
				promised(() => execute<T>(query, values).results[0] ?? null),
			all: <T>() => promised(() => execute<T>(query, values)),
			run: () => promised(() => execute(query, values)),
		};
		runners.set(statement, () => execute(query, values));
		return statement;
	};
	return {
		prepare,
		batch: (statements) =>
			promised(() =>
				storage.transactionSync(() =>
					statements.map((statement) => {
						const run = runners.get(statement);
						if (!run) throw new Error("Statement belongs to another install");
						return run();
					})
				)
			),
	};
};
