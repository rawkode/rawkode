import { Database, type SQLQueryBindings } from "bun:sqlite";

/** Executes the actual migrations and SQL with SQLite. Worker binding behavior is covered by E2E. */
export async function testDatabase(migration: string) {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(await Bun.file(new URL(migration, import.meta.url)).text());
  const statement = (sql: string, values: SQLQueryBindings[] = []) => ({
    bind(...params: SQLQueryBindings[]) { return statement(sql, params); },
    async first(column?: string) { const row = sqlite.prepare(sql).get(...values) as Record<string, unknown> | null; return column ? row?.[column] ?? null : row; },
    async all() { return { results: sqlite.prepare(sql).all(...values), success: true, meta: {} }; },
    async run() { return execute(sql, values); },
    sql, values,
  });
  function execute(sql: string, values: SQLQueryBindings[]) {
    const result = sqlite.prepare(sql).run(...values);
    return { results: [], success: true, meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  }
  const db = {
    prepare: statement,
    async batch(statements: ReturnType<typeof statement>[]) {
      return sqlite.transaction(() => statements.map((stmt) => execute(stmt.sql, stmt.values)))();
    },
  } as unknown as D1Database;
  return { db, sqlite };
}
