/** @vitest-environment happy-dom */

import { act, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({
  predicate: undefined as undefined | ((transition: { currentLocation: unknown; nextLocation: unknown }) => boolean),
  blocker: {
    state: "unblocked" as "unblocked" | "blocked",
    proceed: vi.fn(() => { router.blocker.state = "unblocked" }),
    reset: vi.fn(() => { router.blocker.state = "unblocked" })
  }
}))

vi.mock("react-router", () => ({
  useBlocker: (predicate: typeof router.predicate) => {
    router.predicate = predicate
    // React Router publishes a new blocker snapshot when its state changes.
    return { ...router.blocker }
  }
}))

import {
  DailyNoteRouteTransitionProvider,
  logicalDailyNoteIdentity,
  useDailyNoteRouteTransition,
  type DailyNoteDepartureRegistration
} from "./daily-note-route-transition.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const location = (pathname: string, search = "", hash = "") => ({ pathname, search, hash })
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

function Registration({ registration }: { readonly registration: DailyNoteDepartureRegistration }) {
  const { register } = useDailyNoteRouteTransition()
  useLayoutEffect(() => register(registration), [register, registration])
  return null
}

const render = async (registration: DailyNoteDepartureRegistration): Promise<Root> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<DailyNoteRouteTransitionProvider><Registration registration={registration} /></DailyNoteRouteTransitionProvider>)
    await flush()
  })
  return root
}

beforeEach(() => {
  router.predicate = undefined
  router.blocker.state = "unblocked"
  router.blocker.proceed.mockClear()
  router.blocker.reset.mockClear()
})
afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
})

describe("daily note route transition", () => {
  it("normalizes omitted, explicit-today, malformed, and extra-query daily-note URLs", () => {
    const today = "2026-09-08"
    expect(logicalDailyNoteIdentity(location("/notes"), today)).toBe(today)
    expect(logicalDailyNoteIdentity(location("/notes", "?date=2026-09-08"), today)).toBe(today)
    expect(logicalDailyNoteIdentity(location("/notes", "?date=bad&variant=paper"), today)).toBe(today)
    expect(logicalDailyNoteIdentity(location("/notes", "?variant=paper&date=2026-09-07"), today)).toBe("2026-09-07")
    expect(logicalDailyNoteIdentity(location("/graph"), today)).toBeUndefined()
  })

  it("uses the first captured transition while saving and holds later PUSH, REPLACE, and POP attempts", async () => {
    const checkpoint = (() => {
      let resolve!: (value: boolean) => void
      const promise = new Promise<boolean>((done) => { resolve = done })
      return { promise, resolve }
    })()
    const registration: DailyNoteDepartureRegistration = {
      routeKey: "/notes?date=2026-09-08",
      routeGeneration: Symbol("today"),
      todayStamp: "2026-09-08",
      state: "loro-ready",
      checkpoint: () => checkpoint.promise
    }
    const root = await render(registration)
    const from = location("/notes", "?date=2026-09-08")
    expect(router.predicate?.({ currentLocation: from, nextLocation: location("/notes", "?date=2026-09-07") })).toBe(true)

    router.blocker.state = "blocked"
    await act(async () => { root.render(<DailyNoteRouteTransitionProvider><Registration registration={registration} /></DailyNoteRouteTransitionProvider>); await flush() })
    expect(router.predicate?.({ currentLocation: from, nextLocation: location("/notes", "?date=2026-09-08&variant=paper") })).toBe(true)
    expect(router.predicate?.({ currentLocation: from, nextLocation: location("/notes", "?date=2026-09-06") })).toBe(true)

    await act(async () => { checkpoint.resolve(true); await flush() })
    expect(router.blocker.proceed).toHaveBeenCalledOnce()
    expect(router.blocker.reset).not.toHaveBeenCalled()
  })

  it("fails closed for a Loro note without an attachment callback, while legacy is immediate", async () => {
    const awaiting: DailyNoteDepartureRegistration = {
      routeKey: "/notes", routeGeneration: Symbol("today"), todayStamp: "2026-09-08", state: "loro-awaiting-attachment"
    }
    const root = await render(awaiting)
    expect(router.predicate?.({ currentLocation: location("/notes"), nextLocation: location("/graph") })).toBe(true)
    router.blocker.state = "blocked"
    await act(async () => { root.render(<DailyNoteRouteTransitionProvider><Registration registration={awaiting} /></DailyNoteRouteTransitionProvider>); await flush() })
    expect(router.blocker.reset).toHaveBeenCalledTimes(1)

    const legacy: DailyNoteDepartureRegistration = { ...awaiting, state: "legacy-automerge" }
    await act(async () => { root.render(<DailyNoteRouteTransitionProvider><Registration registration={legacy} /></DailyNoteRouteTransitionProvider>); await flush() })
    router.blocker.state = "unblocked"
    expect(router.predicate?.({ currentLocation: location("/notes"), nextLocation: location("/graph") })).toBe(false)
  })
})
