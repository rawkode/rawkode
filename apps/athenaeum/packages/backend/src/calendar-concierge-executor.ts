/** Durable executor for the first real workforce employee. */
import * as Effect from "effect/Effect"
import type { EntityId } from "@athenaeum/domain"
import type { CalendarAttendeeObservationRecord, CalendarSourceRevisionRecord, CalendarCollections } from "./calendar-collections.js"
import { CALENDAR_ATTENDEE_OBSERVED_EVENT, CALENDAR_RELATIONSHIP_CONCIERGE_VERSION, CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW } from "./calendar-projection-gateway.js"
import {
  createCalendarConciergeJobCapability,
  type CalendarConciergeExecutionAdapter,
  type CalendarConciergeExecutionBinding,
  type CalendarConciergeGrantResolver,
  type CalendarConciergeGrantV1,
  type CalendarConciergeJobPort,
  type CalendarConciergeTerminalResult,
  type OpaqueCalendarConciergeGrantToken
} from "./calendar-concierge-job-capability.js"
import { DurableWorkforceRuntimeStore } from "./workforce-runtime-store.js"

type CalendarRun = NonNullable<ReturnType<DurableWorkforceRuntimeStore["claimDue"]>>

export interface CalendarConciergeExecutionContext {
  readonly grant: CalendarConciergeGrantV1
  readonly token: OpaqueCalendarConciergeGrantToken
  readonly binding: CalendarConciergeExecutionBinding
  readonly resolver: CalendarConciergeGrantResolver
  readonly execution: CalendarConciergeExecutionAdapter
  readonly port: CalendarConciergeJobPort
  readonly attendeeEmail: string
  readonly attendeeDisplayName?: string
  readonly finalize: (input: Readonly<{
    readonly result: CalendarConciergeTerminalResult
    readonly reportText: string
    readonly commitMessage: string
    readonly publicationId: string
  }>) => Promise<void>
}

export interface CalendarConciergeExecutorIntegration {
  readonly prepare: (input: Readonly<{
    readonly run: CalendarRun
    readonly observation: CalendarAttendeeObservationRecord
    readonly revision: CalendarSourceRevisionRecord
  }>) => Promise<CalendarConciergeExecutionContext>
}

const parseSource = (sourceEventId: string | null): Readonly<{ readonly revision: string; readonly emailDigest: string }> | undefined => {
  const prefix = `${CALENDAR_ATTENDEE_OBSERVED_EVENT}:`
  if (sourceEventId === null || !sourceEventId.startsWith(prefix)) return undefined
  const [revision, emailDigest, ...extra] = sourceEventId.slice(prefix.length).split(":")
  return revision && emailDigest && extra.length === 0 ? { revision, emailDigest } : undefined
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

const commitMessage = (verb: string): string => `Calendar relationship concierge: ${verb}.`

const attendeeLabel = (displayName: string | undefined): string => {
  const safeDisplayName = displayName?.trim()
  return safeDisplayName === undefined || safeDisplayName.length === 0
    ? "a newly observed attendee"
    : safeDisplayName
}

const terminalSummary = (displayName: string | undefined): string =>
  `Linked calendar attendee ${attendeeLabel(displayName)} to a Person and recorded the relationship.`

export class CalendarConciergeExecutor {
  constructor(
    private readonly workspaceId: EntityId,
    private readonly runtime: DurableWorkforceRuntimeStore,
    private readonly collections: CalendarCollections,
    private readonly integration?: CalendarConciergeExecutorIntegration
  ) {}

  async execute(run: CalendarRun): Promise<void> {
    const token = run.claimToken
    if (token === null) return
    const terminal = (state: "blocked" | "skipped", message: string) => {
      const finished = this.runtime.finish(run.id, token, state, new Date(), message)
      // A lease may expire between the claim and this terminal disposition. Do not report a
      // successful terminalization in that case; leave a still-owned claim retryable when the
      // lease is live, or let `nextDueAt()` wake the expired claim for reclamation.
      if (!finished) {
        const current = this.runtime.get(run.id)
        if (current?.state === "claimed" && current.claimToken === token) {
          this.runtime.retry(run.id, token, new Date(), message)
        }
      }
    }
    if (run.workflowId !== CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW || run.scheduleVersion !== CALENDAR_RELATIONSHIP_CONCIERGE_VERSION) {
      terminal("skipped", "Run does not match the calendar concierge definition.")
      return
    }
    const source = parseSource(run.sourceEventId)
    if (source === undefined) {
      terminal("skipped", "Run has no valid private calendar observation identity.")
      return
    }
    const observations = Effect.runSync(this.collections.calendarAttendeeObservations.byWorkspaceId.get(this.workspaceId))
    const observation = observations.find((value) => value.sourceRevisionDigest === source.revision && value.emailDigest === source.emailDigest)
    const revisions = Effect.runSync(this.collections.calendarSourceRevisions.byWorkspaceId.get(this.workspaceId))
    const revision = revisions.find((value) => value.sourceRevisionDigest === source.revision)
    if (observation === undefined || revision === undefined || revision.status === "cancelled") {
      terminal("skipped", "Calendar observation is stale, absent, or cancelled.")
      return
    }
    // A provider cancellation or newer revision can be committed after the observation was
    // enqueued but before the alarm claims it. Do this durable revision fence before `prepare`
    // (which needs the event attendee payload and therefore cannot safely inspect a tombstone).
    const latestRevision = revisions
      .filter((candidate) => candidate.bindingId === revision.bindingId && candidate.providerEventId === revision.providerEventId)
      .sort((left, right) => {
        const leftAt = Date.parse(left.sourceUpdatedAt ?? left.appliedAt)
        const rightAt = Date.parse(right.sourceUpdatedAt ?? right.appliedAt)
        return leftAt === rightAt
          ? left.sourceRevisionDigest.localeCompare(right.sourceRevisionDigest)
          : leftAt - rightAt
      })
      .at(-1)
    if (latestRevision?.sourceRevisionDigest !== revision.sourceRevisionDigest || latestRevision.status === "cancelled") {
      terminal("skipped", "Calendar observation is stale, absent, or cancelled.")
      return
    }
    if (this.integration === undefined) {
      terminal("blocked", "Calendar concierge integration is not configured.")
      return
    }

    try {
      const context = await this.integration.prepare({ run, observation, revision })
      const capability = createCalendarConciergeJobCapability({
        token: context.token,
        binding: context.binding,
        resolver: context.resolver,
        execution: context.execution,
        port: context.port
      })
      const observed = capability.readObservedAttendee()
      if (observed === undefined || observed.observationId !== observation.id || observed.sourceRevisionDigest !== revision.sourceRevisionDigest) {
        terminal("skipped", "Calendar observation changed before the employee could act.")
        return
      }
      let person = capability.resolveUniquePersonByEmailDigest(observed.emailDigest)
      let report: string
      if (person === undefined) {
        person = capability.createCalendarPerson(observed.emailDigest, commitMessage("create a Person for a newly observed attendee"))
        report = terminalSummary(context.attendeeDisplayName)
      } else {
        report = `Calendar relationship concierge reused the existing Person for ${attendeeLabel(context.attendeeDisplayName)}.`
      }
      capability.recordCalendarRelationshipObservation(person.personId, commitMessage("record the attendee relationship"))
      const staged = capability.publishRunTerminal("completed", report, commitMessage("publish the employee outcome"))
      await context.finalize({
        result: "completed",
        reportText: report,
        commitMessage: commitMessage("publish the employee outcome"),
        publicationId: staged.publicationId
      })
      const finished = this.runtime.finish(run.id, token, "completed", new Date(), report)
      if (!finished) {
        const current = this.runtime.get(run.id)
        if (current?.state === "claimed" && current.claimToken === token) {
          this.runtime.retry(run.id, token, new Date(), "calendar concierge lease expired before terminalization")
        }
      }
    } catch (error) {
      const message = errorText(error)
      const retried = this.runtime.retry(run.id, token, new Date(), message)
      if (retried === undefined) this.runtime.finish(run.id, token, "failed", new Date(), message)
    }
  }
}
