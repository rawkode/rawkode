import { GetTodayBriefInput, IanaTimeZone, LocalDate, type EntityId } from "@athenaeum/domain"
import * as Schema from "effect/Schema"
import { localDateStamp } from "./daily-note-id.js"

/** Resolve the browser's explicit IANA zone; never silently substitute UTC. */
export const browserTimeZone = (): IanaTimeZone => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!timeZone) throw new Error("The browser did not provide an IANA time zone")
  return Schema.decodeUnknownSync(IanaTimeZone)(timeZone)
}

/** Build the server-owned Today Brief request for the browser's local calendar day. */
export const todayBriefRequest = (
  workspaceId: EntityId,
  reference: Date = new Date(),
  timeZone: IanaTimeZone = browserTimeZone()
): GetTodayBriefInput =>
  new GetTodayBriefInput({
    workspaceId,
    localDate: Schema.decodeUnknownSync(LocalDate)(localDateStamp(reference)),
    timeZone: Schema.decodeUnknownSync(IanaTimeZone)(timeZone)
  })
