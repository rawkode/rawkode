// Test-only. NOT shipped to the Worker bundle — nothing in `vault-do.ts` or
// any other production module imports this file; only `*.test.ts` files do.
//
// Cloudflare's real `DurableObjectState.storage.sql` (`SqlStorage`,
// `@cloudflare/workers-types`) can only be exercised inside a live Workers
// runtime (`wrangler dev` or deployed), which this sandbox doesn't have
// network/account access to drive. `bun:sqlite` ships an embedded real
// SQLite engine directly in the Bun binary, so this adapter backs the exact
// same `SqlExecutor` shape (`schema.ts`) with a REAL SQLite database under
// `bun test` — every DDL statement, transaction, and query in this worker's
// tests runs against actual SQLite, not a hand-rolled mock. What's
// necessarily untested against the real thing: Cloudflare-specific quirks
// (the 10 GB storage ceiling, `rowsRead`/`rowsWritten` billing counters,
// `transactionSync`'s exact isolation semantics under DO concurrency).
//
// One real gotcha this adapter exists specifically to paper over correctly
// rather than silently mishandle: `SqlStorageValue` is `ArrayBuffer | string
// | number | null` (never `Uint8Array`), but `bun:sqlite` binds/returns BLOB
// columns as `Uint8Array`. Verified empirically in this sandbox: binding a
// raw `ArrayBuffer` to `bun:sqlite` does NOT throw — it silently stores
// `NULL` instead of the bytes. Converting at both the bind boundary and the
// read boundary below is load-bearing, not a style choice.

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

/** Converts a bun:sqlite BLOB read (`Uint8Array`) back to `ArrayBuffer`, so
 *  a row read through this adapter is byte-for-byte the same shape a real
 *  `SqlStorageCursor` would hand back. */
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

/** A `SqlExecutor` (see `schema.ts`) backed by a real, in-memory (by
 *  default) `bun:sqlite` database. Constructed fresh per test unless a
 *  caller passes an existing `Database` (used to simulate "the DO woke up
 *  again" by reopening the same underlying storage). */
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
