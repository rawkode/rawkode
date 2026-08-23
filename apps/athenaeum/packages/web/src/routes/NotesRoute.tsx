import { useSearchParams } from "react-router"
import { DailyNote } from "../DailyNote.js"
import { localDateStamp, parseDateStamp } from "../daily-note-id.js"

// One file per routed section (task item 3), so a later restyling pass can rework exactly this
// view without touching `router.tsx`/`AppShell.tsx`/any other route. Wraps the existing, fully
// working `DailyNote` (which already renders its own nested `Backlinks` section) unchanged — this
// pass is shell/routing/visual-system work, not a data-layer or feature rewrite, and "route stub"
// here means "one file this section owns," not "delete the working feature and leave it empty."
//
// Refinement pass (live-screenshot finding): the route-level header here duplicated the note's
// own header inside `DailyNote` — two "DAILY NOTE" eyebrows and two page titles stacked on top of
// each other, plus a developer-facing Automerge subtitle no user needs. The note's own header
// ("Daily note" eyebrow + weekday + date) is now the ONE visible heading block; this route keeps a
// real (screen-reader-only) `h1` so the document outline still starts at level 1 — the a11y-audit
// pass's every-route-has-an-h1 requirement stands, it's just no longer a second visible title.
//
// Retrieval pass (design-review 2026-08-22 finding #1, "Day navigation"): this route now owns the
// `?date=YYYY-MM-DD` query param — no param (or a malformed/impossible date) means today, so the
// existing `/notes` URL keeps its exact behavior. `DailyNote` is keyed by the resolved stamp: a
// day change is a clean remount (fresh resolve/query state and a fresh Automerge sync-session
// handle, per `SyncSessionHandle`'s one-per-resolved-note contract) rather than an in-place
// re-resolve. Past days are read-write in the same editor — same deterministic-id resolve-or-create
// + sync mechanism, different day.
export function NotesRoute() {
  const [searchParams, setSearchParams] = useSearchParams()
  const rawDate = searchParams.get("date")
  const parsed = rawDate === null ? undefined : parseDateStamp(rawDate)
  const date = parsed ?? new Date()
  const stamp = localDateStamp(date)

  const navigateToDate = (nextStamp: string) => {
    if (nextStamp === localDateStamp(new Date())) {
      // Today keeps the canonical param-less URL — one URL per state, and reloading `/notes`
      // tomorrow still means "today" rather than pinning yesterday.
      setSearchParams({}, { replace: false })
    } else {
      setSearchParams({ date: nextStamp }, { replace: false })
    }
  }

  return (
    <div className="route-view notes-route">
      <h1 className="sr-only">Daily note for {stamp}</h1>
      <DailyNote key={stamp} date={date} onNavigateDate={navigateToDate} />
    </div>
  )
}
