import * as Schema from "effect/Schema"
import { EntityId } from "@athenaeum/domain"

// "Resolve or create today's note" (task: "a view that resolves/creates 'today's' note ...
// deterministic id from date"). `EntityId` only accepts a ULID or a UUID (node.ts), so — same
// reasoning `tag.ts`'s `BaseTagIds` doc comment already spells out for the Base Tags — a literal
// slug like `"daily-2026-08-20"` isn't a legal id without weakening that schema for every other
// entity, and a real UUIDv5 needs a hashing dependency this app doesn't otherwise carry.
//
// The scheme here reuses the same trick `BaseTagIds` uses (decimal digits are also valid hex
// digits, so a plain calendar date embeds directly into a syntactically-valid UUID): id =
// `00000000-0000-4000-8000-` + the date's `YYYYMMDD` digits, zero-padded to 12 hex characters.
// The `4000-8000` group deliberately differs from `BaseTagIds`' all-zero groups (which are
// `00000000-0000-0000-0000-00000000000N`) purely so the two reserved-id families can never
// collide with each other by construction, not because either group carries real UUIDv4
// version/variant meaning here.
//
// Deterministic per local calendar date: the same device, same day, always resolves to the same
// id — which is exactly what lets the daily-note flow do `getNode(id)` first and only
// `createNode` on `NodeNotFound`, instead of needing a server-side "find-or-create by title"
// query that doesn't exist on this RPC surface.

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** `YYYY-MM-DD` for `date`, in the browser's local timezone (not UTC) — "today" should mean the
 *  user's own calendar day, not whatever the server's clock/timezone happens to be. */
export const localDateStamp = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

export const dailyNoteIdForDate = (date: Date): EntityId => {
  const yyyymmdd = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
  const suffix = yyyymmdd.padStart(12, "0")
  return Schema.decodeUnknownSync(EntityId)(`00000000-0000-4000-8000-${suffix}`)
}

export const dailyNoteTitleForDate = (date: Date): string => `Daily Note — ${localDateStamp(date)}`

export const todayDailyNoteId: EntityId = dailyNoteIdForDate(new Date())
export const todayDailyNoteTitle: string = dailyNoteTitleForDate(new Date())

// --- Retrieval pass (design-review 2026-08-22 finding #1: "no way in the UI to open any note
// except today's") — the day-navigation route (`/notes?date=YYYY-MM-DD`) and the node view both
// need the two inverse operations of the scheme above: "is this stamp a real calendar date?" (to
// validate the query param) and "is this node id a daily note, and for which day?" (so
// `/node/:id` can offer "open in the daily editor"). Both are pure string/date functions on the
// exact same encoding `dailyNoteIdForDate` writes — no new id scheme, no schema change.

const DATE_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAILY_NOTE_ID_RE = /^00000000-0000-4000-8000-0000(\d{4})(\d{2})(\d{2})$/

/** Parses a `YYYY-MM-DD` stamp into a local-timezone `Date` at midnight — `undefined` for
 *  anything malformed OR non-real (e.g. `2026-02-31`), checked by round-tripping the constructed
 *  `Date` back through its own components (JS `Date` silently rolls invalid days forward). */
export const parseDateStamp = (stamp: string): Date | undefined => {
  const match = DATE_STAMP_RE.exec(stamp)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined
  }
  return date
}

/** The inverse of `dailyNoteIdForDate`: `YYYY-MM-DD` when `id` is a daily-note id whose embedded
 *  digits form a real calendar date, `undefined` for every other id (including ids in the
 *  reserved family with impossible dates — validated via `parseDateStamp` above, not just the
 *  regex, so a hand-crafted `…-000099999999` id never reads as a daily note). */
export const dateStampFromDailyNoteId = (id: string): string | undefined => {
  const match = DAILY_NOTE_ID_RE.exec(id)
  if (!match) return undefined
  const stamp = `${match[1]}-${match[2]}-${match[3]}`
  return parseDateStamp(stamp) === undefined ? undefined : stamp
}

/** `stamp` shifted by `deltaDays` whole days, in local time — drives the prev/next-day controls.
 *  Callers pass a stamp that already went through `parseDateStamp`, so the non-null assertion via
 *  fallback-to-today never fires in practice; it exists to keep this total rather than throwing. */
export const shiftDateStamp = (stamp: string, deltaDays: number): string => {
  const date = parseDateStamp(stamp) ?? new Date()
  date.setDate(date.getDate() + deltaDays)
  return localDateStamp(date)
}
