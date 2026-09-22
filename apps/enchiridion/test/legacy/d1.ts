import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Run the actual migrations in SQLite; Worker bindings are checked separately. */
export const testDatabase = async (migration: string) => {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	const source = new URL(migration, import.meta.url);
	const files = (await Deno.stat(source)).isDirectory
		? (await Array.fromAsync(Deno.readDir(source)))
			.filter((entry) => entry.isDirectory && /^\d{14}_/.test(entry.name))
			.map((entry) =>
				new URL(`${source.href.replace(/\/$/, "")}/${entry.name}/migration.sql`)
			)
			.sort((left, right) => left.href.localeCompare(right.href))
		: [source];
	try {
		if (files.length === 0) throw new Error("No Drizzle migrations found");
		for (const file of files) database.exec(await Deno.readTextFile(file));
	} catch (error) {
		database.close();
		throw error;
	}
	const execute = (sql: string, values: SQLInputValue[]) => {
		const result = database.prepare(sql).run(...values);
		return {
			results: [],
			success: true,
			meta: {
				changes: Number(result.changes),
				last_row_id: Number(result.lastInsertRowid),
			},
		};
	};
	const statement = (sql: string, values: SQLInputValue[] = []) => ({
		bind: (...params: SQLInputValue[]) => statement(sql, params),
		first: (column?: string) => {
			const row = database.prepare(sql).get(...values) ?? null;
			return Promise.resolve(column ? row?.[column] ?? null : row);
		},
		all: () =>
			Promise.resolve({
				results: database.prepare(sql).all(...values),
				success: true,
				meta: {},
			}),
		run: () => Promise.resolve(execute(sql, values)),
		sql,
		values,
	});
	const db = {
		prepare: statement,
		batch: (statements: ReturnType<typeof statement>[]) => {
			database.exec("BEGIN");
			try {
				const result = statements.map((stmt) => execute(stmt.sql, stmt.values));
				database.exec("COMMIT");
				return Promise.resolve(result);
			} catch (error) {
				database.exec("ROLLBACK");
				return Promise.reject(error);
			}
		},
	} as unknown as D1Database;
	const sqlite = {
		query: (sql: string) => ({
			get: (...values: SQLInputValue[]) =>
				database.prepare(sql).get(...values) ?? null,
			all: (...values: SQLInputValue[]) => database.prepare(sql).all(...values),
		}),
		exec: (sql: string) => database.exec(sql),
		close: () => database.close(),
	};
	return { db, sqlite };
};
