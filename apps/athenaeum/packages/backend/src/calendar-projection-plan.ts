/** Deterministic, backend-private planning for a fetched provider event. This is deliberately
 * separate from provider I/O and the atomic gateway so retries/reordered attendee lists yield
 * the same revision and attendee observation identities. */
import { canonicalJsonBytes, sha256HexSync, type EntityId } from "@athenaeum/domain"
import type { RemoteCalendarEvent } from "./calendar-gatekeeper-client.js"

export interface CalendarRemoteEventPlan {
  readonly workspaceId: EntityId
  readonly bindingId: EntityId
  readonly remote: RemoteCalendarEvent
  readonly sourceRevisionDigest: string
  /** Stable, opaque identity for the provider event across revisions. It is used only for
   * private attendee-observation de-duplication; it never leaves the Workspace DO. */
  readonly sourceEventKeyDigest: string
  readonly attendeeObservationDigests: ReadonlyArray<string>
  readonly cancelled: boolean
}

const normalizedEmail = (email: string): string => email.trim().toLowerCase()

/** Digest inputs deliberately include raw private provider values only before hashing. The
 * resulting plan can safely feed durable event/outbox payloads. */
export const planCalendarRemoteEvent = (
  workspaceId: EntityId,
  bindingId: EntityId,
  remote: RemoteCalendarEvent
): CalendarRemoteEventPlan => {
  const attendeeEmails = [...new Set((remote.attendees ?? []).map((attendee) => normalizedEmail(attendee.email)).filter(Boolean))].sort()
  const workflowVersion = "calendar-relationship-concierge.v1"
  const sourceEventKeyDigest = sha256HexSync(canonicalJsonBytes({ workspaceId, bindingId, providerEventId: remote.id }))
  const sourceRevisionDigest = sha256HexSync(canonicalJsonBytes({
    workspaceId, bindingId, providerEventId: remote.id, recurringEventId: remote.recurringEventId ?? null,
    title: remote.title, start: remote.start, end: remote.end, status: remote.status,
    attendees: attendeeEmails, workflowVersion
  }))
  return {
    workspaceId, bindingId, remote, sourceRevisionDigest, sourceEventKeyDigest,
    attendeeObservationDigests: attendeeEmails.map((email) => sha256HexSync(canonicalJsonBytes({
      workspaceId, bindingId, providerEventId: remote.id, email
    }))),
    cancelled: remote.status === "cancelled"
  }
}
