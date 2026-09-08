import { describe, expect, it } from "vitest"
import {
  CALENDAR_CONCIERGE_CAPABILITY_VERSION,
  CalendarConciergeCapabilityError,
  createCalendarConciergeJobCapability,
  type CalendarConciergeExecutionBinding,
  type CalendarConciergeGrantV1,
  type CalendarConciergeJobPort,
  type CalendarConciergeExecutionAdapter,
  type CalendarConciergeGrantResolver,
  type OpaqueCalendarConciergeGrantToken
} from "../src/calendar-concierge-job-capability.js"

const token = (): OpaqueCalendarConciergeGrantToken => ({ private: true } as unknown as OpaqueCalendarConciergeGrantToken)
const grant = (overrides: Partial<CalendarConciergeGrantV1> = {}): CalendarConciergeGrantV1 => ({
  version: CALENDAR_CONCIERGE_CAPABILITY_VERSION, grantId: "grant-1", grantRecordVersion: "1", workspaceId: "workspace-a",
  microEmployee: { kind: "microEmployee", id: "relationship-concierge", version: "v1" }, job: { kind: "job", id: "enrich-attendee", version: "v1" }, workflow: { kind: "workflow", id: "calendar-relationship", version: "v1" },
  runId: "run-1", claimToken: "claim-token-1", claimFence: 7, observationId: "attendee-observation-1", sourceRevisionDigest: "sha256:source-v1", policyGeneration: "policy-3",
  issuedAt: "2026-08-30T08:00:00.000Z", expiresAt: "2026-08-30T09:00:00.000Z",
  allowedTools: ["readObservedAttendee", "resolveUniquePersonByEmailDigest", "createCalendarPerson", "recordCalendarRelationshipObservation", "publishRunTerminal"], ...overrides
})
const binding = (value: CalendarConciergeGrantV1): CalendarConciergeExecutionBinding => ({
  workspaceId: value.workspaceId, microEmployee: value.microEmployee, job: value.job, workflow: value.workflow, runId: value.runId,
  claimToken: value.claimToken, claimFence: value.claimFence, observationId: value.observationId, sourceRevisionDigest: value.sourceRevisionDigest, policyGeneration: value.policyGeneration
})

const fixture = (options: { readonly grantValue?: CalendarConciergeGrantV1; readonly fresh?: boolean; readonly live?: boolean; readonly now?: string } = {}) => {
  const value = options.grantValue ?? grant()
  const calls: unknown[] = []
  const resolver: CalendarConciergeGrantResolver = { resolve: () => value, recheckFresh: () => ({ status: options.fresh === false ? "denied" : "admitted" }) }
  const execution: CalendarConciergeExecutionAdapter = { assertLiveClaim: () => ({ status: options.live === false ? "denied" : "admitted" }) }
  const port: CalendarConciergeJobPort = {
    readObservedAttendee: (input) => { calls.push(input); return { observationId: input.observationId, emailDigest: "sha256:email", sourceRevisionDigest: input.sourceRevisionDigest } },
    resolveUniquePersonByEmailDigest: (input) => { calls.push(input); return { personId: "person-1" } },
    createCalendarPerson: (input) => { calls.push(input); return { personId: "person-created" } },
    recordCalendarRelationshipObservation: (input) => { calls.push(input) },
    publishRunTerminal: (input) => { calls.push(input); return { publicationId: "publication-1" } }
  }
  const capability = createCalendarConciergeJobCapability({ token: token(), binding: binding(value), resolver, execution, port, now: () => new Date(options.now ?? "2026-08-30T08:30:00.000Z") })
  return { value, calls, capability }
}

describe("calendar concierge job capability", () => {
  it("passes only bound custody to each named tool and carries commit reasons on every mutation", () => {
    const { capability, calls } = fixture()
    expect(capability.readObservedAttendee()).toMatchObject({ emailDigest: "sha256:email" })
    expect(capability.resolveUniquePersonByEmailDigest("sha256:email")).toEqual({ personId: "person-1" })
    expect(capability.createCalendarPerson("sha256:email", "Create a person for the observed attendee.")).toEqual({ personId: "person-created" })
    capability.recordCalendarRelationshipObservation("person-created", "Link the observed attendee to this person.")
    expect(capability.publishRunTerminal("completed", "Linked the new attendee.", "Publish the concierge outcome.")).toEqual({ publicationId: "publication-1" })
    expect(calls).toHaveLength(5)
    for (const call of calls) expect(call).toMatchObject({ custody: { workspaceId: "workspace-a", actorId: "workforce:employee:relationship-concierge", runId: "run-1", claimFence: 7, policyGeneration: "policy-3" } })
    expect(calls[2]).toMatchObject({ commitMessage: "Create a person for the observed attendee." })
    expect(calls[3]).toMatchObject({ commitMessage: "Link the observed attendee to this person." })
    expect(calls[4]).toMatchObject({ commitMessage: "Publish the concierge outcome." })
  })

  it("rejects wrong workspace, job, or source binding before a port callback", () => {
    for (const patch of [
      { workspaceId: "workspace-b" },
      { job: { kind: "job" as const, id: "other-job", version: "v1" } },
      { sourceRevisionDigest: "sha256:other" }
    ]) {
      const value = grant()
      const { calls } = fixture({ grantValue: value })
      const wrong = { ...binding(value), ...patch } as CalendarConciergeExecutionBinding
      expect(() => createCalendarConciergeJobCapability({ token: token(), binding: wrong, resolver: { resolve: () => value, recheckFresh: () => ({ status: "admitted" }) }, execution: { assertLiveClaim: () => ({ status: "admitted" }) }, port: { readObservedAttendee: () => { calls.push("unexpected"); return undefined }, resolveUniquePersonByEmailDigest: () => undefined, createCalendarPerson: () => ({ personId: "unexpected" }), recordCalendarRelationshipObservation: () => {}, publishRunTerminal: () => ({ publicationId: "unexpected" }) } })).toThrow(CalendarConciergeCapabilityError)
      expect(calls).toHaveLength(0)
    }
  })

  it("fails closed for expired, revoked, and stale-lease grants", () => {
    expect(() => fixture({ now: "2026-08-30T09:00:00.000Z" }).capability.readObservedAttendee()).toThrow(/expired/)
    expect(() => fixture({ fresh: false }).capability.readObservedAttendee()).toThrow(/revoked|fresh/)
    expect(() => fixture({ live: false }).capability.readObservedAttendee()).toThrow(/claim is stale/)
  })

  it("does not let an employee reuse a capability after terminal publication", () => {
    const { capability, calls } = fixture()
    capability.publishRunTerminal("completed", "Done.", "Publish completion.")
    expect(() => capability.readObservedAttendee()).toThrow(/already used/)
    expect(calls).toHaveLength(1)
  })

  it("rejects an unregistered or ungranted tool without invoking a port", () => {
    expect(() => fixture({ grantValue: grant({ allowedTools: ["readObservedAttendee"] }) }).capability.createCalendarPerson("sha256:email", "Create person.")).toThrow(/not allowed/)
    expect(() => fixture({ grantValue: { ...grant(), allowedTools: ["readObservedAttendee", "deleteEverything" as never] } }).capability.readObservedAttendee()).toThrow(/registered concierge tool/)
  })
})
