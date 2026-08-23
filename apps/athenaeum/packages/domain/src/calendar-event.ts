import * as Schema from "effect/Schema"
import { Email } from "./auth.js"
import { EntityId, IsoDateTimeString } from "./node.js"

// Phase 5 domain-extension task ("Extend packages/domain/src... per the plan's calendar/
// bookmarks/gatekeeper-binding design"), item 1: `CalendarEvent`. Shape and semantics per the
// task's own field list, cross-checked against `new-notes/docs/architecture.md`
// §"Google Calendar provider projection" (read in full for this stage, cited directly by the
// plan's "Google Calendar provider projection" paragraph) — the one production-validated design
// for exactly this problem ("provider-sourced fields are read-only; each event optionally links
// to a companion user-owned Node the user can annotate").
//
// **Provider-managed vs. user-owned split** (new-notes, verbatim): "Provider records are
// read-only, but every master and occurrence links to a separate user-owned Automerge note...
// Provider apply, cancellation, full-resync deletion, disconnect, and resurrection never write or
// delete that note." Ported here 1:1 onto Athenaeum's own Node/Page model: every field on
// `CalendarEvent` below except `linkedNodeId` is exclusively provider-sync-owned (a future
// `CalendarService`'s sync loop is the only writer); `linkedNodeId` alone is where a user's own
// annotation lives (as a `nodes`/`pages` row this schema only references, never embeds) — the
// calendar-merge logic that will write the other fields must never create, edit, or delete the
// node `linkedNodeId` points at, exactly as new-notes' own sync loop never touches its companion
// note. That companion node is deliberately not created automatically by this schema or any
// backend logic in this stage (schema-only) — see `linkedNodeId`'s own doc comment.
//
// **Recurring-event identity (`seriesId`/`occurrenceId`/`masterRecordId`)** — new-notes,
// verbatim: "Standalone events materialize one master record. Recurring events materialize a
// stable series master plus stable expanded occurrence records linked by masterRecordId,
// seriesId, and occurrenceId. Cancelling one occurrence tombstones only that occurrence.
// Reappearance restores the same IDs." Concretely, per Google Calendar's own event model (a
// recurring series' expanded instances are themselves full Event resources, each carrying the
// series master's own event id as `recurringEventId` — verified against
// https://developers.google.com/calendar/api/v3/reference/events during the Decisions pre-work
// stage, see docs/gatekeeper-google-calendar-decisions.md §1):
//   - A **standalone** (non-recurring) event: `providerEventId` is its own Google event id;
//     `seriesId`/`occurrenceId`/`masterRecordId` are all absent.
//   - The **series master** record (one per recurring series, mirroring the series' own defining
//     event): `providerEventId` is the master's own Google event id; `seriesId` is that SAME id
//     (a series' own stable identity, matching what Google's `recurringEventId` on every
//     occurrence points back at); `occurrenceId`/`masterRecordId` are absent (a master is not an
//     occurrence, and cannot be its own master).
//   - An **occurrence** record (one per expanded instance of a recurring series):
//     `providerEventId` is the instance's OWN Google event id (Google gives each expanded
//     instance a distinct id, conventionally `{masterEventId}_{originalStartTime}`);
//     `seriesId` is the master's Google event id (`recurringEventId` on the underlying Google
//     resource) — the value that ties every occurrence of one series together;
//     `masterRecordId` is this collection's OWN `EntityId` for the series-master `CalendarEvent`
//     row (an internal foreign key, NOT a Google id) — what lets a client resolve "which master
//     row does this occurrence belong to" with a single indexed lookup instead of a
//     `seriesId`-keyed scan; `occurrenceId` is a stable, PROVIDER-INDEPENDENT identifier for this
//     specific occurrence (its original scheduled start time, RFC3339, before this instance was
//     ever modified or cancelled) — kept deliberately distinct from `providerEventId` because
//     "reappearance restores the same IDs" is new-notes' own stated guarantee across a
//     cancel-then-reappear cycle, and Google's own per-instance event id is not documented as
//     immutable across that cycle the way an original start time inherently is.
export const CalendarEventTime = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("date"), date: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("dateTime"),
    dateTime: Schema.String,
    timeZone: Schema.optional(Schema.String)
  })
)
export type CalendarEventTime = typeof CalendarEventTime.Type

/** One attendee, per the task's own `{email, displayName?}` shape. `email` is the domain
 *  package's own `Email` brand (auth.ts) — not a bare string — for the same reason `Collaborator
 *  .profileId`/`UserEdge.sharerId` etc. all are: it is Athenaeum's one account-identity type, and
 *  an attendee's address is exactly that shape. Normalization (lower-casing) is the sync loop's
 *  job before constructing one, same "validate, don't normalize" discipline `Email`'s own header
 *  comment states — Google's Calendar API does not itself guarantee a lower-cased `email` field
 *  on the wire. */
export class CalendarEventAttendee extends Schema.Class<CalendarEventAttendee>(
  "CalendarEventAttendee"
)({
  email: Email,
  displayName: Schema.optional(Schema.String)
}) {}

/** Google's own three documented event statuses (verified live against
 *  https://developers.google.com/calendar/api/v3/reference/events during the Decisions stage —
 *  see `gatekeeper-google-calendar`'s own `calendar-types.ts`, which this literal matches
 *  exactly, since both packages independently verified the same source). Not reused directly
 *  from that package (`@athenaeum/domain` has zero dependency on any gatekeeper package, per the
 *  plan's package-layering direction — gatekeepers depend on `domain`, never the reverse); kept
 *  in sync by citing the same verified source, not by a shared import. */
export const CalendarEventStatus = Schema.Literal("confirmed", "tentative", "cancelled")
export type CalendarEventStatus = typeof CalendarEventStatus.Type

/**
 * A single calendar-event row, provider-sourced (Google Calendar today; the `providerEventId`/
 * `seriesId`/`occurrenceId` fields are deliberately provider-agnostic strings, not
 * Google-specific types, so a future second calendar provider could populate the same collection
 * shape). See this file's header comment for the full field-by-field rationale.
 */
export class CalendarEvent extends Schema.Class<CalendarEvent>("CalendarEvent")({
  id: EntityId,
  workspaceId: EntityId,
  /** The provider's own event id for THIS record — see header comment for what "this record"
   *  means for a standalone event vs. a series master vs. an occurrence. */
  providerEventId: Schema.String.pipe(Schema.minLength(1)),
  seriesId: Schema.optional(Schema.String),
  occurrenceId: Schema.optional(Schema.String),
  masterRecordId: Schema.optional(EntityId),
  title: Schema.String,
  start: CalendarEventTime,
  end: CalendarEventTime,
  attendees: Schema.Array(CalendarEventAttendee),
  status: CalendarEventStatus,
  /** The companion user-owned node, per the header comment's "provider records are read-only,
   *  but every master and occurrence links to a separate user-owned... note" design. Absent until
   *  a user (or a future `linkCalendarEventToNode`/`linkCalendarEvent` agent-tool call,
   *  gatekeeper-rpc.ts / agent-tools.ts) explicitly creates and links one — this schema takes no
   *  position on whether that happens eagerly (one companion node auto-created per synced event)
   *  or lazily (only once a user actually wants to annotate); new-notes' own design supports
   *  either, and Athenaeum's calendar-merge implementation (a later stage) is where that policy
   *  choice actually gets made. */
  linkedNodeId: Schema.optional(EntityId),
  /** When this row was last written by the provider sync loop — distinct from any Google-side
   *  "updated" timestamp on the underlying event resource, which this schema does not carry (the
   *  provider's own change-tracking lives in the sync feed / `syncToken` state, not duplicated
   *  onto every row). */
  syncedAt: IsoDateTimeString
}) {}
