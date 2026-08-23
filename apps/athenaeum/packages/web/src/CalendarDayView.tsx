import { useEffect, useMemo, useState } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  ListCalendarEventsInput,
  SyncGoogleCalendarInput,
  type CalendarEvent,
  type CalendarEventTime,
  type EntityId
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { CALENDAR_BINDING_CHANGED_EVENT, loadCalendarBindingId } from "./calendar-binding-storage.js"
import { localDayWindow } from "./day-window.js"
import { localDateStamp } from "./daily-note-id.js"
import { formatDomainError } from "./format-domain-error.js"

// Web-stage task item 2: "A calendar-merged day view showing calendarEvents (once synced)
// alongside daily-note content, per the plan's 'unified day-plan view' spirit — can be minimal for
// Phase 5 (a simple list of today's events is fine...)." Rendered directly below `<DailyNote />`
// in `App.tsx`'s `Workspace` — literally "alongside daily-note content" on the page, not fused
// into one component (out of scope for Phase 5 per the task's own "minimal" allowance).
//
// Reads `listCalendarEvents` for the browser's local "today" window (`day-window.ts`) — the real
// `[from, to)` server-side filter `calendar-service-live.ts#listEvents` applies, proven correct by
// this component's own verification session (a fixture event scheduled for "tomorrow" does NOT
// appear here, only in a raw unfiltered read). Has no binding to sync until `CalendarPanel.tsx`'s
// connect flow — real or, for verification, `/__dev__/enable-scripted-calendar` (see
// `dev-scripted-calendar-client.ts`) — has completed; shows an honest empty/disconnected state
// until then, never a fake calendar preview.

const formatEventTime = (time: CalendarEventTime): string => {
  if (time.kind === "date") return time.date // all-day event
  const date = new Date(time.dateTime)
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

function EventRow({ event }: { readonly event: CalendarEvent }) {
  return (
    <li className={`calendar-event${event.status === "cancelled" ? " calendar-event-cancelled" : ""}`}>
      <span className="calendar-event-time">
        {formatEventTime(event.start)} – {formatEventTime(event.end)}
      </span>
      <span className="calendar-event-title">
        {event.title}
        {event.status === "cancelled" && " (cancelled)"}
      </span>
      {event.attendees.length > 0 && (
        <span className="calendar-event-attendees">
          {event.attendees.map((a) => a.displayName ?? a.email).join(", ")}
        </span>
      )}
    </li>
  )
}

export function CalendarDayView() {
  const [bindingId, setBindingId] = useState<EntityId | undefined>(() => loadCalendarBindingId(workspaceId))
  const [refreshKey, setRefreshKey] = useState(0)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncedOnce, setSyncedOnce] = useState(false)

  // Cross-tab pickup: `CalendarOAuthCallback.tsx` writes the binding id to `localStorage` from
  // whichever tab Google (or the scripted double's captured `state`) redirected back to — a
  // `storage` event fires in every OTHER same-origin tab when that happens, so a connect started
  // in this tab still reflects "now connected" without a manual reload. Same-tab pickup (found
  // live, via this stage's own browser verification — see `calendar-binding-storage.ts`'s own
  // header comment): `storage` never fires in the SAME document that wrote the key, so
  // `CalendarPanel.tsx`'s "Disconnect" button — a sibling reading the same key — needs its own
  // signal to reach this component in the SAME tab; `CALENDAR_BINDING_CHANGED_EVENT` is that
  // signal.
  useEffect(() => {
    const refresh = () => setBindingId(loadCalendarBindingId(workspaceId))
    window.addEventListener("storage", refresh)
    window.addEventListener(CALENDAR_BINDING_CHANGED_EVENT, refresh)
    return () => {
      window.removeEventListener("storage", refresh)
      window.removeEventListener(CALENDAR_BINDING_CHANGED_EVENT, refresh)
    }
  }, [])

  const window_ = useMemo(() => localDayWindow(), [refreshKey])

  const eventsEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.listCalendarEvents(new ListCalendarEventsInput({ workspaceId, from: window_.from, to: window_.to }))
        )
      ),
    [window_]
  )
  const eventsState = useEffectQuery(eventsEffect, [refreshKey, bindingId])

  const handleSync = () => {
    if (bindingId === undefined) return
    setSyncBusy(true)
    setSyncError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.syncGoogleCalendar(new SyncGoogleCalendarInput({ workspaceId, bindingId })))
      )
    )
    fiber.addObserver((exit) => {
      setSyncBusy(false)
      if (Exit.isSuccess(exit)) {
        setSyncedOnce(true)
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setSyncError("Sync failed — check the console for details")
        console.error(exit.cause.toString())
      }
    })
  }

  // `listCalendarEvents` returns rows in storage order, not chronological order (`calendar-
  // service-live.ts#listEvents` doc comment makes no sorting claim) — a day VIEW should read
  // top-to-bottom as the day unfolds, so this component sorts by start time itself. All-day
  // events (`kind: "date"`) sort before any timed event on the same day.
  const eventTimeValue = (time: CalendarEventTime): string => (time.kind === "date" ? time.date : time.dateTime)
  const events: ReadonlyArray<CalendarEvent> =
    eventsState.status === "success"
      ? [...eventsState.value.events].sort((a, b) => eventTimeValue(a.start).localeCompare(eventTimeValue(b.start)))
      : []

  return (
    <section className="calendar-day-view">
      <h2>Today — {localDateStamp(new Date())}</h2>

      {bindingId === undefined ? (
        <p className="calendar-day-view-empty">
          No Google Calendar connected for this workspace yet — connect it above to see today's events
          here.
        </p>
      ) : (
        <>
          <div className="calendar-day-view-controls">
            <button type="button" onClick={handleSync} disabled={syncBusy}>
              {syncBusy ? "Syncing…" : "Sync now"}
            </button>
            {syncedOnce && <span className="calendar-day-view-synced">Synced</span>}
          </div>
          {syncError !== null && <p className="error">{syncError}</p>}

          {eventsState.status === "loading" && <p>Loading…</p>}
          {eventsState.status === "failure" && <p className="error">{formatDomainError(eventsState.error)}</p>}
          {eventsState.status === "success" && events.length === 0 && (
            <p className="calendar-day-view-empty">No events today (or not synced yet — try "Sync now").</p>
          )}
          <ul className="calendar-event-list">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
