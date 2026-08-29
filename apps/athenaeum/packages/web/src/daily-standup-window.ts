import { IsoDateTimeString } from "@athenaeum/domain"

/** Returns the browser-local calendar day as an instant window for the server's UTC ledger. */
export function dailyStandupWindow(now: Date = new Date()): {
  readonly from: typeof IsoDateTimeString.Type
  readonly to: typeof IsoDateTimeString.Type
} {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const to = new Date(from)
  to.setDate(to.getDate() + 1)
  return { from: IsoDateTimeString.make(from.toISOString()), to: IsoDateTimeString.make(to.toISOString()) }
}
