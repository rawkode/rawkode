/** Atomic, replay-safe write boundary for one already-fetched provider event plan. Provider I/O
 * is intentionally outside; raw provider ids and addresses stay in private collections. */
import { canonicalJsonBytes, sha256HexSync, type EntityId, type MutationAttribution } from "@athenaeum/domain"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { calendarProjectionLedgerFingerprint, LedgerService, type LedgerCustodyInput } from "./ledger-service.js"
import { DurableWorkforceRuntimeStore } from "./workforce-runtime-store.js"

export const CALENDAR_ATTENDEE_OBSERVED_EVENT = "calendar.attendee-observed.v1" as const
export const CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW = "calendar-relationship-concierge" as const
export const CALENDAR_RELATIONSHIP_CONCIERGE_VERSION = "v1" as const

export interface CalendarProjectionPlan {
  readonly workspaceId: EntityId
  readonly bindingId: EntityId
  readonly calendarEventId: EntityId
  readonly requestIdentity: string
  readonly requestId: string
  readonly sourceRevisionDigest: string
  readonly sourceEventKeyDigest: string
  readonly attendeeObservationDigests: ReadonlyArray<string>
  readonly commitMessage: string
  readonly attribution: MutationAttribution
  /** Applies only backend-private projection rows and must not contact the provider. */
  /** Returns observations first seen for this stable provider event. A later title/status
   * revision can update private projection state without re-enqueuing the concierge. */
  readonly applyProjection: () => ReadonlyArray<string>
}

export interface CalendarProjectionReceipt {
  readonly calendarEventId: EntityId
  readonly replayed: boolean
  readonly enqueuedRunIds: ReadonlyArray<string>
}
export const calendarProjectionGatewayTestHook: { afterProjectionBeforeLedger: (() => void) | undefined } = {
  afterProjectionBeforeLedger: undefined
}

export class CalendarProjectionGateway {
  constructor(private readonly storage: DurableObjectStorage, private readonly ledger: LedgerService, private readonly runtime: DurableWorkforceRuntimeStore) {}

  apply(plan: CalendarProjectionPlan): CalendarProjectionReceipt {
    if (plan.commitMessage.trim().length === 0) throw new Error("calendar projection requires a nonblank commit message")
    const attendeeObservationDigests = [...new Set(plan.attendeeObservationDigests)].sort()
    const fingerprint = calendarProjectionLedgerFingerprint({
      requestId: plan.requestId, workspaceId: plan.workspaceId, principal: "system:calendar-sync",
      policy: "calendar-provider-projection", sourceRevisionDigest: plan.sourceRevisionDigest,
      attendeeObservationDigests, commitMessage: plan.commitMessage, attribution: plan.attribution
    })
    let replayed = false
    const enqueuedRunIds: string[] = []
    let newAttendeeObservationDigests: ReadonlyArray<string> = []
    const receipt = this.storage.transactionSync(() => this.ledger.executeV2({
      requestIdentity: plan.requestIdentity, fingerprint, type: "calendarProjection",
      mutate: () => {
        newAttendeeObservationDigests = [...new Set(plan.applyProjection())].sort()
        calendarProjectionGatewayTestHook.afterProjectionBeforeLedger?.()
        return { calendarEventId: plan.calendarEventId }
      },
      encodeOutput: (value) => value,
      decodeOutput: (value) => {
        replayed = true
        if (typeof value !== "object" || value === null || typeof (value as { calendarEventId?: unknown }).calendarEventId !== "string") {
          throw new Error("corrupt calendar projection receipt")
        }
        return { calendarEventId: (value as { calendarEventId: EntityId }).calendarEventId }
      },
      appendCommand: () => this.ledger.appendCalendarProjection({
        requestIdentity: plan.requestIdentity, requestId: plan.requestId, fingerprint,
        workspaceId: plan.workspaceId, principal: "system:calendar-sync", policy: "calendar-provider-projection",
        calendarEventId: plan.calendarEventId, sourceRevisionDigest: plan.sourceRevisionDigest,
        attendeeObservationDigests, commitMessage: plan.commitMessage, attribution: plan.attribution,
        createdAt: new Date().toISOString()
      }),
      appendCustody: () => this.ledger.appendCustody({
        requestIdentity: plan.requestIdentity, fingerprint, type: "calendarProjection", workspaceId: plan.workspaceId,
        actorKind: "system", actorLabel: "Calendar sync", targetKind: "calendarEvent", targetId: plan.calendarEventId
      }),
      validateReplayCustody: () => this.ledger.validateCustody({
        requestIdentity: plan.requestIdentity, fingerprint, type: "calendarProjection", workspaceId: plan.workspaceId,
        actorKind: "system", actorLabel: "Calendar sync", targetKind: "calendarEvent", targetId: plan.calendarEventId
      }),
      appendSideEffects: () => {
        if (newAttendeeObservationDigests.length === 0) return
        const event = { eventType: CALENDAR_ATTENDEE_OBSERVED_EVENT, workspaceId: plan.workspaceId,
          bindingIdDigest: sha256HexSync(canonicalJsonBytes({ bindingId: plan.bindingId })),
          sourceRevisionDigest: plan.sourceRevisionDigest,
          attendeeObservationDigests: newAttendeeObservationDigests }
        this.ledger.appendEvent(plan.requestIdentity, CALENDAR_ATTENDEE_OBSERVED_EVENT, event)
        this.ledger.appendOutbox(plan.requestIdentity, CALENDAR_ATTENDEE_OBSERVED_EVENT, event)
        for (const digest of newAttendeeObservationDigests) {
          const run = this.runtime.enqueue({ workflowId: CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW,
            scheduleVersion: CALENDAR_RELATIONSHIP_CONCIERGE_VERSION,
            occurrenceId: `${plan.sourceRevisionDigest}:${digest}`,
            sourceEventId: `${CALENDAR_ATTENDEE_OBSERVED_EVENT}:${plan.sourceRevisionDigest}:${digest}`,
            dueAt: new Date() })
          enqueuedRunIds.push(run.id)
        }
      }
    }))
    return { calendarEventId: receipt.calendarEventId, replayed, enqueuedRunIds }
  }
}
