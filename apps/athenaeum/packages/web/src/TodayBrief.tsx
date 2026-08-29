import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Effect from "effect/Effect"
import type { GetTodayBriefOutput, LocalDate } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { formatTodayBriefError } from "./today-brief-errors.js"
import { todayBriefRequest } from "./today-brief-request.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"

const timeFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit" })

const defaultClock = (): Date => new Date()

const formatHistory = (status: GetTodayBriefOutput["calendarHistory"]["status"]): string => {
  if (status === "found") return "Calendar history available"
  if (status === "noneInRetainedData") return "No calendar history retained for this day"
  return "Calendar history unavailable"
}

export type TodayBriefEventState = "active" | "past" | "upcoming"

export type TodayBriefSchedule = {
  readonly active: readonly GetTodayBriefOutput["events"][number][]
  readonly activeIndexes: readonly number[]
  readonly past: readonly GetTodayBriefOutput["events"][number][]
  readonly pastIndexes: readonly number[]
  readonly upcoming: readonly GetTodayBriefOutput["events"][number][]
  readonly upcomingIndexes: readonly number[]
  readonly next: readonly GetTodayBriefOutput["events"][number][]
  readonly nextIndexes: readonly number[]
}

export type TodayBriefEvent = GetTodayBriefOutput["events"][number]

export type TodayBriefPrepareMeeting = (event: TodayBriefEvent, localDate: LocalDate, timeZone: GetTodayBriefOutput["timeZone"]) => Promise<void>

/** An occurrence is identified by its source position, never its provider id. */
export function todayBriefScheduleSignature(schedule: TodayBriefSchedule, events: readonly TodayBriefEvent[]): string {
  // `events` is retained in the API for callers that already pass the source
  // list, but occurrence identity is positional. An object may intentionally
  // occur more than once, so an object-identity map would collapse entries.
  void events
  const signature = (name: string, indexes: readonly number[]) => `${name}:${indexes.join(",")}`
  return [signature("active", schedule.activeIndexes), signature("next", schedule.nextIndexes), signature("upcoming", schedule.upcomingIndexes), signature("past", schedule.pastIndexes)].join("|")
}

function localDateAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
  return `${part("year")}-${part("month")}-${part("day")}`
}

/** The next instant that is no longer part of this server-projected civil day. */
export function nextTodayBriefMidnight(localDate: string, timeZone: string, now: Date): Date | undefined {
  if (localDateAt(now, timeZone) !== localDate) return undefined
  let low = now.getTime()
  let high = low + 30 * 60 * 60 * 1000 // Covers the longest civil day, including DST fall-back.
  if (localDateAt(new Date(high), timeZone) === localDate) return undefined
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2)
    if (localDateAt(new Date(middle), timeZone) === localDate) low = middle
    else high = middle
  }
  return new Date(high)
}

/** Returns one coalesced future boundary for a loaded current-day brief. */
export function nextTodayBriefBoundary(value: GetTodayBriefOutput, now: Date): Date | undefined {
  const timestamp = now.getTime()
  const eventBoundaries = value.events.flatMap((event) => [Date.parse(event.start), Date.parse(event.end)]).filter((time) => Number.isFinite(time) && time > timestamp)
  const midnight = nextTodayBriefMidnight(value.localDate, value.timeZone, now)?.getTime()
  return Math.min(...(midnight === undefined ? eventBoundaries : [...eventBoundaries, midnight])) === Infinity
    ? undefined
    : new Date(Math.min(...(midnight === undefined ? eventBoundaries : [...eventBoundaries, midnight])))
}

/** Projects server-ordered events without sorting or dropping any occurrence. */
export function projectTodayBriefSchedule(
  events: readonly GetTodayBriefOutput["events"][number][],
  now: Date
): TodayBriefSchedule {
  const timestamp = now.getTime()
  const active: GetTodayBriefOutput["events"][number][] = []
  const activeIndexes: number[] = []
  const past: GetTodayBriefOutput["events"][number][] = []
  const pastIndexes: number[] = []
  const upcoming: GetTodayBriefOutput["events"][number][] = []
  const upcomingIndexes: number[] = []

  events.forEach((event, index) => {
    const start = Date.parse(event.start)
    const end = Date.parse(event.end)
    if (Number.isFinite(start) && Number.isFinite(end) && start < end && start <= timestamp && timestamp < end) {
      active.push(event)
      activeIndexes.push(index)
    } else if ((Number.isFinite(end) && end <= timestamp) || start >= timestamp || !Number.isFinite(start)) {
      if (Number.isFinite(start) && start >= timestamp) {
        upcoming.push(event)
        upcomingIndexes.push(index)
      } else {
        past.push(event)
        pastIndexes.push(index)
      }
    } else {
      upcoming.push(event)
      upcomingIndexes.push(index)
    }
  })

  const earliest = upcoming.reduce<number | undefined>((value, event) => {
    const start = Date.parse(event.start)
    return value === undefined || start < value ? start : value
  }, undefined)

  return {
    active,
    past,
    upcoming,
    next: earliest === undefined ? [] : upcoming.filter((event) => Date.parse(event.start) === earliest),
    activeIndexes,
    pastIndexes,
    upcomingIndexes,
    nextIndexes: earliest === undefined ? [] : upcomingIndexes.filter((index) => Date.parse(events[index].start) === earliest)
  }
}

export function TodayBrief({ id, reference = new Date(), isToday = true, clock = defaultClock, onPrepareMeeting }: { readonly id?: string; readonly reference?: Date; readonly isToday?: boolean; readonly clock?: () => Date; readonly onPrepareMeeting?: TodayBriefPrepareMeeting }) {
  const [now, setNow] = useState<Date | undefined>(() => isToday ? clock() : undefined)
  const [stale, setStale] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshClaimed, setRefreshClaimed] = useState(false)
  const refreshClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)
  const request = useMemo(() => todayBriefRequest(workspaceId, reference), [reference])
  const query = useEffectQuery(
    WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.getTodayBrief(request))),
    [request, refreshKey]
  )
  useEffect(() => {
    const claim = refreshClaim.current
    if (claim === undefined) return
    if (query.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The render that changes `refreshKey` still observes the prior settled result. Release only
    // after this claimed generation has visibly entered loading and subsequently settled.
    if (!claim.sawLoading) return
    refreshClaim.current = undefined
    setRefreshClaimed(false)
  }, [query.status])
  const onBoundary = useCallback((next: Date, isStale: boolean) => {
    setNow(next)
    setStale(isStale)
  }, [])
  const refresh = useCallback(() => {
    if (refreshClaim.current !== undefined || query.status === "loading") return
    refreshClaim.current = { sawLoading: false }
    setRefreshClaimed(true)
    setNow(isToday ? clock() : undefined)
    setStale(false)
    setRefreshKey((value) => value + 1)
  }, [clock, isToday, query.status])
  const isRefreshing = refreshClaimed || query.status === "loading"

  // A date/clock change starts a new projection.  In particular, a stale brief for a
  // previous route must not keep its stale state when the caller supplies a new day.
  useEffect(() => {
    setNow(isToday ? clock() : undefined)
    setStale(false)
  }, [isToday, reference])

  return (
    <aside id={id} className="today-brief" aria-labelledby="today-brief-title">
      <div className="today-brief-heading">
        <div>
          <span className="section-kicker">Daily context</span>
          <h2 id="today-brief-title">{isToday ? "Today’s brief" : "Daily brief"}</h2>
        </div>
        <div className="today-brief-heading-actions">
          {query.status === "success" && <span className="today-brief-date">{query.value.localDate}</span>}
          <button
            type="button"
            className="today-brief-refresh"
            onClick={refresh}
            disabled={isRefreshing}
            aria-label={`Refresh ${isToday ? "today’s" : "daily"} brief`}
          >
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {query.status === "loading" && (
        <p className="today-brief-state" role="status">Loading {isToday ? "today’s" : "daily"} brief&hellip;</p>
      )}
      {query.status === "failure" && <p className="today-brief-state error" role="alert">{formatTodayBriefError(query.error)}</p>}
      {query.status === "success" && <TodayBriefFreshness value={query.value} isToday={isToday} now={now} stale={stale} clock={clock} onBoundary={onBoundary} onRefresh={refresh} isRefreshing={isRefreshing} onPrepareMeeting={onPrepareMeeting} />}
    </aside>
  )
}

export function TodayBriefFreshness({ value, isToday, now, stale, clock, onBoundary, onRefresh, isRefreshing = false, onPrepareMeeting }: { readonly value: GetTodayBriefOutput; readonly isToday: boolean; readonly now: Date | undefined; readonly stale: boolean; readonly clock: () => Date; readonly onBoundary: (now: Date, stale: boolean) => void; readonly onRefresh?: () => void; readonly isRefreshing?: boolean; readonly onPrepareMeeting?: TodayBriefPrepareMeeting }) {
  const generation = useRef(0)
  const visible = useRef(typeof document === "undefined" || document.visibilityState === "visible")
  useEffect(() => {
    if (!isToday || stale || now === undefined) return
    let cleanup: (() => void) | undefined
    const schedule = (reconcile: boolean): (() => void) | undefined => {
      generation.current += 1
      const activeGeneration = generation.current
      const current = clock()
      const isStale = localDateAt(current, value.timeZone) !== value.localDate
      if (reconcile) onBoundary(current, isStale)
      if (isStale) {
        return
      }
      const boundary = nextTodayBriefBoundary(value, current)
      if (boundary === undefined) return
      const timer = window.setTimeout(() => {
        if (activeGeneration !== generation.current || !visible.current) return
        cleanup?.()
        cleanup = undefined
        schedule(true)
      }, Math.max(0, boundary.getTime() - current.getTime()))
      return () => window.clearTimeout(timer)
    }
    const reschedule = () => {
      visible.current = document.visibilityState === "visible"
      cleanup?.()
      cleanup = undefined
      // A browser may be hidden across one or more boundaries.  Resume from the
      // cached projection immediately, then arm only the next future boundary.
      if (visible.current) cleanup = schedule(true)
    }
    cleanup = schedule(false)
    document.addEventListener("visibilitychange", reschedule)
    return () => { generation.current += 1; cleanup?.(); document.removeEventListener("visibilitychange", reschedule) }
  }, [clock, isToday, now, onBoundary, stale, value])
  return stale ? (
    <div className="today-brief-stale" role="status">
      <p className="today-brief-state">This brief is no longer current.</p>
      {onRefresh !== undefined && <button type="button" className="today-brief-refresh" onClick={onRefresh} disabled={isRefreshing}>{isRefreshing ? "Refreshing…" : "Refresh brief"}</button>}
    </div>
  ) : <TodayBriefContent value={value} isToday={isToday} now={now} onPrepareMeeting={onPrepareMeeting} />
}

function TodayBriefContent({ value, isToday, now, onPrepareMeeting }: { readonly value: GetTodayBriefOutput; readonly isToday: boolean; readonly now: Date | undefined; readonly onPrepareMeeting?: TodayBriefPrepareMeeting }) {
  const formatter = timeFormatter(value.timeZone)
  const schedule = isToday && now !== undefined ? projectTodayBriefSchedule(value.events, now) : undefined
  const isEmptyCurrentDaySchedule = schedule !== undefined && schedule.active.length === 0 && schedule.upcoming.length === 0 && schedule.past.length === 0
  const renderEvents = (events: readonly GetTodayBriefOutput["events"][number][], label: string, allowPreparation = true) => (
    <section aria-labelledby={`today-brief-${label}`}>
      <h3 id={`today-brief-${label}`}>{label}</h3>
      {events.length === 0 ? <p className="today-brief-state">No events.</p> : <EventList events={events} formatter={formatter} localDate={value.localDate} timeZone={value.timeZone} onPrepareMeeting={onPrepareMeeting} allowPreparation={allowPreparation} sectionLabel={label} />}
    </section>
  )
  const previousSignature = useRef<string | undefined>(undefined)
  const announcement = schedule === undefined ? undefined : (() => {
    const signature = todayBriefScheduleSignature(schedule, value.events)
    const changed = previousSignature.current !== undefined && previousSignature.current !== signature
    previousSignature.current = signature
    return changed ? "Schedule updated" : undefined
  })()
  return (
    <>
      <details className="today-brief-history" open>
        <summary>Calendar history</summary>
        <p>{formatHistory(value.calendarHistory.status)}</p>
      </details>
      {schedule === undefined
        ? renderEvents(value.events, "schedule", isToday)
        : isEmptyCurrentDaySchedule
          ? <p className="today-brief-state">No events today. Use your daily note to set priorities.</p>
          : <>
            {renderEvents(schedule.active, "active")}
            {renderEvents(schedule.next, "next")}
            {renderEvents(schedule.upcoming.filter((_, index) => !schedule.nextIndexes.includes(schedule.upcomingIndexes[index])), "later")}
            {renderEvents(schedule.past, "past", false)}
          </>}
      {announcement !== undefined && <p className="sr-only" role="status">{announcement}</p>}
    </>
  )
}

function EventList({ events, formatter, localDate, timeZone, onPrepareMeeting, allowPreparation, sectionLabel }: { readonly events: readonly GetTodayBriefOutput["events"][number][]; readonly formatter: Intl.DateTimeFormat; readonly localDate: LocalDate; readonly timeZone: GetTodayBriefOutput["timeZone"]; readonly onPrepareMeeting?: TodayBriefPrepareMeeting; readonly allowPreparation: boolean; readonly sectionLabel: string }) {
  const [states, setStates] = useState<Record<string, "preparing" | "prepared" | "error">>({})
  const preparingOccurrenceKeys = useRef(new Set<string>())
  const preparationReady = onPrepareMeeting !== undefined
  const prepare = async (event: TodayBriefEvent): Promise<void> => {
    const occurrenceKey = event.occurrenceKey
    if (onPrepareMeeting === undefined || preparingOccurrenceKeys.current.has(occurrenceKey) || states[occurrenceKey] === "prepared") return
    preparingOccurrenceKeys.current.add(occurrenceKey)
    setStates((current) => ({ ...current, [event.occurrenceKey]: "preparing" }))
    try {
      await onPrepareMeeting(event, localDate, timeZone)
      setStates((current) => ({ ...current, [event.occurrenceKey]: "prepared" }))
    } catch {
      setStates((current) => ({ ...current, [event.occurrenceKey]: "error" }))
    } finally {
      preparingOccurrenceKeys.current.delete(occurrenceKey)
    }
  }
  return <ul className="today-brief-events">{events.map((event, occurrence) => {
    const preparationState = states[event.occurrenceKey]
    const preparationStatus = preparationState === "preparing"
      ? "Preparing meeting in daily note."
      : preparationState === "prepared"
        ? "Meeting added to daily note."
        : undefined
    return <li key={`${event.occurrenceKey}-${occurrence}`} className="today-brief-event">
      <time dateTime={event.start}>{formatter.format(new Date(event.start))}</time>
      <div className="today-brief-event-content"><strong>{event.title}</strong>{event.people.length > 0 && <span>{event.people.map((person) => person.displayName).filter(Boolean).join(", ")}</span>}
        {allowPreparation && <div className="today-brief-event-action">
          <button type="button" className="today-brief-prepare" onClick={preparationReady ? () => void prepare(event) : undefined} disabled={!preparationReady || preparationState === "preparing" || preparationState === "prepared"} aria-describedby={preparationReady ? undefined : `today-brief-preparation-readiness-${sectionLabel}-${occurrence}`}>
            {preparationState === "preparing" ? "Preparing…" : preparationState === "prepared" ? "Added to daily note" : preparationReady ? "Prepare in daily note" : "Daily note not ready"}
          </button>
          {preparationStatus !== undefined && <span className="sr-only today-brief-preparation-status" role="status" aria-live="polite" aria-atomic="true">{preparationStatus}</span>}
          {!preparationReady && <span id={`today-brief-preparation-readiness-${sectionLabel}-${occurrence}`} className="today-brief-state">This daily note is not ready for meeting preparation.</span>}
          {preparationState === "error" && <span className="today-brief-event-error" role="alert">Couldn’t prepare — try again.</span>}
        </div>}
      </div>
    </li>
  })}</ul>
}
