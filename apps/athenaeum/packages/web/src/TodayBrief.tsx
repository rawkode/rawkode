import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react"
import * as Effect from "effect/Effect"
import type { GetTodayBriefOutput, LocalDate } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { todayBriefFailurePresentation } from "./today-brief-errors.js"
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

export type TodayBriefSectionKind = "active" | "next" | "later" | "earlier" | "schedule"

export type TodayBriefSection = {
  readonly kind: TodayBriefSectionKind
  readonly label: string
  readonly events: readonly TodayBriefEvent[]
  readonly deferred: boolean
  readonly allowPreparation: boolean
}

export type TodayBriefFocus = {
  readonly kind: "active" | "next"
  readonly label: "Now" | "Up next"
  readonly events: readonly TodayBriefEvent[]
  /** Source positions keep duplicate provider occurrences independent. */
  readonly indexes: readonly number[]
}

type TodayBriefPreparationState = "preparing" | "prepared" | "error"
type TodayBriefPreparationStates = Record<string, TodayBriefPreparationState>

/**
 * Keeps the current-day brief focused on work that needs attention while preserving every event
 * behind keyboard-accessible disclosures. Historical notes intentionally use one unclassified
 * schedule: live clock projection would mislabel a past note as if it were still Today.
 */
export function projectTodayBriefSections(
  events: readonly TodayBriefEvent[],
  isToday: boolean,
  schedule?: TodayBriefSchedule
): readonly TodayBriefSection[] {
  if (!isToday) {
    return [{ kind: "schedule", label: "Schedule", events, deferred: false, allowPreparation: false }]
  }
  if (schedule === undefined) return []
  const sections: TodayBriefSection[] = [
    { kind: "active", label: "Active", events: schedule.active, deferred: false, allowPreparation: true },
    { kind: "next", label: "Up next", events: schedule.next, deferred: false, allowPreparation: true },
    {
      kind: "later",
      label: "Later",
      events: schedule.upcoming.filter((_, index) => !schedule.nextIndexes.includes(schedule.upcomingIndexes[index] ?? -1)),
      deferred: true,
      allowPreparation: true
    },
    { kind: "earlier", label: "Earlier today", events: schedule.past, deferred: true, allowPreparation: false }
  ]
  return sections.filter((section) => section.events.length > 0)
}

const hasValidInterval = (event: TodayBriefEvent): boolean => {
  const start = Date.parse(event.start)
  const end = Date.parse(event.end)
  return Number.isFinite(start) && Number.isFinite(end) && start < end
}

/**
 * Projects the one group that belongs in the collapsed Today brief. Active events win; when
 * nothing is active, every valid occurrence tied at the earliest upcoming start is retained.
 * Malformed timestamps stay available to the complete agenda but never become the focus group.
 */
export function projectTodayBriefFocus(
  schedule: TodayBriefSchedule,
  events: readonly TodayBriefEvent[]
): TodayBriefFocus | undefined {
  if (schedule.active.length > 0) {
    return {
      kind: "active",
      label: "Now",
      events: schedule.active,
      indexes: schedule.activeIndexes
    }
  }

  const validUpcoming = schedule.upcoming
    .map((event, position) => ({
      event,
      index: schedule.upcomingIndexes[position] ?? -1,
      start: Date.parse(event.start)
    }))
    .filter(({ event, start }) => hasValidInterval(event) && Number.isFinite(start))
  const earliest = validUpcoming.reduce<number | undefined>(
    (value, candidate) => value === undefined || candidate.start < value ? candidate.start : value,
    undefined
  )
  if (earliest === undefined) return undefined
  const focused = validUpcoming.filter(({ start }) => start === earliest)
  // Keep this assertion source-indexed even when a caller supplies a schedule built from a
  // repeated object reference. The `events` parameter documents the source list and protects
  // against accidentally changing this contract to provider-id matching.
  void events
  return {
    kind: "next",
    label: "Up next",
    events: focused.map(({ event }) => event),
    indexes: focused.map(({ index }) => index)
  }
}

export function todayBriefFocusSignature(
  schedule: TodayBriefSchedule,
  events: readonly TodayBriefEvent[]
): string {
  const focus = projectTodayBriefFocus(schedule, events)
  return focus === undefined ? "none" : `${focus.kind}:${focus.indexes.join(",")}`
}

export type TodayBriefPrepareMeeting = (event: TodayBriefEvent, localDate: LocalDate, timeZone: GetTodayBriefOutput["timeZone"]) => Promise<void>

type TodayBriefPerson = TodayBriefEvent["people"][number]
export type TodayBriefOpenPerson = (personNodeId: NonNullable<TodayBriefPerson["personNodeId"]>) => void

export type TodayBriefPersonNavigationItem = {
  readonly title: string
  readonly personNodeId?: NonNullable<TodayBriefPerson["personNodeId"]>
}

/** Projects the privacy-safe attendee projection in server order. Opaque IDs are callback-only. */
export function projectTodayBriefPeople(
  people: readonly TodayBriefPerson[],
  canOpenPerson: boolean
): readonly TodayBriefPersonNavigationItem[] {
  return people.flatMap((person) => {
    if (person.personNodeId !== undefined && canOpenPerson) {
      return [{ title: person.displayName ?? "Person", personNodeId: person.personNodeId }]
    }
    return person.displayName === undefined ? [] : [{ title: person.displayName }]
  })
}

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

export function TodayBrief({ id, reference = new Date(), isToday = true, clock = defaultClock, presentationKey = "today-brief", onPrepareMeeting, onOpenPerson }: { readonly id?: string; readonly reference?: Date; readonly isToday?: boolean; readonly clock?: () => Date; readonly presentationKey?: string; readonly onPrepareMeeting?: TodayBriefPrepareMeeting; readonly onOpenPerson?: TodayBriefOpenPerson }) {
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
  // `useEffectQuery` intentionally retains its previous settled snapshot for continuity. A new
  // routed day or refresh generation must not present that snapshot as the current agenda while
  // the new effect is entering loading.
  const activeQuery = useRef<{ readonly request: typeof request; readonly refreshKey: number }>({ request, refreshKey })
  const queryIsCurrent = activeQuery.current.request === request && activeQuery.current.refreshKey === refreshKey
  useEffect(() => {
    activeQuery.current = { request, refreshKey }
  }, [request, refreshKey])
  useEffect(() => {
    // A route transition owns a new brief generation. Do not let a prior refresh claim suppress
    // the new route's settled result or keep its retry control disabled.
    if (refreshClaim.current === undefined) return
    refreshClaim.current = undefined
    setRefreshClaimed(false)
  }, [request])
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
  const failurePresentation = todayBriefFailurePresentation(isToday)

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

      {(!queryIsCurrent || query.status === "loading") && (
        <p className="today-brief-state" role="status">{refreshClaimed ? "Refreshing" : "Loading"} {isToday ? "today’s" : "daily"} brief&hellip;</p>
      )}
      {queryIsCurrent && query.status === "failure" && (
        <div className="today-brief-load-error" role="alert">
          <div className="today-brief-load-error-copy">
            <p className="today-brief-load-error-title">{failurePresentation.title}</p>
            <p>{failurePresentation.message}</p>
          </div>
          <button
            type="button"
            className="today-brief-refresh"
            onClick={refresh}
            disabled={isRefreshing}
            aria-label={failurePresentation.retryHint}
          >
            {isRefreshing ? failurePresentation.retryingLabel : failurePresentation.retryLabel}
          </button>
        </div>
      )}
      {queryIsCurrent && query.status === "success" && refreshClaimed && (
        <p className="today-brief-state" role="status">Refreshing {isToday ? "today’s" : "daily"} brief&hellip;</p>
      )}
      {queryIsCurrent && query.status === "success" && !refreshClaimed && <TodayBriefFreshness presentationKey={presentationKey} value={query.value} isToday={isToday} now={now} stale={stale} clock={clock} onBoundary={onBoundary} onRefresh={refresh} isRefreshing={isRefreshing} onPrepareMeeting={onPrepareMeeting} onOpenPerson={onOpenPerson} />}
    </aside>
  )
}

export function TodayBriefFreshness({ presentationKey = "today-brief", value, isToday, now, stale, clock, onBoundary, onRefresh, isRefreshing = false, onPrepareMeeting, onOpenPerson }: { readonly presentationKey?: string; readonly value: GetTodayBriefOutput; readonly isToday: boolean; readonly now: Date | undefined; readonly stale: boolean; readonly clock: () => Date; readonly onBoundary: (now: Date, stale: boolean) => void; readonly onRefresh?: () => void; readonly isRefreshing?: boolean; readonly onPrepareMeeting?: TodayBriefPrepareMeeting; readonly onOpenPerson?: TodayBriefOpenPerson }) {
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
  ) : <TodayBriefContent key={`${presentationKey}:${value.localDate}:${isToday}`} value={value} isToday={isToday} now={now} onPrepareMeeting={onPrepareMeeting} onOpenPerson={onOpenPerson} />
}

function TodayBriefContent({ value, isToday, now, onPrepareMeeting, onOpenPerson }: { readonly value: GetTodayBriefOutput; readonly isToday: boolean; readonly now: Date | undefined; readonly onPrepareMeeting?: TodayBriefPrepareMeeting; readonly onOpenPerson?: TodayBriefOpenPerson }) {
  const formatter = timeFormatter(value.timeZone)
  const schedule = isToday && now !== undefined ? projectTodayBriefSchedule(value.events, now) : undefined
  const sections = projectTodayBriefSections(value.events, isToday, schedule)
  const [isFullScheduleOpen, setIsFullScheduleOpen] = useState(!isToday)
  const [preparationStates, setPreparationStates] = useState<TodayBriefPreparationStates>({})
  const preparingOccurrenceKeys = useRef(new Set<string>())
  const [viewAnnouncement, setViewAnnouncement] = useState<string | undefined>(undefined)
  const focus = schedule === undefined ? undefined : projectTodayBriefFocus(schedule, value.events)
  const isFocusMode = isToday && !isFullScheduleOpen
  const isEmptyCurrentDaySchedule = isToday && value.events.length === 0
  const isClearAfterEarlierEvents = isToday && value.events.length > 0 && focus === undefined && schedule?.past.length !== 0
  const hasOnlyMalformedEvents = isToday && value.events.length > 0 && focus === undefined && schedule?.past.length === 0

  useEffect(() => {
    // A brief can be reused while the selected note changes. Never carry an expanded agenda into
    // another local day or from a historical note into the live Today focus mode.
    setIsFullScheduleOpen(!isToday)
    setPreparationStates({})
    preparingOccurrenceKeys.current.clear()
    setViewAnnouncement(undefined)
  }, [isToday, value.localDate])

  const renderEvents = (section: TodayBriefSection, showHeading = true, sourceIndexes?: readonly number[]) => (
    <section
      key={section.kind}
      aria-labelledby={showHeading ? `today-brief-${section.kind}` : undefined}
      aria-label={showHeading ? undefined : section.label}
      data-today-brief-section={section.kind}
    >
      {showHeading && <h3 id={`today-brief-${section.kind}`}>{section.label}</h3>}
      {section.events.length === 0
        ? <p className="today-brief-state">No events.</p>
        : <EventList
            events={section.events}
            formatter={formatter}
            localDate={value.localDate}
            timeZone={value.timeZone}
            onPrepareMeeting={onPrepareMeeting}
            onOpenPerson={onOpenPerson}
            allowPreparation={section.allowPreparation}
            preparationStates={preparationStates}
            setPreparationStates={setPreparationStates}
            preparingOccurrenceKeys={preparingOccurrenceKeys}
            sourceIndexes={sourceIndexes}
            sectionLabel={section.kind}
          />}
    </section>
  )
  const renderCompleteAgenda = () => {
    if (!isToday) {
      return sections.map((section) => renderEvents(section))
    }
    return (
      <section aria-labelledby="today-brief-full-schedule" data-today-brief-section="schedule">
        <h3 id="today-brief-full-schedule">Full schedule</h3>
        {value.events.length === 0
          ? <p className="today-brief-state">No events.</p>
          : <EventList
              events={value.events}
              formatter={formatter}
              localDate={value.localDate}
              timeZone={value.timeZone}
              onPrepareMeeting={onPrepareMeeting}
              onOpenPerson={onOpenPerson}
              allowPreparation={isToday}
              preparationStates={preparationStates}
              setPreparationStates={setPreparationStates}
              preparingOccurrenceKeys={preparingOccurrenceKeys}
              sourceIndexes={value.events.map((_, index) => index)}
              isPreparationAllowed={(event, index) => {
                if (schedule === undefined) return false
                return schedule.activeIndexes.includes(index) || schedule.upcomingIndexes.includes(index)
              }}
              sectionLabel="schedule"
            />}
      </section>
    )
  }

  const renderFocus = () => {
    if (focus !== undefined) {
      return renderEvents({
        kind: focus.kind,
        label: focus.label,
        events: focus.events,
        deferred: false,
        allowPreparation: true
      }, true, focus.indexes)
    }
    if (isEmptyCurrentDaySchedule) {
      return <p className="today-brief-state">No events today. Use your daily note to set priorities.</p>
    }
    if (isClearAfterEarlierEvents) {
      return <p className="today-brief-state">No more events today. Your schedule is clear.</p>
    }
    if (hasOnlyMalformedEvents) {
      return <p className="today-brief-state">No upcoming events with usable times. Open the full schedule to inspect retained entries.</p>
    }
    return null
  }

  const renderDeferred = (section: TodayBriefSection) => {
    const countLabel = `${section.events.length} ${section.events.length === 1 ? "event" : "events"}`
    return (
      <details key={section.kind} className="today-brief-deferred" data-today-brief-section={section.kind}>
        <summary aria-label={`${section.label}, ${countLabel}`}>
          <span>{section.label}</span>
          <span className="today-brief-deferred-count" aria-hidden="true">{countLabel}</span>
        </summary>
        <div className="today-brief-deferred-content">{renderEvents(section, false)}</div>
      </details>
    )
  }
  const previousSignature = useRef<string | undefined>(undefined)
  const announcement = schedule === undefined ? undefined : (() => {
    const signature = todayBriefFocusSignature(schedule, value.events)
    const changed = previousSignature.current !== undefined && previousSignature.current !== signature
    previousSignature.current = signature
    return changed ? "Schedule updated" : undefined
  })()
  return (
    <>
      {isToday && value.events.length > 0 && (
        <div className="today-brief-focus-controls" role="group" aria-label="Today brief view">
          <span className="today-brief-focus-label">{isFullScheduleOpen ? "Full schedule" : focus?.label ?? "Today"}</span>
          <button
            type="button"
            className="today-brief-focus-toggle"
            aria-expanded={isFullScheduleOpen}
            aria-controls="today-brief-agenda"
            onClick={() => {
              const next = !isFullScheduleOpen
              setIsFullScheduleOpen(next)
              setViewAnnouncement(next ? "Full schedule shown" : "Focused schedule shown")
            }}
          >
            {isFullScheduleOpen ? "Show focus" : "Full schedule"}
          </button>
        </div>
      )}
      <div id={isToday && value.events.length > 0 ? "today-brief-agenda" : undefined}>
        {isFocusMode ? renderFocus() : renderCompleteAgenda()}
      </div>
      <TodayBriefHistory status={value.calendarHistory.status} />
      {announcement !== undefined && <p className="sr-only" role="status">{announcement}</p>}
      {viewAnnouncement !== undefined && <p className="sr-only" role="status" aria-live="polite">{viewAnnouncement}</p>}
    </>
  )
}

function TodayBriefHistory({ status }: { readonly status: GetTodayBriefOutput["calendarHistory"]["status"] }) {
  const message = formatHistory(status)
  if (status === "unavailable") {
    return (
      <p className="today-brief-history-warning" role="status" aria-label="Calendar history status">
        {message}
      </p>
    )
  }
  return (
    <details className="today-brief-history">
      <summary>Calendar history</summary>
      <p>{message}</p>
    </details>
  )
}

function EventList({ events, formatter, localDate, timeZone, onPrepareMeeting, onOpenPerson, allowPreparation, isPreparationAllowed, preparationStates, setPreparationStates, preparingOccurrenceKeys, sourceIndexes, sectionLabel }: { readonly events: readonly GetTodayBriefOutput["events"][number][]; readonly formatter: Intl.DateTimeFormat; readonly localDate: LocalDate; readonly timeZone: GetTodayBriefOutput["timeZone"]; readonly onPrepareMeeting?: TodayBriefPrepareMeeting; readonly onOpenPerson?: TodayBriefOpenPerson; readonly allowPreparation: boolean; readonly isPreparationAllowed?: (event: TodayBriefEvent, sourceIndex: number) => boolean; readonly preparationStates: TodayBriefPreparationStates; readonly setPreparationStates: Dispatch<SetStateAction<TodayBriefPreparationStates>>; readonly preparingOccurrenceKeys: MutableRefObject<Set<string>>; readonly sourceIndexes?: readonly number[]; readonly sectionLabel: string }) {
  const preparationReady = onPrepareMeeting !== undefined
  const prepare = async (event: TodayBriefEvent, sourceIndex: number): Promise<void> => {
    // Provider occurrence keys are not sufficient when a source intentionally repeats an
    // occurrence object. The source index is the stable identity within this brief generation.
    const occurrenceKey = `${sourceIndex}:${event.occurrenceKey}`
    if (onPrepareMeeting === undefined || preparingOccurrenceKeys.current.has(occurrenceKey) || preparationStates[occurrenceKey] === "prepared") return
    preparingOccurrenceKeys.current.add(occurrenceKey)
    setPreparationStates((current) => ({ ...current, [occurrenceKey]: "preparing" }))
    try {
      await onPrepareMeeting(event, localDate, timeZone)
      setPreparationStates((current) => ({ ...current, [occurrenceKey]: "prepared" }))
    } catch {
      setPreparationStates((current) => ({ ...current, [occurrenceKey]: "error" }))
    } finally {
      preparingOccurrenceKeys.current.delete(occurrenceKey)
    }
  }
  return <ul className="today-brief-events">{events.map((event, occurrence) => {
    const sourceIndex = sourceIndexes?.[occurrence] ?? occurrence
    const occurrenceStateKey = `${sourceIndex}:${event.occurrenceKey}`
    const preparationState = preparationStates[occurrenceStateKey]
    const preparationStatus = preparationState === "preparing"
      ? "Preparing meeting in daily note."
      : preparationState === "prepared"
        ? "Meeting added to daily note."
        : undefined
    const people = projectTodayBriefPeople(event.people, onOpenPerson !== undefined)
    const showPreparation = allowPreparation && (isPreparationAllowed?.(event, sourceIndex) ?? true)
    return <li key={`${sourceIndex}-${event.occurrenceKey}`} className="today-brief-event">
      <time dateTime={event.start}>{formatter.format(new Date(event.start))}</time>
      <div className="today-brief-event-content"><strong>{event.title}</strong>{people.length > 0 && <div className="today-brief-event-people" role="group" aria-label="People">{people.map((person, personIndex) => {
        const personNodeId = person.personNodeId
        return personNodeId === undefined
          ? <span key={personIndex}>{person.title}</span>
          : <button key={personIndex} type="button" className="today-brief-person" onClick={() => onOpenPerson?.(personNodeId)} aria-label={`Open ${person.title}`} aria-describedby={`today-brief-person-hint-${sectionLabel}-${sourceIndex}-${personIndex}`}>{person.title}<span id={`today-brief-person-hint-${sectionLabel}-${sourceIndex}-${personIndex}`} className="sr-only">Opens this person in the workspace.</span></button>
      })}</div>}
        {showPreparation && <div className="today-brief-event-action">
          <button type="button" className="today-brief-prepare" onClick={preparationReady ? () => void prepare(event, sourceIndex) : undefined} disabled={!preparationReady || preparationState === "preparing" || preparationState === "prepared"} aria-describedby={preparationReady ? undefined : `today-brief-preparation-readiness-${sectionLabel}-${sourceIndex}`}>
            {preparationState === "preparing" ? "Preparing…" : preparationState === "prepared" ? "Added to daily note" : preparationReady ? "Prepare in daily note" : "Daily note not ready"}
          </button>
          {preparationStatus !== undefined && <span className="sr-only today-brief-preparation-status" role="status" aria-live="polite" aria-atomic="true">{preparationStatus}</span>}
          {!preparationReady && <span id={`today-brief-preparation-readiness-${sectionLabel}-${sourceIndex}`} className="today-brief-state">This daily note is not ready for meeting preparation.</span>}
          {preparationState === "error" && <span className="today-brief-event-error" role="alert">Couldn’t prepare — try again.</span>}
        </div>}
      </div>
    </li>
  })}</ul>
}
