/** Safe deterministic alarm handler while grant issuance and standup admission are pending. */
import * as Effect from "effect/Effect"
import type { EntityId } from "@athenaeum/domain"
import type { CalendarCollections } from "./calendar-collections.js"
import { CALENDAR_ATTENDEE_OBSERVED_EVENT, CALENDAR_RELATIONSHIP_CONCIERGE_VERSION, CALENDAR_RELATIONSHIP_CONCIERGE_WORKFLOW } from "./calendar-projection-gateway.js"
import { DurableWorkforceRuntimeStore } from "./workforce-runtime-store.js"

const parseSource = (sourceEventId: string | null): Readonly<{ readonly revision: string; readonly emailDigest: string }> | undefined => {
  const prefix = `${CALENDAR_ATTENDEE_OBSERVED_EVENT}:`
  if (sourceEventId === null || !sourceEventId.startsWith(prefix)) return undefined
  const [revision, emailDigest, ...extra] = sourceEventId.slice(prefix.length).split(":")
  return revision && emailDigest && extra.length === 0 ? { revision, emailDigest } : undefined
}

export class CalendarConciergeExecutor {
  constructor(private readonly workspaceId: EntityId, private readonly runtime: DurableWorkforceRuntimeStore, private readonly collections: CalendarCollections) {}
  async execute(run: NonNullable<ReturnType<DurableWorkforceRuntimeStore["claimDue"]>>): Promise<void> {
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
    terminal("blocked", "Calendar concierge awaits durable grant issuance and standup admission.")
  }
}
