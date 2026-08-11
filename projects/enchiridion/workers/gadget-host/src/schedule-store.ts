// @enchiridion/worker-gadget-host — SQLite read/write for `gadget_schedules`.
//
// Data model for the `schedule.cron` capability — see
// `schedule-fanout.ts`'s header for why this is a POLLED table a single
// supervisor-level cron tick sweeps, not a real per-gadget Cron Trigger.

import type { SqlExecutor } from "./schema";

export interface GadgetSchedule {
  id: string;
  gadgetId: string;
  intervalMinutes: number;
  enabled: boolean;
  nextDueAt: number;
  lastRunAt: number | null;
  lastResult: string | null;
  createdAt: number;
}

interface ScheduleRow {
  id: string;
  gadget_id: string;
  interval_minutes: number;
  enabled: number;
  next_due_at: number;
  last_run_at: number | null;
  last_result: string | null;
  created_at: number;
  [key: string]: unknown;
}

const SCHEDULE_COLUMNS = "id, gadget_id, interval_minutes, enabled, next_due_at, last_run_at, last_result, created_at";

/** Fix 3 (adversarial review, plan §Gadgets' "supervisor needs real
 *  resource caps"): the hard ceiling on how many `gadget_schedules` rows a
 *  single gadget may ever hold, enforced in `registerSchedule` below. 10 —
 *  the plan's v1 scope is "one headless cron automation" (a single
 *  schedule), so even a gadget legitimately running several independent
 *  periodic jobs has generous headroom, while a gadget calling
 *  `scheduleRegister` (`gadget-env.ts`) in a loop — every registration
 *  immediately due per this file's own `registerSchedule` doc below — is
 *  stopped after 10 rows instead of being able to flood the table and
 *  starve the shared 5-minute fan-out tick (`wrangler.jsonc`'s
 *  `triggers.crons`) for every OTHER gadget's due schedules. Counts ALL
 *  rows for the gadget, enabled or disabled — a disabled row (Fix 2) is
 *  still bookkeeping this table carries and still represents budget this
 *  gadget already used, so disabling schedules is not a way to farm more
 *  registration slots. */
export const MAX_SCHEDULES_PER_GADGET = 10;

/** Thrown by `registerSchedule` when `gadgetId` already holds
 *  `MAX_SCHEDULES_PER_GADGET` rows — see that constant's doc. Mirrors this
 *  codebase's "plain, named Error subclass carrying identifying fields"
 *  convention (compare `capability-types.ts`'s `CapabilityDeniedError`). */
export class ScheduleLimitExceededError extends Error {
  constructor(
    public readonly gadgetId: string,
    public readonly limit: number,
  ) {
    super(`gadget "${gadgetId}" has reached the maximum of ${limit} registered schedules`);
    this.name = "ScheduleLimitExceededError";
  }
}

/** Total `gadget_schedules` rows belonging to `gadgetId`, enabled or not —
 *  see `MAX_SCHEDULES_PER_GADGET`'s doc for why disabled rows still count. */
export function countSchedules(sql: SqlExecutor, gadgetId: string): number {
  return sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM gadget_schedules WHERE gadget_id = ?`, gadgetId).one().count;
}

function decodeRow(row: ScheduleRow): GadgetSchedule {
  return {
    id: row.id,
    gadgetId: row.gadget_id,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled !== 0,
    nextDueAt: row.next_due_at,
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
    createdAt: row.created_at,
  };
}

/** Registers a new schedule, due immediately (`nextDueAt = now`) — the
 *  first fan-out tick after registration picks it up. A gadget with
 *  multiple registered schedules is allowed (no uniqueness constraint on
 *  `gadget_id`) up to `MAX_SCHEDULES_PER_GADGET` (Fix 3) — past that, this
 *  throws `ScheduleLimitExceededError` rather than silently accepting
 *  unbounded rows. */
export function registerSchedule(sql: SqlExecutor, gadgetId: string, intervalMinutes: number, now: number): GadgetSchedule {
  const existingCount = countSchedules(sql, gadgetId);
  if (existingCount >= MAX_SCHEDULES_PER_GADGET) {
    throw new ScheduleLimitExceededError(gadgetId, MAX_SCHEDULES_PER_GADGET);
  }

  const schedule: GadgetSchedule = {
    id: `schedule_${crypto.randomUUID()}`,
    gadgetId,
    intervalMinutes,
    enabled: true,
    nextDueAt: now,
    lastRunAt: null,
    lastResult: null,
    createdAt: now,
  };
  sql.exec(
    `INSERT INTO gadget_schedules (id, gadget_id, interval_minutes, enabled, next_due_at, last_run_at, last_result, created_at)
     VALUES (?, ?, ?, 1, ?, NULL, NULL, ?)`,
    schedule.id,
    schedule.gadgetId,
    schedule.intervalMinutes,
    schedule.nextDueAt,
    schedule.createdAt,
  );
  return schedule;
}

export function listSchedules(sql: SqlExecutor, gadgetId?: string): GadgetSchedule[] {
  const rows = gadgetId
    ? sql.exec<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM gadget_schedules WHERE gadget_id = ? ORDER BY created_at ASC`, gadgetId).toArray()
    : sql.exec<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM gadget_schedules ORDER BY created_at ASC`).toArray();
  return rows.map(decodeRow);
}

/** Every ENABLED schedule due at or before `now` — `schedule-fanout.ts`'s
 *  only read against this table. */
export function listDueSchedules(sql: SqlExecutor, now: number): GadgetSchedule[] {
  return sql
    .exec<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM gadget_schedules WHERE enabled = 1 AND next_due_at <= ? ORDER BY next_due_at ASC`, now)
    .toArray()
    .map(decodeRow);
}

/** Advances a schedule past this fan-out tick — called for EVERY due
 *  schedule regardless of whether its gadget invocation succeeded
 *  (`lastResult` records which), so a permanently-failing gadget's
 *  schedule can never wedge the fan-out loop into retrying it every single
 *  tick (mirrors the plan's Gmail body-ingest risk #17 concern — a
 *  schedule that keeps failing still only costs one invocation attempt per
 *  its own interval, not per fan-out tick). */
export function markScheduleRun(sql: SqlExecutor, scheduleId: string, now: number, intervalMinutes: number, result: string): void {
  const nextDueAt = now + intervalMinutes * 60 * 1000;
  sql.exec(
    `UPDATE gadget_schedules SET last_run_at = ?, last_result = ?, next_due_at = ? WHERE id = ?`,
    now,
    result,
    nextDueAt,
    scheduleId,
  );
}

/** Flips a single schedule row's `enabled` flag. Called from three places
 *  now (previously dead code — nothing called it): `schedule-fanout.ts`'s
 *  per-tick capability re-check (Fix 1), `gadget-supervisor-do.ts`'s
 *  `disableGadgetSchedule` RPC (Fix 2c), and indirectly via
 *  `disableAllSchedulesForGadget` below (Fix 2b). */
export function setScheduleEnabled(sql: SqlExecutor, scheduleId: string, enabled: boolean): void {
  sql.exec(`UPDATE gadget_schedules SET enabled = ? WHERE id = ?`, enabled ? 1 : 0, scheduleId);
}

/** Disables every currently-ENABLED schedule row belonging to `gadgetId` in
 *  one statement — Fix 2b's cascade-disable, called the instant a gadget's
 *  `schedule.cron` grant is revoked (`gadget-supervisor-do.ts`'s
 *  `revokeCapabilityGrant`) so a revoked gadget's schedules stop being
 *  fan-out-eligible IMMEDIATELY, not just whenever `runScheduleFanoutTick`
 *  next happens to re-check one of them individually (Fix 1 is the other,
 *  independent layer that catches the same case lazily — this is the
 *  eager one). Idempotent: rows already disabled are simply not matched by
 *  the `WHERE enabled = 1` clause. */
export function disableAllSchedulesForGadget(sql: SqlExecutor, gadgetId: string): void {
  sql.exec(`UPDATE gadget_schedules SET enabled = 0 WHERE gadget_id = ? AND enabled = 1`, gadgetId);
}
