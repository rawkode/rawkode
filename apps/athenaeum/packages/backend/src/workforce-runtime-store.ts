import type { SqlStorage } from "@cloudflare/workers-types"
import { workforceOccurrenceIdentity, workforceRetryDelayMs, type WorkforceRunRecord, type WorkforceRunState, type WorkforceScheduleDefinition, validateWorkforceSchedule } from "@athenaeum/domain"

export const WORKFORCE_RUNTIME_STORE_VERSION = "athenaeum.workforce-runtime-store.v1" as const
type Row = { id: string; workflowId: string; scheduleVersion: string; occurrenceId: string; sourceEventId: string | null; state: WorkforceRunState; attempts: number; nextAttemptAt: string; claimOwner: string | null; claimToken: string | null; leaseExpiresAt: string | null; lastError: string | null; createdAt: string; updatedAt: string }
const record = (row: Row): WorkforceRunRecord => Object.freeze({ ...row })
const id = (workflowId: string, scheduleVersion: string, source: string) => workforceOccurrenceIdentity(workflowId, scheduleVersion, source)

/** SQL CAS is the claim fence: work happens outside this store transaction, completion must present
 * the exact still-live token.  This lets alarms and manual drains race safely. */
export class DurableWorkforceRuntimeStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS workforce_runtime_runs (
      id TEXT PRIMARY KEY, workflowId TEXT NOT NULL, scheduleVersion TEXT NOT NULL,
      occurrenceId TEXT NOT NULL, sourceEventId TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL,
      nextAttemptAt TEXT NOT NULL, claimOwner TEXT, claimToken TEXT, leaseExpiresAt TEXT,
      lastError TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      UNIQUE(workflowId, scheduleVersion, occurrenceId),
      UNIQUE(workflowId, scheduleVersion, sourceEventId)
    )`)
    sql.exec("CREATE INDEX IF NOT EXISTS workforce_runtime_due ON workforce_runtime_runs (state, nextAttemptAt)")
    sql.exec(`CREATE TABLE IF NOT EXISTS workforce_runtime_schedules (
      workflowId TEXT PRIMARY KEY, scheduleVersion TEXT NOT NULL, enabled INTEGER NOT NULL,
      triggerKind TEXT NOT NULL, definition TEXT NOT NULL, updatedAt TEXT NOT NULL
    )`)
  }
  upsertSchedule(definition: WorkforceScheduleDefinition, now = new Date()): void {
    validateWorkforceSchedule(definition)
    this.sql.exec(`INSERT INTO workforce_runtime_schedules (workflowId, scheduleVersion, enabled, triggerKind, definition, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflowId) DO UPDATE SET scheduleVersion=excluded.scheduleVersion, enabled=excluded.enabled, triggerKind=excluded.triggerKind, definition=excluded.definition, updatedAt=excluded.updatedAt`,
      definition.workflowId, definition.scheduleVersion, definition.enabled ? 1 : 0, definition.trigger.kind, JSON.stringify(definition), now.toISOString())
  }
  schedule(workflowId: string): WorkforceScheduleDefinition | undefined {
    const row = this.sql.exec<{ definition: string }>("SELECT definition FROM workforce_runtime_schedules WHERE workflowId=?", workflowId).toArray()[0]
    if (!row) return undefined
    const value = JSON.parse(row.definition) as WorkforceScheduleDefinition; validateWorkforceSchedule(value); return value
  }
  get(runId: string): WorkforceRunRecord | undefined { const row = this.sql.exec<Row>("SELECT * FROM workforce_runtime_runs WHERE id = ?", runId).toArray()[0]; return row ? record(row) : undefined }
  enqueue(input: { workflowId: string; scheduleVersion: string; occurrenceId: string; sourceEventId?: string; dueAt: Date }): WorkforceRunRecord {
    const now = new Date().toISOString(), runId = id(input.workflowId, input.scheduleVersion, input.sourceEventId ?? input.occurrenceId)
    this.sql.exec(`INSERT OR IGNORE INTO workforce_runtime_runs (id, workflowId, scheduleVersion, occurrenceId, sourceEventId, state, attempts, nextAttemptAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`, runId, input.workflowId, input.scheduleVersion, input.occurrenceId, input.sourceEventId ?? null, input.dueAt.toISOString(), now, now)
    return this.get(runId)!
  }
  nextDueAt(): Date | undefined { const row = this.sql.exec<{ nextAttemptAt: string }>("SELECT nextAttemptAt FROM workforce_runtime_runs WHERE state IN ('queued','retryable') ORDER BY nextAttemptAt LIMIT 1").toArray()[0]; return row ? new Date(row.nextAttemptAt) : undefined }
  claimDue(now: Date, owner: string, token: string, leaseMs: number): WorkforceRunRecord | undefined {
    const candidate = this.sql.exec<Row>(`SELECT * FROM workforce_runtime_runs WHERE (state IN ('queued','retryable') AND nextAttemptAt <= ?) OR (state = 'claimed' AND leaseExpiresAt <= ?) ORDER BY nextAttemptAt, createdAt LIMIT 1`, now.toISOString(), now.toISOString()).toArray()[0]
    if (!candidate) return undefined
    const expiry = new Date(now.getTime() + leaseMs).toISOString()
    this.sql.exec(`UPDATE workforce_runtime_runs SET state='claimed', attempts=attempts+1, claimOwner=?, claimToken=?, leaseExpiresAt=?, updatedAt=?
      WHERE id=? AND ((state IN ('queued','retryable') AND nextAttemptAt <= ?) OR (state='claimed' AND leaseExpiresAt <= ?))`, owner, token, expiry, now.toISOString(), candidate.id, now.toISOString(), now.toISOString())
    const claimed = this.get(candidate.id)
    return claimed?.claimToken === token ? claimed : undefined
  }
  finish(runId: string, token: string, state: Extract<WorkforceRunState, "completed" | "blocked" | "failed" | "skipped">, now: Date, error?: string): boolean {
    const result = this.sql.exec(`UPDATE workforce_runtime_runs SET state=?, claimOwner=NULL, claimToken=NULL, leaseExpiresAt=NULL, lastError=?, updatedAt=? WHERE id=? AND state='claimed' AND claimToken=? AND leaseExpiresAt > ?`, state, error ?? null, now.toISOString(), runId, token, now.toISOString())
    return result.rowsWritten === 1
  }
  retry(runId: string, token: string, now: Date, error: string, maxAttempts = 5): WorkforceRunRecord | undefined {
    const run = this.get(runId); if (!run || run.state !== "claimed" || run.claimToken !== token || !run.leaseExpiresAt || new Date(run.leaseExpiresAt) <= now) return undefined
    const terminal = run.attempts >= maxAttempts, next = new Date(now.getTime() + workforceRetryDelayMs(run.attempts)).toISOString()
    this.sql.exec(`UPDATE workforce_runtime_runs SET state=?, claimOwner=NULL, claimToken=NULL, leaseExpiresAt=NULL, nextAttemptAt=?, lastError=?, updatedAt=? WHERE id=? AND claimToken=?`, terminal ? "failed" : "retryable", terminal ? now.toISOString() : next, error, now.toISOString(), runId, token)
    return this.get(runId)
  }
}
