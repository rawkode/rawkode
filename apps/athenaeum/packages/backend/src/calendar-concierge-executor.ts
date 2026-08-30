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

const terminalSummary = (displayName: string | undefined, email: string): string =>
  `Linked calendar attendee ${displayName ?? email} to a Person and recorded the relationship.`

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
      this.runtime.finish(run.id, token, state, new Date(), message)
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
        report = terminalSummary(context.attendeeDisplayName, context.attendeeEmail)
      } else {
        report = `Calendar relationship concierge reused the existing Person for ${context.attendeeDisplayName ?? context.attendeeEmail}.`
      }
      capability.recordCalendarRelationshipObservation(person.personId, commitMessage("record the attendee relationship"))
      const staged = capability.publishRunTerminal("completed", report, commitMessage("publish the employee outcome"))
      await context.finalize({
        result: "completed",
        reportText: report,
        commitMessage: commitMessage("publish the employee outcome"),
        publicationId: staged.publicationId
      })
      this.runtime.finish(run.id, token, "completed", new Date(), report)
    } catch (error) {
      const message = errorText(error)
      const retried = this.runtime.retry(run.id, token, new Date(), message)
      if (retried === undefined) this.runtime.finish(run.id, token, "failed", new Date(), message)
    }
  }
}
