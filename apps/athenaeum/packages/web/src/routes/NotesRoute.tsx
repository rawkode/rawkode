import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"
import { DailyNote } from "../DailyNote.js"
import { TodayBrief, type TodayBriefEvent, type TodayBriefPrepareMeeting } from "../TodayBrief.js"
import type { LocalDate } from "@athenaeum/domain"
import type { PrepareMeetingHandler } from "../LoroRichNoteEditor.js"
import { localDateStamp, parseDateStamp } from "../daily-note-id.js"

// One file per routed section (task item 3), so a later restyling pass can rework exactly this
// view without touching `router.tsx`/`AppShell.tsx`/any other route. Wraps the existing, fully
// working `DailyNote` (which already renders its own nested `Backlinks` section) unchanged — this
// pass is shell/routing/visual-system work, not a data-layer or feature rewrite, and "route stub"
// here means "one file this section owns," not "delete the working feature and leave it empty."
//
// Refinement pass (live-screenshot finding): the route-level header duplicated the note's own
// header. The note now owns the one visible `h1`, so this route composes the primary writing
// surface before its secondary daily context without adding another title block.
//
// Retrieval pass (design-review 2026-08-22 finding #1, "Day navigation"): this route now owns the
// `?date=YYYY-MM-DD` query param — no param (or a malformed/impossible date) means today, so the
// existing `/notes` URL keeps its exact behavior. `DailyNote` is keyed by the resolved stamp: a
// day change is a clean remount (fresh resolve/query state and fresh format-aware sync-session
// handles, per each session handle's one-per-resolved-note contract) rather than an in-place
// re-resolve. Past days are read-write in the same editor — same deterministic-id resolve-or-create
// + sync mechanism, different day.
export function NotesRoute() {
  const navigate = useNavigate()
  const onOpenPerson = useCallback((personNodeId: string) => navigate(`/node/${personNodeId}`), [navigate])
  const [searchParams, setSearchParams] = useSearchParams()
  const rawDate = searchParams.get("date")
  const [todayStamp, setTodayStamp] = useState(() => localDateStamp(new Date()))

  useEffect(() => {
    const now = new Date()
    const nextLocalMidnight = new Date(now)
    nextLocalMidnight.setHours(24, 0, 0, 0)
    const timer = window.setTimeout(
      () => setTodayStamp(localDateStamp(new Date())),
      Math.max(1000, nextLocalMidnight.getTime() - now.getTime())
    )
    return () => window.clearTimeout(timer)
  }, [todayStamp])

  const date = useMemo(() => {
    const requestedDate = rawDate === null ? undefined : parseDateStamp(rawDate)
    return requestedDate ?? parseDateStamp(todayStamp) ?? new Date()
  }, [rawDate, todayStamp])
  const stamp = localDateStamp(date)
  const isToday = stamp === todayStamp
  const routeIdentity = useMemo(() => ({ stamp, generation: Symbol(stamp) }), [stamp])
  const activeRouteIdentityRef = useRef<typeof routeIdentity | undefined>(undefined)
  const [prepareMeetingRegistration, setPrepareMeetingRegistration] = useState<{
    readonly routeIdentity: typeof routeIdentity
    readonly prepareMeeting: TodayBriefPrepareMeeting
  } | undefined>(undefined)

  // Query/history/midnight changes render once before their new DailyNote can register. Activate
  // the new generation and discard any previous generation's availability in layout so stale
  // callbacks cannot cross that render boundary.
  useLayoutEffect(() => {
    activeRouteIdentityRef.current = routeIdentity
    setPrepareMeetingRegistration((current) => current?.routeIdentity === routeIdentity ? current : undefined)
  }, [routeIdentity])

  const registerPrepareMeeting = useCallback((identity: typeof routeIdentity) => (prepare: PrepareMeetingHandler | undefined) => {
    if (activeRouteIdentityRef.current !== identity) return
    if (prepare === undefined) {
      setPrepareMeetingRegistration((current) => current?.routeIdentity === identity ? undefined : current)
      return
    }
    const prepareMeeting: TodayBriefPrepareMeeting = async (event: TodayBriefEvent, localDate: LocalDate, timeZone) => {
      if (activeRouteIdentityRef.current !== identity) {
        throw new Error("The Loro daily note is not ready yet")
      }
      await prepare({
        localDate,
        timeZone,
        occurrenceKey: event.occurrenceKey,
        commitMessage: `Prepare “${event.title || "this meeting"}” in the daily note.`
      })
    }
    setPrepareMeetingRegistration({ routeIdentity: identity, prepareMeeting })
  }, [])

  const onPrepareMeetingReady = useMemo(() => registerPrepareMeeting(routeIdentity), [registerPrepareMeeting, routeIdentity])

  const navigateToDate = (nextStamp: string) => {
    if (nextStamp !== stamp) {
      activeRouteIdentityRef.current = undefined
      setPrepareMeetingRegistration(undefined)
    }
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
      <div className="notes-layout">
        <DailyNote
          key={stamp}
          date={date}
          onNavigateDate={navigateToDate}
          onPrepareMeetingReady={onPrepareMeetingReady}
          todayBriefTargetId={isToday ? "today-brief" : undefined}
        />
        <div className="notes-context-column">
          <TodayBrief
            id={isToday ? "today-brief" : undefined}
            reference={date}
            isToday={isToday}
            onPrepareMeeting={prepareMeetingRegistration?.routeIdentity === routeIdentity ? prepareMeetingRegistration.prepareMeeting : undefined}
            onOpenPerson={onOpenPerson}
          />
        </div>
      </div>
    </div>
  )
}
