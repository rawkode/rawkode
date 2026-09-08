import * as Schema from "effect/Schema"
import { IsoDateTimeString } from "@athenaeum/domain"

// Shared by `CalendarDayView.tsx` — "today" bounds in the BROWSER'S local timezone (matching
// `daily-note-id.ts`'s own `localDateStamp`'s "the user's own calendar day, not whatever the
// server's clock/timezone happens to be" reasoning), converted to UTC `IsoDateTimeString` for
// `ListCalendarEventsInput.from`/`.to` (`calendar-service-live.ts#listEvents`'s own `[from, to)`
// filter, `gatekeeper-rpc.ts`'s doc comment on `ListCalendarEventsInput`).

const toIso = (date: Date): IsoDateTimeString => Schema.decodeUnknownSync(IsoDateTimeString)(date.toISOString())

/** `[from, to)` for the local calendar day containing `reference` (defaults to now). */
export const localDayWindow = (
  reference: Date = new Date()
): { readonly from: IsoDateTimeString; readonly to: IsoDateTimeString } => {
  const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), 0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { from: toIso(start), to: toIso(end) }
}
