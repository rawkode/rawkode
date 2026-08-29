import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import * as Effect from "effect/Effect"
import {
  ListCalendarEventsInput,
  type CalendarEvent,
  type CalendarEventTime
} from "@athenaeum/domain"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { localDayWindow } from "./day-window.js"
import { localDateStamp, parseDateStamp, shiftDateStamp } from "./daily-note-id.js"

const formatDateTime = (value: string, timeZone?: string): string => {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone
    }).format(new Date(timestamp))
  } catch {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp))
  }
}

const formatEventTime = (time: CalendarEventTime): string => {
  if (time.kind === "date") return "All day"
  return formatDateTime(time.dateTime, time.timeZone)
}

const formatEventRange = (event: CalendarEvent): string => {
  if (event.start.kind === "date" && event.end.kind === "date") return "All day"
  return `${formatEventTime(event.start)} – ${formatEventTime(event.end)}`
}

const attendeeSummary = (event: CalendarEvent): string => {
  const names = event.attendees.map((attendee) => attendee.displayName ?? attendee.email)
  if (names.length <= 3) return names.join(", ")
  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`
}

export function CalendarEventsPanel() {
  const navigate = useNavigate()
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshClaimed, setRefreshClaimed] = useState(false)
  const refreshClaim = useRef<{ readonly dateStamp: string; sawLoading: boolean } | undefined>(undefined)
  // Calendar history is a retrieval surface, not a second calendar model. Keep the exact same
  // local-day semantics as the daily-note route and ask the existing bounded read RPC for that
  // day. A stamp (rather than `Date`) is stable in state and safe to put straight into the daily
  // note URL when the user wants to write alongside their schedule.
  const [dateStamp, setDateStamp] = useState(() => localDateStamp(new Date()))
  const todayStamp = localDateStamp(new Date())
  const isToday = dateStamp === todayStamp
  const effect = useMemo(() => {
    const window = localDayWindow(parseDateStamp(dateStamp) ?? new Date())
    return WorkspaceRpcClient.pipe(
      Effect.flatMap((client) =>
        client.listCalendarEvents(new ListCalendarEventsInput({ workspaceId, from: window.from, to: window.to }))
      )
    )
  }, [dateStamp, refreshKey])
  const state = useEffectQuery(effect, [dateStamp, refreshKey])

  useEffect(() => {
    const claim = refreshClaim.current
    if (claim === undefined) return
    if (claim.dateStamp !== dateStamp) {
      refreshClaim.current = undefined
      setRefreshClaimed(false)
      return
    }
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The refresh-key render still contains the preceding settled result. Keep the visible
    // claim until this day's read has entered loading and then reached a terminal state.
    if (!claim.sawLoading) return
    refreshClaim.current = undefined
    setRefreshClaimed(false)
  }, [dateStamp, state.status])

  const refresh = useCallback(() => {
    if (refreshClaim.current !== undefined || state.status === "loading") return
    refreshClaim.current = { dateStamp, sawLoading: false }
    setRefreshClaimed(true)
    setRefreshKey((value) => value + 1)
  }, [dateStamp, state.status])

  useEffect(() => {
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [refresh])

  const isRefreshing = refreshClaimed || state.status === "loading"

  const events = state.status === "success"
    ? [...state.value.events].sort((left, right) => eventSortKey(left).localeCompare(eventSortKey(right)))
    : []

  return (
    <section className="calendar-events-panel" aria-labelledby="calendar-events-title">
      <header className="calendar-events-heading">
        <div>
          <span className="section-kicker">Workspace schedule</span>
          <h2 id="calendar-events-title">{isToday ? "Today’s events" : "Events"}</h2>
        </div>
        <div className="calendar-events-heading-actions">
          <nav className="calendar-events-day-nav" aria-label="Calendar day">
            <button
              type="button"
              className="calendar-events-day-nav-step"
              onClick={() => setDateStamp(shiftDateStamp(dateStamp, -1))}
              aria-label="Previous day"
              title="Previous day"
            >
              ‹
            </button>
            <input
              type="date"
              className="calendar-events-day-nav-date"
              value={dateStamp}
              onChange={(event) => {
                // Browsers emit `change` for a temporarily empty or impossible date while the
                // control is being edited. Retain the last real day instead of querying a bad
                // range or turning the daily-note handoff into a malformed URL.
                if (parseDateStamp(event.target.value) !== undefined) setDateStamp(event.target.value)
              }}
              aria-label="Choose calendar day"
            />
            <button
              type="button"
              className="calendar-events-day-nav-step"
              onClick={() => setDateStamp(shiftDateStamp(dateStamp, 1))}
              aria-label="Next day"
              title="Next day"
            >
              ›
            </button>
            {!isToday && (
              <button
                type="button"
                className="calendar-events-day-nav-today"
                onClick={() => setDateStamp(todayStamp)}
              >
                Today
              </button>
            )}
          </nav>
          <button
            type="button"
            className="calendar-events-open-note"
            onClick={() => navigate(isToday ? "/notes" : `/notes?date=${dateStamp}`)}
          >
            Open daily note
          </button>
          <button
            type="button"
            className="calendar-events-refresh"
            onClick={refresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {state.status === "loading" && (
        <p className="calendar-events-state" role="status">
          Loading {isToday ? "today’s" : dateStamp} events…
        </p>
      )}
      {state.status === "failure" && (
        <section className="calendar-events-load-state" role="alert" aria-label="Calendar events are unavailable">
          <div>
            <p className="calendar-events-load-title">Calendar events are unavailable</p>
            <p>The schedule could not be loaded. Nothing has been changed. Retry to check this day again.</p>
          </div>
          <button type="button" onClick={refresh} disabled={isRefreshing}>
            {isRefreshing ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {state.status === "success" && events.length === 0 && (
        <p className="calendar-events-state">No events are synced for {isToday ? "today" : dateStamp}.</p>
      )}
      {events.length > 0 && (
        <ol className="calendar-events-list">
          {events.map((event) => (
            <li key={event.id} className={`calendar-event-row calendar-event-row-${event.status}`}>
              <div className="calendar-event-time">{formatEventRange(event)}</div>
              <div className="calendar-event-content">
                <div className="calendar-event-title-row">
                  <h3>{event.title || "Untitled event"}</h3>
                  {event.status !== "confirmed" && <span className="calendar-event-status">{event.status}</span>}
                </div>
                {attendeeSummary(event) !== "" && <p className="calendar-event-attendees">{attendeeSummary(event)}</p>}
                {event.linkedNodeId !== undefined ? (
                  <button
                    type="button"
                    className="calendar-event-link"
                    onClick={() => navigate(`/node/${event.linkedNodeId}`)}
                  >
                    Open linked entity →
                  </button>
                ) : (
                  <span className="calendar-event-unlinked">Not linked to an entity</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function eventSortKey(event: CalendarEvent): string {
  return event.start.kind === "date" ? `${event.start.date}T00:00:00.000Z` : event.start.dateTime
}
