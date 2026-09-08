/** @vitest-environment happy-dom */

import { act, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMemoryRouter, RouterProvider, useLocation } from "react-router"
import {
  DailyNoteRouteTransitionProvider,
  useDailyNoteRouteTransition,
  type DailyNoteDepartureRegistration
} from "./daily-note-route-transition.js"

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement; readonly dispose: () => void }> = []

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

function Registration({ registration }: { readonly registration: DailyNoteDepartureRegistration }) {
  const { register } = useDailyNoteRouteTransition()
  useLayoutEffect(() => register(registration), [register, registration])
  return null
}

function Harness({ registration }: { readonly registration: DailyNoteDepartureRegistration }) {
  const location = useLocation()
  return (
    <DailyNoteRouteTransitionProvider>
      <Registration registration={registration} />
      <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>
    </DailyNoteRouteTransitionProvider>
  )
}

async function renderRouter(
  registration: DailyNoteDepartureRegistration,
  initialEntries: string[],
  initialIndex?: number
) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const router = createMemoryRouter(
    [{ path: "*", element: <Harness registration={registration} /> }],
    { initialEntries, initialIndex }
  )
  roots.push({ root, host, dispose: () => router.dispose() })
  await act(async () => {
    root.render(<RouterProvider router={router} />)
    await flush()
  })
  return router
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const { root, host, dispose } of roots.splice(0)) {
    act(() => root.unmount())
    dispose()
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("daily note route transition with a data router", () => {
  it("blocks a PUSH, holds later transitions, and replays the first target after custody is clean", async () => {
    let resolveCheckpoint!: (clean: boolean) => void
    const checkpoint = new Promise<boolean>((resolve) => { resolveCheckpoint = resolve })
    const registration: DailyNoteDepartureRegistration = {
      routeKey: "/notes?date=2026-09-08",
      routeGeneration: Symbol("2026-09-08"),
      todayStamp: "2026-09-08",
      state: "loro-ready",
      checkpoint: () => checkpoint
    }
    const router = await renderRouter(registration, ["/notes?date=2026-09-08"])

    await act(async () => {
      void router.navigate("/notes?date=2026-09-07")
      await flush()
    })
    expect(router.state.location.search).toBe("?date=2026-09-08")
    expect([...router.state.blockers.values()][0]?.state).toBe("blocked")

    await act(async () => {
      void router.navigate("/notes?date=2026-09-06")
      void router.navigate("/notes?date=2026-09-08&variant=paper")
      await flush()
    })
    expect(router.state.location.search).toBe("?date=2026-09-08")

    await act(async () => {
      resolveCheckpoint(true)
      await flush()
      await flush()
    })
    expect(router.state.location.search).toBe("?date=2026-09-07")
    expect([...router.state.blockers.values()][0]?.state ?? "unblocked").toBe("unblocked")
  })

  it("restores a blocked POP before saving and replays that exact history move", async () => {
    let resolveCheckpoint!: (clean: boolean) => void
    const checkpoint = new Promise<boolean>((resolve) => { resolveCheckpoint = resolve })
    const registration: DailyNoteDepartureRegistration = {
      routeKey: "/notes?date=2026-09-07",
      routeGeneration: Symbol("2026-09-07"),
      todayStamp: "2026-09-08",
      state: "loro-ready",
      checkpoint: () => checkpoint
    }
    const router = await renderRouter(
      registration,
      ["/notes?date=2026-09-08", "/notes?date=2026-09-07"],
      1
    )

    await act(async () => {
      void router.navigate(-1)
      await flush()
    })
    expect(router.state.location.search).toBe("?date=2026-09-07")
    expect([...router.state.blockers.values()][0]?.state).toBe("blocked")

    await act(async () => {
      resolveCheckpoint(true)
      await flush()
      await flush()
    })
    expect(router.state.location.search).toBe("?date=2026-09-08")
  })
})
