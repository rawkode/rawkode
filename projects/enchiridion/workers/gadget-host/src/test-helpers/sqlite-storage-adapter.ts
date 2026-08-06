// Test-only. NOT shipped to the Worker bundle — mirrors
// `workers/vault/src/test-helpers/sqlite-storage-adapter.ts` exactly (see
// that file's header for the full rationale: `bun:sqlite` backs the same
// `SqlExecutor` shape with a REAL SQLite database under `bun test`, without
// needing a live Workers runtime this sandbox has no account access to
// drive).

import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { SqlCursor, SqlExecutor } from "../schema";

function toSqliteBinding(value: unknown): SQLQueryBindings {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return value as SQLQueryBindings;
}

function fromSqliteValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value;
}

function convertRow<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    converted[key] = fromSqliteValue(value);
  }
  return converted as T;
}

class BunSqlCursor<T extends Record<string, unknown>> implements SqlCursor<T> {
  readonly columnNames: string[];
  private readonly rows: T[];

  constructor(columnNames: string[], rawRows: Record<string, unknown>[]) {
    this.columnNames = columnNames;
    this.rows = rawRows.map((row) => convertRow<T>(row));
  }

  toArray(): T[] {
    return this.rows;
  }

  one(): T {
    if (this.rows.length !== 1) {
      throw new Error(`expected exactly one row, got ${this.rows.length}`);
    }
    return this.rows[0]!;
  }

  *raw<U extends unknown[]>(): IterableIterator<U> {
    for (const row of this.rows) {
      yield this.columnNames.map((name) => row[name]) as U;
    }
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.rows[Symbol.iterator]();
  }
}

export class SqliteStorageAdapter implements SqlExecutor {
  readonly db: Database;

  constructor(db: Database = new Database(":memory:")) {
    this.db = db;
  }

  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T> {
    const converted = bindings.map(toSqliteBinding);
    const statement = this.db.query(query);
    const rows = statement.all(...converted) as Record<string, unknown>[];
    const columnNames = statement.columnNames ?? (rows[0] ? Object.keys(rows[0]) : []);
    return new BunSqlCursor<T>(columnNames, rows);
  }
}
