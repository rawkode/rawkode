/** @vitest-environment happy-dom */

import { act, createElement, useCallback, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GetTodayBriefOutput } from "@athenaeum/domain"
import { nextTodayBriefBoundary, nextTodayBriefMidnight, projectTodayBriefFocus, projectTodayBriefPeople, projectTodayBriefSchedule, projectTodayBriefSections, TodayBriefFreshness, todayBriefFocusSignature, todayBriefScheduleSignature } from "./TodayBrief.js"

type TodayBriefEvent = GetTodayBriefOutput["events"][number]
const event = (
  id: string,
  start: string,
  end: string,
  occurrenceKey = "0".repeat(64),
  people: TodayBriefEvent["people"] = []
): TodayBriefEvent => ({
  id: id as TodayBriefEvent["id"],
  occurrenceKey,
  title: id,
  start: start as TodayBriefEvent["start"],
  end: end as TodayBriefEvent["end"],
  people
})
const now = new Date("2026-08-26T10:00:00.000Z")

const roots: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = []
let visibilityDescriptor: PropertyDescriptor | undefined

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  if (visibilityDescriptor === undefined) delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState
  else Object.defineProperty(document, "visibilityState", visibilityDescriptor)
  visibilityDescriptor = undefined
  vi.useRealTimers()
})

const setVisibility = (state: DocumentVisibilityState): void => {
  visibilityDescriptor ??= Object.getOwnPropertyDescriptor(document, "visibilityState")
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state })
  document.dispatchEvent(new Event("visibilitychange"))
}

function FreshnessHarness({ value, clock }: { readonly value: GetTodayBriefOutput; readonly clock: () => Date }) {
  const [current, setCurrent] = useState(clock)
  const [stale, setStale] = useState(false)
  const onBoundary = useCallback((next: Date, nextStale: boolean) => {
    setCurrent(next)
    setStale(nextStale)
  }, [])
  return createElement(TodayBriefFreshness, { value, isToday: true, now: current, stale, clock, onBoundary })
}

const mount = async (element: ReturnType<typeof createElement>): Promise<HTMLDivElement> => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => { root.render(element) })
  return container
}

describe("projectTodayBriefSchedule", () => {
  it("classifies valid intervals with an active half-open boundary", () => {
    const result = projectTodayBriefSchedule([
      event("active", "2026-08-26T09:00:00Z", "2026-08-26T10:00:00Z"),
      event("now-active", "2026-08-26T10:00:00Z", "2026-08-26T11:00:00Z"),
      event("later", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z"),
      event("past", "2026-08-26T08:00:00Z", "2026-08-26T09:00:00Z")
    ], now)
    expect(result.active.map((item) => item.id)).toEqual(["now-active"])
    expect(result.past.map((item) => item.id)).toEqual(["active", "past"])
    expect(result.upcoming.map((item) => item.id)).toEqual(["later"])
    expect(result.next.map((item) => item.id)).toEqual(["later"])
  })

  it("keeps invalid intervals once and uses start for their non-active bucket", () => {
    const result = projectTodayBriefSchedule([
      event("invalid-past", "2026-08-26T08:00:00Z", "2026-08-26T07:00:00Z"),
      event("invalid-upcoming", "2026-08-26T12:00:00Z", "2026-08-26T11:00:00Z"),
      event("tie-a", "2026-08-26T13:00:00Z", "2026-08-26T14:00:00Z"),
      event("tie-b", "2026-08-26T13:00:00Z", "2026-08-26T14:00:00Z")
    ], now)
    expect(result.past.map((item) => item.id)).toEqual(["invalid-past"])
    expect(result.upcoming.map((item) => item.id)).toEqual(["invalid-upcoming", "tie-a", "tie-b"])
    expect(result.next.map((item) => item.id)).toEqual(["invalid-upcoming"])
    expect([...result.active, ...result.past, ...result.upcoming].map((item) => item.id)).toEqual([
      "invalid-past", "invalid-upcoming", "tie-a", "tie-b"
    ])
  })

  it("uses source occurrence indexes in signatures, including duplicate ids", () => {
    const events = [
      event("same", "2026-08-26T09:00:00Z", "2026-08-26T10:00:00Z"),
      event("same", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z"),
      event("later", "2026-08-26T12:00:00Z", "2026-08-26T13:00:00Z")
    ]
    const schedule = projectTodayBriefSchedule(events, now)
    expect(todayBriefScheduleSignature(schedule, events)).toBe("active:|next:1|upcoming:1,2|past:0")
  })

  it("projects an exclusive Now-or-Next focus group and preserves tied starts", () => {
    const activeEvents = [
      event("active", "2026-08-26T09:30:00Z", "2026-08-26T10:30:00Z"),
      event("next", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z")
    ]
    const activeSchedule = projectTodayBriefSchedule(activeEvents, now)
    expect(projectTodayBriefFocus(activeSchedule, activeEvents)).toMatchObject({
      kind: "active",
      label: "Now",
      events: [activeEvents[0]],
      indexes: [0]
    })

    const tiedEvents = [
      event("invalid", "2026-08-26T12:00:00Z", "2026-08-26T11:00:00Z"),
      event("tie-a", "2026-08-26T13:00:00Z", "2026-08-26T14:00:00Z"),
      event("tie-b", "2026-08-26T13:00:00Z", "2026-08-26T14:00:00Z"),
      event("later", "2026-08-26T14:00:00Z", "2026-08-26T15:00:00Z")
    ]
    const tiedSchedule = projectTodayBriefSchedule(tiedEvents, now)
    expect(projectTodayBriefFocus(tiedSchedule, tiedEvents)).toMatchObject({
      kind: "next",
      label: "Up next",
      events: [tiedEvents[1], tiedEvents[2]],
      indexes: [1, 2]
    })
    expect(todayBriefFocusSignature(tiedSchedule, tiedEvents)).toBe("next:1,2")
  })

  it("replaces focus with one source-ordered full agenda instead of duplicating occurrences", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: [
        event("past", "2026-08-26T08:00:00Z", "2026-08-26T09:00:00Z"),
        event("active", "2026-08-26T09:30:00Z", "2026-08-26T10:30:00Z"),
        event("next", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z")
      ]
    } as unknown as GetTodayBriefOutput
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined
    }))

    expect(Array.from(container.querySelectorAll(".today-brief-event strong")).map((node) => node.textContent)).toEqual(["active"])
    const toggle = container.querySelector<HTMLButtonElement>(".today-brief-focus-toggle")
    expect(toggle?.getAttribute("aria-expanded")).toBe("false")
    await act(async () => { toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })) })

    expect(Array.from(container.querySelectorAll("#today-brief-agenda .today-brief-event strong")).map((node) => node.textContent)).toEqual(["past", "active", "next"])
    expect(container.querySelectorAll(".today-brief-event")).toHaveLength(3)
    expect(container.querySelectorAll(".today-brief-focus-toggle")).toHaveLength(1)
    expect(container.querySelector(".today-brief-focus-toggle")?.getAttribute("aria-expanded")).toBe("true")
  })

  it("retains an unparseable timestamp in Full schedule with safe time copy", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: [event("malformed", "not-a-timestamp", "still-not-a-timestamp")]
    } as unknown as GetTodayBriefOutput
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined
    }))

    expect(container.querySelector(".today-brief-event")).toBeNull()
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".today-brief-focus-toggle")?.click()
    })
    expect(container.querySelector(".today-brief-event time")?.textContent).toBe("Time unavailable")
    expect(container.querySelector(".today-brief-event strong")?.textContent).toBe("malformed")
  })

  it("keeps repeated references as distinct source occurrences", () => {
    const shared = event("same-reference", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z")
    const events = [event("past", "2026-08-26T09:00:00Z", "2026-08-26T10:00:00Z"), shared, shared]
    const schedule = projectTodayBriefSchedule(events, now)
    expect(schedule.next).toEqual([shared, shared])
    expect(todayBriefScheduleSignature(schedule, events)).toBe("active:|next:1,2|upcoming:1,2|past:0")
  })

  it("coalesces to the earliest event boundary and stales only at the brief civil midnight", () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "Europe/London",
      events: [event("soon", "2026-08-26T10:30:00Z", "2026-08-26T11:00:00Z")]
    } as unknown as GetTodayBriefOutput
    expect(nextTodayBriefBoundary(value, now)?.toISOString()).toBe("2026-08-26T10:30:00.000Z")
    expect(nextTodayBriefMidnight("2026-08-26", "Europe/London", new Date("2026-08-26T22:00:00Z"))?.toISOString()).toBe("2026-08-26T23:00:00.000Z")
    expect(nextTodayBriefMidnight("2026-08-26", "Europe/London", new Date("2026-08-26T23:00:00Z"))).toBeUndefined()
  })

  it("reconciles once on visibility resume after a hidden boundary and arms the next boundary", async () => {
    vi.useFakeTimers()
    let current = new Date("2026-08-26T10:00:00.000Z")
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: [event("meeting", "2026-08-26T10:30:00Z", "2026-08-26T11:00:00Z")]
    } as unknown as GetTodayBriefOutput
    const container = await mount(createElement(FreshnessHarness, { value, clock: () => current }))

    expect(container.querySelector('[aria-labelledby="today-brief-next"]')?.textContent).toContain("meeting")
    await act(async () => {
      setVisibility("hidden")
      current = new Date("2026-08-26T10:45:00.000Z")
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    })
    expect(container.querySelector('[aria-labelledby="today-brief-next"]')?.textContent).toContain("meeting")

    await act(async () => { setVisibility("visible") })
    expect(container.querySelector('[aria-labelledby="today-brief-active"]')?.textContent).toContain("meeting")
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Schedule updated")

    await act(async () => {
      current = new Date("2026-08-26T11:00:00.000Z")
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    })
    expect(container.querySelector(".today-brief-state")?.textContent).toBe("No more events today. Your schedule is clear.")
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
  })

  it("offers an explicit refresh action when the brief becomes stale", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: []
    } as unknown as GetTodayBriefOutput
    const onRefresh = vi.fn()
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: true,
      clock: () => now,
      onBoundary: () => undefined,
      onRefresh,
      isRefreshing: false
    }))

    expect(container.textContent).toContain("This brief is no longer current.")
    const button = container.querySelector("button")
    expect(button?.textContent).toBe("Refresh brief")
    await act(async () => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("keeps the stale refresh action visibly unavailable while a shared refresh is in flight", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: []
    } as unknown as GetTodayBriefOutput
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: true,
      clock: () => now,
      onBoundary: () => undefined,
      onRefresh: vi.fn(),
      isRefreshing: true
    }))

    const button = container.querySelector<HTMLButtonElement>("button")
    expect(button?.disabled).toBe(true)
    expect(button?.textContent).toBe("Refreshing…")
  })

  it("uses one planning prompt instead of empty schedule buckets for a current day with no events", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: []
    } as unknown as GetTodayBriefOutput
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined
    }))

    expect(container.querySelectorAll(".today-brief-state")).toHaveLength(1)
    expect(container.querySelector(".today-brief-state")?.textContent).toBe("No events today. Use your daily note to set priorities.")
    expect(container.querySelectorAll("[aria-labelledby^='today-brief-']")).toHaveLength(0)
    expect(container.querySelectorAll(".today-brief-prepare")).toHaveLength(0)
  })

  it("keeps current work open and defers only non-urgent buckets with counts", () => {
    const events = [
      event("past", "2026-08-26T08:00:00Z", "2026-08-26T09:00:00Z"),
      event("active", "2026-08-26T09:30:00Z", "2026-08-26T10:30:00Z"),
      event("next", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z"),
      event("later", "2026-08-26T13:00:00Z", "2026-08-26T14:00:00Z")
    ]
    const schedule = projectTodayBriefSchedule(events, now)
    const sections = projectTodayBriefSections(events, true, schedule)

    expect(sections.map(({ kind }) => kind)).toEqual(["active", "next", "later", "earlier"])
    expect(sections.map(({ label, events: sectionEvents, deferred }) => ({ label, count: sectionEvents.length, deferred }))).toEqual([
      { label: "Active", count: 1, deferred: false },
      { label: "Up next", count: 1, deferred: false },
      { label: "Later", count: 1, deferred: true },
      { label: "Earlier today", count: 1, deferred: true }
    ])
  })

  it("puts the actionable schedule before collapsed healthy calendar history", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: [event("next", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z")]
    } as unknown as GetTodayBriefOutput
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined
    }))

    const nextSection = container.querySelector('[data-today-brief-section="next"]')
    const history = container.querySelector<HTMLDetailsElement>(".today-brief-history")
    expect(nextSection).not.toBeNull()
    expect(history).not.toBeNull()
    expect(history?.open).toBe(false)
    expect(nextSection !== null && history !== null && Boolean(nextSection.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(history?.textContent).toContain("Calendar history available")
  })

  it("keeps unavailable calendar history visible without outranking the schedule", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "unavailable" },
      events: [event("next", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z")]
    } as unknown as GetTodayBriefOutput
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined
    }))

    const nextSection = container.querySelector('[data-today-brief-section="next"]')
    const warning = container.querySelector(".today-brief-history-warning")
    expect(nextSection).not.toBeNull()
    expect(warning).not.toBeNull()
    expect(warning?.getAttribute("role")).toBe("status")
    expect(warning?.textContent).toBe("Calendar history unavailable")
    expect(nextSection !== null && warning !== null && Boolean(nextSection.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it("omits empty current-day sections while keeping a historical schedule unclassified", () => {
    const currentEvents = [event("active", "2026-08-26T09:30:00Z", "2026-08-26T10:30:00Z")]
    const current = projectTodayBriefSections(currentEvents, true, projectTodayBriefSchedule(currentEvents, now))
    expect(current.map(({ kind }) => kind)).toEqual(["active"])

    const historicalEvents = [event("historical", "2026-08-25T09:00:00Z", "2026-08-25T10:00:00Z")]
    expect(projectTodayBriefSections(historicalEvents, false)).toEqual([
      { kind: "schedule", label: "Schedule", events: historicalEvents, deferred: false, allowPreparation: false }
    ])
  })

  it("keeps an empty historical brief in its date-specific schedule section", async () => {
    const value = {
      localDate: "2026-08-25",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: []
    } as unknown as GetTodayBriefOutput
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: false,
      now: undefined,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined
    }))

    expect(container.querySelector('[aria-labelledby="today-brief-schedule"]')?.textContent).toContain("No events.")
    expect(container.textContent).not.toContain("Use your daily note to set priorities.")
  })

  it("keeps retrospective events read-only while preserving preparation for current work", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: [
        event("past", "2026-08-26T08:00:00Z", "2026-08-26T09:00:00Z"),
        event("active", "2026-08-26T09:30:00Z", "2026-08-26T10:30:00Z"),
        event("upcoming", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z")
      ]
    } as unknown as GetTodayBriefOutput
    const onPrepareMeeting = vi.fn(async () => undefined)
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined,
      onPrepareMeeting
    }))

    expect(container.querySelector('[data-today-brief-section="earlier"] .today-brief-prepare')).toBeNull()
    const activePreparation = container.querySelector<HTMLButtonElement>('[aria-labelledby="today-brief-active"] .today-brief-prepare')
    const nextPreparation = container.querySelector<HTMLButtonElement>('[aria-labelledby="today-brief-next"] .today-brief-prepare')
    expect(activePreparation).not.toBeNull()
    expect(nextPreparation).toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".today-brief-focus-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    const expandedNextPreparation = container.querySelector<HTMLButtonElement>(".today-brief-event .today-brief-prepare:not(:disabled)")
    expect(expandedNextPreparation).not.toBeNull()

    const expandedActivePreparation = container.querySelector<HTMLButtonElement>("#today-brief-agenda .today-brief-event:nth-child(2) .today-brief-prepare")
    await act(async () => { expandedActivePreparation?.dispatchEvent(new MouseEvent("click", { bubbles: true })) })

    expect(onPrepareMeeting).toHaveBeenCalledTimes(1)
    expect(onPrepareMeeting).toHaveBeenCalledWith(value.events[1], "2026-08-26", "UTC")
    expect(expandedActivePreparation?.textContent).toBe("Added to daily note")
  })

  it("prepares each occurrence once while leaving other occurrences available", async () => {
    let resolveActive: (() => void) | undefined
    let resolveUpcoming: (() => void) | undefined
    const activePromise = new Promise<void>((resolve) => { resolveActive = resolve })
    const upcomingPromise = new Promise<void>((resolve) => { resolveUpcoming = resolve })
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: [
        event("active", "2026-08-26T09:30:00Z", "2026-08-26T10:30:00Z", "1".repeat(64)),
        event("upcoming", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z", "2".repeat(64))
      ]
    } as unknown as GetTodayBriefOutput
    const onPrepareMeeting = vi.fn((item: TodayBriefEvent) => item.id === value.events[0].id ? activePromise : upcomingPromise)
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined,
      onPrepareMeeting
    }))
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".today-brief-focus-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    const activePreparation = container.querySelector<HTMLButtonElement>(".today-brief-event .today-brief-prepare")
    const upcomingPreparation = container.querySelectorAll<HTMLButtonElement>(".today-brief-event .today-brief-prepare")[1]

    await act(async () => {
      activePreparation?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      activePreparation?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      upcomingPreparation?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(onPrepareMeeting).toHaveBeenCalledTimes(2)
    expect(onPrepareMeeting).toHaveBeenNthCalledWith(1, value.events[0], "2026-08-26", "UTC")
    expect(onPrepareMeeting).toHaveBeenNthCalledWith(2, value.events[1], "2026-08-26", "UTC")
    expect(activePreparation?.disabled).toBe(true)
    expect(activePreparation?.textContent).toBe("Preparing…")
    expect(upcomingPreparation?.disabled).toBe(true)
    expect(upcomingPreparation?.textContent).toBe("Preparing…")
    const preparationStatuses = () => Array.from(container.querySelectorAll<HTMLElement>(".today-brief-preparation-status"))
    expect(preparationStatuses().map((status) => status.textContent)).toEqual([
      "Preparing meeting in daily note.",
      "Preparing meeting in daily note."
    ])
    for (const status of preparationStatuses()) {
      expect(status.getAttribute("role")).toBe("status")
      expect(status.getAttribute("aria-live")).toBe("polite")
      expect(status.getAttribute("aria-atomic")).toBe("true")
    }

    await act(async () => {
      resolveActive?.()
      resolveUpcoming?.()
      await Promise.all([activePromise, upcomingPromise])
    })

    expect(activePreparation?.textContent).toBe("Added to daily note")
    expect(upcomingPreparation?.textContent).toBe("Added to daily note")
    expect(preparationStatuses().map((status) => status.textContent)).toEqual([
      "Meeting added to daily note.",
      "Meeting added to daily note."
    ])
  })

  it("releases a failed occurrence for a later retry", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: [event("active", "2026-08-26T09:30:00Z", "2026-08-26T10:30:00Z", "1".repeat(64))]
    } as unknown as GetTodayBriefOutput
    const onPrepareMeeting = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(undefined)
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined,
      onPrepareMeeting
    }))
    const preparation = container.querySelector<HTMLButtonElement>('[aria-labelledby="today-brief-active"] .today-brief-prepare')

    await act(async () => { preparation?.dispatchEvent(new MouseEvent("click", { bubbles: true })) })

    expect(preparation?.disabled).toBe(false)
    expect(preparation?.textContent).toBe("Prepare in daily note")
    expect(container.querySelector(".today-brief-event-error")?.textContent).toBe("Couldn’t prepare — try again.")
    expect(container.querySelectorAll(".today-brief-preparation-status")).toHaveLength(0)

    await act(async () => { preparation?.dispatchEvent(new MouseEvent("click", { bubbles: true })) })

    expect(onPrepareMeeting).toHaveBeenCalledTimes(2)
    expect(preparation?.textContent).toBe("Added to daily note")
    expect(container.querySelector(".today-brief-preparation-status")?.textContent).toBe("Meeting added to daily note.")
  })

  it("keeps current meeting preparation visible but disabled until the daily note is ready", async () => {
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: [
        event("past", "2026-08-26T08:00:00Z", "2026-08-26T09:00:00Z"),
        event("active", "2026-08-26T09:30:00Z", "2026-08-26T10:30:00Z"),
        event("upcoming", "2026-08-26T11:00:00Z", "2026-08-26T12:00:00Z")
      ]
    } as unknown as GetTodayBriefOutput
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined
    }))

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".today-brief-focus-toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(container.querySelector('[data-today-brief-section="schedule"] .today-brief-event:nth-child(1) .today-brief-prepare')).toBeNull()
    const preparations = Array.from(container.querySelectorAll<HTMLButtonElement>(".today-brief-prepare"))
    expect(preparations).toHaveLength(2)
    for (const preparation of preparations) {
      expect(preparation.disabled).toBe(true)
      expect(preparation.textContent).toBe("Daily note not ready")
      const descriptionId = preparation.getAttribute("aria-describedby")
      expect(descriptionId).toBeTruthy()
      expect(container.querySelector(`#${descriptionId}`)?.textContent).toBe("This daily note is not ready for meeting preparation.")
      await act(async () => { preparation.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    }
    expect(container.querySelectorAll(".today-brief-event-error")).toHaveLength(0)
  })
})

describe("Today Brief person navigation", () => {
  const aliceId = "550e8400-e29b-41d4-a716-446655440000" as NonNullable<TodayBriefEvent["people"][number]["personNodeId"]>
  const personOnlyId = "550e8400-e29b-41d4-a716-446655440001" as NonNullable<TodayBriefEvent["people"][number]["personNodeId"]>

  it("preserves source order while keeping opaque IDs callback-only", () => {
    const people: TodayBriefEvent["people"] = [
      { displayName: "Alice", personNodeId: aliceId },
      { displayName: "Guest" },
      { personNodeId: personOnlyId },
      {}
    ]

    expect(projectTodayBriefPeople(people, true)).toEqual([
      { title: "Alice", personNodeId: aliceId },
      { title: "Guest" },
      { title: "Person", personNodeId: personOnlyId }
    ])
    expect(projectTodayBriefPeople(people, false)).toEqual([
      { title: "Alice" },
      { title: "Guest" }
    ])
  })

  it("exposes each person navigation control independently without rendering its ID", async () => {
    const people: TodayBriefEvent["people"] = [
      { displayName: "Alice", personNodeId: aliceId },
      { displayName: "Guest" },
      { personNodeId: personOnlyId },
      {}
    ]
    const value = {
      localDate: "2026-08-26",
      timeZone: "UTC",
      calendarHistory: { status: "found" },
      events: [event("people", "2026-08-26T09:30:00Z", "2026-08-26T10:30:00Z", "p".repeat(64), people)]
    } as unknown as GetTodayBriefOutput
    const onOpenPerson = vi.fn()
    const container = await mount(createElement(TodayBriefFreshness, {
      value,
      isToday: true,
      now,
      stale: false,
      clock: () => now,
      onBoundary: () => undefined,
      onOpenPerson
    }))

    const peopleGroup = container.querySelector<HTMLElement>(".today-brief-event-people")
    expect(peopleGroup?.getAttribute("role")).toBe("group")
    expect(peopleGroup?.getAttribute("aria-label")).toBe("People")
    expect(peopleGroup?.textContent).toContain("Guest")
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".today-brief-person"))
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Open Alice", "Open Person"])
    expect(container.textContent).not.toContain(aliceId)
    expect(container.textContent).not.toContain(personOnlyId)

    await act(async () => {
      buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(onOpenPerson).toHaveBeenNthCalledWith(1, aliceId)
    expect(onOpenPerson).toHaveBeenNthCalledWith(2, personOnlyId)
  })
})
