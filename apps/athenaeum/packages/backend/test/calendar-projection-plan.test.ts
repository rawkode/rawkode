import { describe, expect, it } from "vitest"
import { planCalendarRemoteEvent, planCalendarRemoteEventWithSecret } from "../src/calendar-projection-plan.js"

const workspaceId = "00000000-0000-4000-8000-000000000001" as const
const bindingId = "00000000-0000-4000-8000-000000000002" as const
const event = (attendees: ReadonlyArray<{ email: string }>, status: "confirmed" | "cancelled" = "confirmed") => ({
  id: "provider-private-id", title: "Private meeting", start: { kind: "dateTime" as const, dateTime: "2026-08-30T10:00:00.000Z" },
  end: { kind: "dateTime" as const, dateTime: "2026-08-30T11:00:00.000Z" }, status, attendees
})

describe("CalendarRemoteEventPlan", () => {
  it("is invariant to duplicate and reordered attendees", () => {
    const left = planCalendarRemoteEvent(workspaceId, bindingId, event([{ email: "A@example.test" }, { email: "b@example.test" }, { email: "a@example.test" }]))
    const right = planCalendarRemoteEvent(workspaceId, bindingId, event([{ email: "b@example.test" }, { email: "a@example.test" }]))
    expect(left.sourceRevisionDigest).toBe(right.sourceRevisionDigest)
    expect(left.attendeeObservationDigests).toEqual(right.attendeeObservationDigests)
  })
  it("changes revisions for cancellation while retaining a workspace-wide opaque Person key", () => {
    const confirmed = planCalendarRemoteEvent(workspaceId, bindingId, event([{ email: "a@example.test" }]))
    const cancelled = planCalendarRemoteEvent(workspaceId, bindingId, event([{ email: "a@example.test" }], "cancelled"))
    const otherBinding = planCalendarRemoteEvent(workspaceId, "00000000-0000-4000-8000-000000000003", event([{ email: "a@example.test" }]))
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.sourceRevisionDigest).not.toBe(confirmed.sourceRevisionDigest)
    // Different accounts observing the same address should converge on one second-brain Person;
    // only the source-event key stays binding-specific.
    expect(otherBinding.attendeeObservationDigests).toEqual(confirmed.attendeeObservationDigests)
    expect(otherBinding.sourceEventKeyDigest).not.toEqual(confirmed.sourceEventKeyDigest)
    expect(confirmed.sourceRevisionDigest).not.toContain("a@example.test")
    expect(confirmed.attendeeObservationDigests.join(":")) .not.toContain("a@example.test")
  })
  it("keys production attendee identities to the workspace secret", async () => {
    const lower = await planCalendarRemoteEventWithSecret(workspaceId, bindingId, event([{ email: "A@example.test" }]), "secret-a")
    const upper = await planCalendarRemoteEventWithSecret(workspaceId, bindingId, event([{ email: "a@EXAMPLE.test" }]), "secret-a")
    const otherSecret = await planCalendarRemoteEventWithSecret(workspaceId, bindingId, event([{ email: "a@example.test" }]), "secret-b")
    expect(lower.attendeeObservationDigests).toEqual(upper.attendeeObservationDigests)
    expect(lower.attendeeObservationDigests).not.toEqual(otherSecret.attendeeObservationDigests)
    expect(lower.attendeeObservationDigests).not.toEqual(planCalendarRemoteEvent(workspaceId, bindingId, event([{ email: "a@example.test" }])).attendeeObservationDigests)
    expect(lower.sourceRevisionDigest).not.toBe(otherSecret.sourceRevisionDigest)
    expect(lower.sourceEventKeyDigest).not.toBe(otherSecret.sourceEventKeyDigest)
    expect(lower.sourceRevisionDigest).not.toBe(planCalendarRemoteEvent(workspaceId, bindingId, event([{ email: "a@example.test" }])).sourceRevisionDigest)
  })
  it("keeps recurring attendee observations stable across provider instance aliases while revisions remain distinct", async () => {
    const originalStartTime = { kind: "dateTime" as const, dateTime: "2026-09-07T09:00:00.000Z" }
    const recurring = (id: string, status: "confirmed" | "cancelled") => ({
      ...event([{ email: "a@example.test" }], status),
      id,
      recurringEventId: "weekly-series",
      originalStartTime
    })
    const first = planCalendarRemoteEvent(workspaceId, bindingId, recurring("instance-a", "confirmed"))
    const cancelled = planCalendarRemoteEvent(workspaceId, bindingId, recurring("instance-b", "cancelled"))
    const restored = await planCalendarRemoteEventWithSecret(workspaceId, bindingId, recurring("instance-c", "confirmed"), "secret-a")
    const firstSecret = await planCalendarRemoteEventWithSecret(workspaceId, bindingId, recurring("instance-a", "confirmed"), "secret-a")

    expect(cancelled.sourceEventKeyDigest).toBe(first.sourceEventKeyDigest)
    expect(cancelled.sourceRevisionDigest).not.toBe(first.sourceRevisionDigest)
    expect(restored.sourceEventKeyDigest).toBe(firstSecret.sourceEventKeyDigest)
    expect(restored.sourceRevisionDigest).not.toBe(firstSecret.sourceRevisionDigest)
  })
})
