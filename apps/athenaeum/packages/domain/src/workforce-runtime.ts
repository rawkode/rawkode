/** Durable, private execution records for workforce jobs.  These are deliberately not public
 * RPC shapes: callers receive a redacted projection once an executor exists. */
export const WORKFORCE_RUNTIME_VERSION = "athenaeum.workforce-runtime.v1" as const
export type WorkforceRunState = "queued" | "claimed" | "retryable" | "completed" | "blocked" | "failed" | "skipped"
export type WorkforceMisfirePolicy = "catch-up-once" | "skip" 
export type WorkforceTrigger =
  | Readonly<{ readonly kind: "event"; readonly eventType: string }>
  | Readonly<{ readonly kind: "cadence"; readonly everyMinutes: number; readonly civilTimeZone: string; readonly misfirePolicy: WorkforceMisfirePolicy; /** Optional wall-clock daily slot (HH:MM), evaluated in civilTimeZone. */ readonly atLocalTime?: string }>
export type WorkforceScheduleDefinition = Readonly<{
  readonly version: typeof WORKFORCE_RUNTIME_VERSION
  readonly workflowId: string
  readonly scheduleVersion: string
  readonly enabled: boolean
  readonly trigger: WorkforceTrigger
}>
export type WorkforceRunRecord = Readonly<{
  readonly id: string
  readonly workflowId: string
  readonly scheduleVersion: string
  readonly occurrenceId: string
  readonly sourceEventId: string | null
  readonly state: WorkforceRunState
  readonly attempts: number
  readonly nextAttemptAt: string
  readonly claimOwner: string | null
  readonly claimToken: string | null
  readonly leaseExpiresAt: string | null
  readonly lastError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}>

/** Stable across DO eviction/retries; a new schedule version is a distinct occurrence space. */
export const workforceOccurrenceIdentity = (workflowId: string, scheduleVersion: string, source: string): string =>
  `${workflowId}:${scheduleVersion}:${source}`

/** Runtime validation deliberately checks IANA zones at definition admission.  The persisted
 * occurrence is UTC, while its schedule version and source/civil slot make folds unambiguous. */
export const validateWorkforceSchedule = (definition: WorkforceScheduleDefinition): void => {
  if (definition.version !== WORKFORCE_RUNTIME_VERSION || !definition.workflowId || !definition.scheduleVersion) throw new RangeError("invalid workforce schedule identity")
  if (definition.trigger.kind === "event") { if (!definition.trigger.eventType) throw new RangeError("event trigger requires eventType"); return }
  if (!Number.isSafeInteger(definition.trigger.everyMinutes) || definition.trigger.everyMinutes < 1) throw new RangeError("cadence everyMinutes must be a positive integer")
  try { new Intl.DateTimeFormat("en-GB", { timeZone: definition.trigger.civilTimeZone }).format(0) }
  catch { throw new RangeError("cadence civilTimeZone must be an IANA timezone") }
  if (definition.trigger.atLocalTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(definition.trigger.atLocalTime)) throw new RangeError("cadence atLocalTime must be HH:MM")
}

export const workforceScheduledOccurrenceId = (definition: WorkforceScheduleDefinition, scheduledAt: Date): string => {
  validateWorkforceSchedule(definition)
  return workforceOccurrenceIdentity(definition.workflowId, definition.scheduleVersion, scheduledAt.toISOString())
}

export const workforceRetryDelayMs = (attempt: number): number => {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  return Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.min(12, safeAttempt - 1))
}

export const nextWorkforceCadenceAt = (definition: WorkforceScheduleDefinition, after: Date): Date | undefined => {
  validateWorkforceSchedule(definition)
  if (!definition.enabled || definition.trigger.kind !== "cadence") return undefined
  const minutes = definition.trigger.everyMinutes
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw new RangeError("cadence everyMinutes must be a positive integer")
  // Explicit daily slots are wall-clock schedules. Scanning bounded UTC minutes is intentionally
  // deterministic and handles IANA gaps/folds without trusting host timezone state: a gap follows
  // the definition's misfire policy (skip to the next local day); a fold chooses the first UTC
  // instant, so versioned occurrence IDs never collapse the two candidates.
  if (definition.trigger.atLocalTime) {
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: definition.trigger.civilTimeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000
    for (let instant = start; instant <= start + 48 * 60 * 60_000; instant += 60_000) {
      if (formatter.format(new Date(instant)) === definition.trigger.atLocalTime) return new Date(instant)
    }
    return undefined
  }
  // Interval cadence is intentionally elapsed-time cadence (not wall-clock cadence); its zone is
  // retained for daily-note/reporting scope. Use `atLocalTime` for civil scheduling.
  return new Date(Math.ceil(after.getTime() / (minutes * 60_000)) * minutes * 60_000)
}
