/** Durable, private execution records for workforce jobs.  These are deliberately not public
 * RPC shapes: callers receive a redacted projection once an executor exists. */
export const WORKFORCE_RUNTIME_VERSION = "athenaeum.workforce-runtime.v1" as const
export type WorkforceRunState = "queued" | "claimed" | "retryable" | "completed" | "blocked" | "failed" | "skipped"
export type WorkforceMisfirePolicy = "catch-up-once" | "skip" 
export type WorkforceTrigger =
  | Readonly<{ readonly kind: "event"; readonly eventType: string }>
  | Readonly<{ readonly kind: "cadence"; readonly everyMinutes: number; readonly civilTimeZone: string; readonly misfirePolicy: WorkforceMisfirePolicy }>
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
  return new Date(Math.ceil(after.getTime() / (minutes * 60_000)) * minutes * 60_000)
}
