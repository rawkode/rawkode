// Empirical probe for the plan's flagged Phase 1 blocker (plan §"Full-text search": "confirm:
// (a) whether Cloudflare's DO SQLite driver supports FTS5 virtual tables"; risk #5: "Full-text
// search has no confirmed implementation path (BLOCKING for Phase 1 planning)").
//
// Deliberately a standalone scratch DO, not a method bolted onto `WorkspaceDurableObject` — this is a
// capability probe, not a `NodesRepository`/Views feature, and keeping it separate means it can be
// deleted later (or kept, see below) without touching the Phase 0 production DO. It is kept as a
// permanent, cheap regression test (see `test/fts5-search.test.ts`) rather than deleted after use:
// a Workers-platform SQLite capability like this can regress or change across `compatibility_date`
// bumps, and the test costs one extra DO instantiation in the suite.
//
// Uses the exact raw SQL execution API this workspace already uses elsewhere for `ctx.storage.sql`
// (`cloudflare-os/packages/mcp-shared/src/action-store.ts`: `sql.exec(query, ...bindings)`,
// `SqlStorageCursor#toArray()`/`#one()`) — same shape, not a different API.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "./index.js"

export interface Fts5ProbeMatch {
  readonly title: string
  readonly body: string
}

export type Fts5ProbeResult =
  | { readonly supported: true; readonly matches: ReadonlyArray<Fts5ProbeMatch> }
  | { readonly supported: false; readonly error: string }

export class FtsSearchProbeDurableObject extends DurableObject<Env> {
  /**
   * Attempts, against this DO instance's *real* `storage.sql` (DO SQLite, not a mock/emulation),
   * to: create an FTS5 virtual table, insert rows, and run an actual `MATCH` query. Returns
   * `{supported: true, matches}` with the real query results on success, or `{supported: false,
   * error}` with the exact driver error on failure — never throws, so the test can assert on the
   * outcome either way instead of needing a try/catch at the call site.
   *
   * `DROP TABLE IF EXISTS` first makes repeat calls against the same DO instance (e.g. a retried
   * test) idempotent; each test additionally uses a fresh `getByName` id, so instances aren't
   * actually reused across runs in practice.
   */
  async probeFts5(): Promise<Fts5ProbeResult> {
    const sql = this.ctx.storage.sql
    try {
      sql.exec(`DROP TABLE IF EXISTS fts5_probe`)
      sql.exec(`CREATE VIRTUAL TABLE fts5_probe USING fts5(title, body)`)

      sql.exec(
        `INSERT INTO fts5_probe (title, body) VALUES (?, ?)`,
        "Daily note 2026-08-20",
        "Resolved the FTS5 blocker for Athenaeum's Phase 1 Views+Search stage."
      )
      sql.exec(
        `INSERT INTO fts5_probe (title, body) VALUES (?, ?)`,
        "Unrelated grocery list",
        "Milk, eggs, bread."
      )

      const cursor = sql.exec<{ title: string; body: string }>(
        `SELECT title, body FROM fts5_probe WHERE fts5_probe MATCH ? ORDER BY rank`,
        "Athenaeum"
      )
      const matches = cursor.toArray().map((row) => ({ title: row.title, body: row.body }))
      return { supported: true, matches }
    } catch (error) {
      return { supported: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
