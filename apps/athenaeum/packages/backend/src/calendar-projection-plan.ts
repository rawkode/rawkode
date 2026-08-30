/** Deterministic, backend-private planning for a fetched provider event. This is deliberately
 * separate from provider I/O and the atomic gateway so retries/reordered attendee lists yield
 * the same revision and attendee observation identities. */
import { canonicalJsonBytes, sha256HexSync, type EntityId } from "@athenaeum/domain"
import type { RemoteCalendarEvent } from "./calendar-gatekeeper-client.js"
import { calendarAttendeeDigest, hmacSha256Hex } from "./calendar-identity-digest.js"

export interface CalendarRemoteEventPlan {
  readonly workspaceId: EntityId
  readonly bindingId: EntityId
  readonly remote: RemoteCalendarEvent
  readonly sourceRevisionDigest: string
  readonly sourceUpdatedAt?: string
  /** Stable, opaque identity for the provider event across revisions. It is used only for
   * private attendee-observation de-duplication; it never leaves the Workspace DO. */
  readonly sourceEventKeyDigest: string
  readonly attendeeObservationDigests: ReadonlyArray<string>
  readonly cancelled: boolean
}

const normalizedEmail = (email: string): string => email.trim().toLowerCase()

/** Google emits originalStartTime as either an all-day date or a date-time. Normalize a valid
 * instant so equivalent timezone spellings retain the same recurring occurrence identity; keep
 * malformed legacy fixture values verbatim rather than fabricating a different occurrence. */
const normalizedOriginalStartTime = (time: RemoteCalendarEvent["start"]): unknown => {
  if (time.kind === "date") return { kind: "date", date: time.date }
  const parsed = Date.parse(time.dateTime)
  return {
    kind: "dateTime",
    dateTime: Number.isFinite(parsed) ? new Date(parsed).toISOString() : time.dateTime
  }
}

const stableSourceEventIdentity = (workspaceId: EntityId, bindingId: EntityId, remote: RemoteCalendarEvent): Record<string, unknown> =>
  remote.recurringEventId === undefined
    ? { kind: "standalone", workspaceId, bindingId, providerEventId: remote.id }
    : {
        kind: "occurrence",
        workspaceId,
        bindingId,
        recurringEventId: remote.recurringEventId,
        originalStartTime: normalizedOriginalStartTime(remote.originalStartTime ?? remote.start)
      }

/** Digest inputs deliberately include raw private provider values only before hashing. The
 * resulting plan can safely feed durable event/outbox payloads. */
export const planCalendarRemoteEvent = (
  workspaceId: EntityId,
  bindingId: EntityId,
  remote: RemoteCalendarEvent
): CalendarRemoteEventPlan => {
  const attendeeEmails = [...new Set((remote.attendees ?? []).map((attendee) => normalizedEmail(attendee.email)).filter(Boolean))].sort()
  const workflowVersion = "calendar-relationship-concierge.v1"
  const sourceEventKeyDigest = sha256HexSync(canonicalJsonBytes(stableSourceEventIdentity(workspaceId, bindingId, remote)))
  const sourceRevisionDigest = sha256HexSync(canonicalJsonBytes({
    workspaceId, bindingId, providerEventId: remote.id, recurringEventId: remote.recurringEventId ?? null,
    originalStartTime: remote.recurringEventId === undefined ? null : normalizedOriginalStartTime(remote.originalStartTime ?? remote.start),
    updatedAt: remote.updatedAt ?? null,
    title: remote.title, start: remote.start, end: remote.end, status: remote.status,
    attendees: attendeeEmails, workflowVersion
  }))
  return {
    workspaceId, bindingId, remote, sourceRevisionDigest,
    ...(remote.updatedAt === undefined ? {} : { sourceUpdatedAt: remote.updatedAt }),
    sourceEventKeyDigest,
    // Workspace-scoped rather than provider-event scoped: the concierge can resolve the same
    // Person across repeated meetings and multiple connected calendars without learning the
    // address itself. The event-specific sourceEventKeyDigest keeps observations distinct.
    attendeeObservationDigests: attendeeEmails.map((email) => sha256HexSync(canonicalJsonBytes({ workspaceId, email }))),
    cancelled: remote.status === "cancelled"
  }
}

/** Production planner. The sync-only planner above remains available for deterministic pure
 * tests and migration tooling; provider writes use this keyed variant so attendee identity never
 * crosses the DO boundary as a dictionary-testable plain hash. */
export const planCalendarRemoteEventWithSecret = async (
  workspaceId: EntityId,
  bindingId: EntityId,
  remote: RemoteCalendarEvent,
  attendeeDigestSecret: string
): Promise<CalendarRemoteEventPlan> => {
  const plan = planCalendarRemoteEvent(workspaceId, bindingId, remote)
  const emails = [...new Set((remote.attendees ?? []).map((attendee) => normalizedEmail(attendee.email)).filter(Boolean))].sort()
  const attendeeObservationDigests = await Promise.all(
    emails.map((email) => calendarAttendeeDigest(attendeeDigestSecret, workspaceId, email))
  )
  // The pure planner remains useful for migration fixtures, but production projections must not
  // expose a dictionary-testable digest of either an email or a provider event id. Re-key both
  // identities here; the raw provider payload remains inside this DO call only.
  const sourceEventKeyDigest = await hmacSha256Hex(
    attendeeDigestSecret,
    canonicalJsonBytes({
      domain: "athenaeum.calendar-source-event.v1",
      ...stableSourceEventIdentity(workspaceId, bindingId, remote)
    })
  )
  const sourceRevisionDigest = await hmacSha256Hex(
    attendeeDigestSecret,
    canonicalJsonBytes({
      domain: "athenaeum.calendar-source-revision.v1",
      workspaceId,
      bindingId,
      providerEventId: remote.id,
      recurringEventId: remote.recurringEventId ?? null,
      originalStartTime: remote.recurringEventId === undefined ? null : normalizedOriginalStartTime(remote.originalStartTime ?? remote.start),
      updatedAt: remote.updatedAt ?? null,
      title: remote.title,
      start: remote.start,
      end: remote.end,
      status: remote.status,
      attendees: emails,
      workflowVersion: "calendar-relationship-concierge.v1"
    })
  )
  return { ...plan, sourceRevisionDigest, sourceEventKeyDigest, attendeeObservationDigests }
}
