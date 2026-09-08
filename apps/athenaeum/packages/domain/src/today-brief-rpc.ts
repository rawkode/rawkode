import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"
import { LoroMutationIntentV1 } from "./page-document-rpc.js"

/** A calendar date, deliberately without a time or offset. The server resolves its local-day
 * boundaries from this value and the requested IANA time zone. */
export const LocalDate = Schema.String.pipe(
  Schema.filter((value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const [year, month, day] = value.split("-").map(Number)
    const candidate = new Date(Date.UTC(year!, month! - 1, day!))
    return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month! - 1 && candidate.getUTCDate() === day
  }, { message: () => "LocalDate must be a real YYYY-MM-DD date" }),
  Schema.brand("LocalDate")
)
export type LocalDate = typeof LocalDate.Type

/** Validated with the platform's ICU data so aliases are resolved by the server, not trusted from
 * the caller. `resolvedOptions().timeZone` is returned in the output. */
export const IanaTimeZone = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: value })
      return true
    } catch {
      return false
    }
  }, { message: () => "timeZone must be a valid IANA time zone" }),
  Schema.brand("IanaTimeZone")
)
export type IanaTimeZone = typeof IanaTimeZone.Type

/** Deliberately safe attendee projection. Calendar addresses and provider identifiers never
 * cross this boundary. `personNodeId` is present only after server-side validation. */
export class TodayBriefPerson extends Schema.Class<TodayBriefPerson>("TodayBriefPerson")({
  displayName: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  personNodeId: Schema.optional(EntityId)
}) {}

/** An occurrence (or standalone event) in the resolved local-day window. Series masters and
 * cancelled rows are excluded by the server projection. */
export class TodayBriefEvent extends Schema.Class<TodayBriefEvent>("TodayBriefEvent")({
  id: EntityId,
  /** Opaque stable occurrence identity; never a provider id. */
  occurrenceKey: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  title: Schema.String,
  start: IsoDateTimeString,
  end: IsoDateTimeString,
  people: Schema.Array(TodayBriefPerson)
}) {}

/** Server-derived preparation request: raw provider ids and CRDT bytes never cross this boundary. */
export class PrepareMeetingInDailyNoteInput extends Schema.Class<PrepareMeetingInDailyNoteInput>("PrepareMeetingInDailyNoteInput")({
  workspaceId: EntityId,
  dailyNoteId: EntityId,
  localDate: LocalDate,
  timeZone: IanaTimeZone,
  occurrenceKey: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  intent: LoroMutationIntentV1
}) {}

/** Digest-only receipt for a server-owned Loro preparation mutation. */
export class PrepareMeetingInDailyNoteOutput extends Schema.Class<PrepareMeetingInDailyNoteOutput>("PrepareMeetingInDailyNoteOutput")({
  dailyNoteId: EntityId,
  localDate: LocalDate,
  occurrenceKey: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  status: Schema.Literal("created", "alreadyPrepared"),
  resultSnapshotSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
}) {}

/** This is a statement only about Athenaeum's retained projection, never about the user's real
 * calendar. In particular, `noneInRetainedData` does not assert that no real-world events exist. */
export const TodayBriefHistoryStatus = Schema.Literal("found", "noneInRetainedData", "unavailable")
export type TodayBriefHistoryStatus = typeof TodayBriefHistoryStatus.Type

export class TodayBriefCalendarHistory extends Schema.Class<TodayBriefCalendarHistory>("TodayBriefCalendarHistory")({
  status: TodayBriefHistoryStatus
}) {}

export class GetTodayBriefInput extends Schema.Class<GetTodayBriefInput>("GetTodayBriefInput")({
  workspaceId: EntityId,
  localDate: LocalDate,
  timeZone: IanaTimeZone
}) {}

export class GetTodayBriefOutput extends Schema.Class<GetTodayBriefOutput>("GetTodayBriefOutput")({
  localDate: LocalDate,
  /** Canonical time-zone identifier resolved by the server's ICU database. */
  timeZone: IanaTimeZone,
  /** Inclusive local-day boundary, encoded as an instant. */
  from: IsoDateTimeString,
  /** Exclusive local-day boundary, encoded as an instant. */
  to: IsoDateTimeString,
  calendarHistory: TodayBriefCalendarHistory,
  events: Schema.Array(TodayBriefEvent)
}) {}
