/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError, type WorkoutSummary } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  byRefreshKey: new Map<number, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.byRefreshKey.get(Number(dependencies[0])) ?? queryStateMock.current
  }
}))

vi.mock("react-router", () => ({
  Link: ({ to, children, className }: { readonly to: string; readonly children?: ReactNode; readonly className?: string }) => (
    <a className={className} href={to}>{children}</a>
  )
}))

import { WorkoutsPanel } from "./WorkoutsPanel.js"

const workout = {
  nodeId: EntityId.make("00000000-0000-4000-8000-000000000001"),
  workspaceId: EntityId.make("00000000-0000-4000-8000-000000000010"),
  sourceWorkoutId: "workout-1",
  source: "healthkit",
  kind: "strength",
  activity: "strength-training",
  startedAt: "2026-08-28T09:00:00.000Z",
  completedAt: "2026-08-28T09:30:00.000Z",
  durationSeconds: 1800
} as WorkoutSummary

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const renderPanel = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<WorkoutsPanel />)
    await flush()
  })
}

const mount = async (): Promise<{ readonly host: HTMLDivElement; readonly root: Root }> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await renderPanel(root)
  return { host, root }
}

const buttonNamed = (host: HTMLDivElement, label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)

const refreshGenerations = (): ReadonlyArray<number> =>
  [...new Set(queryStateMock.dependencies.map((dependencies) => dependencies[0]))].filter(
    (generation): generation is number => typeof generation === "number"
  )

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.dependencies = []
  queryStateMock.byRefreshKey.clear()
  queryStateMock.current = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal workout history detail" })
  }
})

afterEach(() => {
  queryStateMock.byRefreshKey.clear()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("WorkoutsPanel list recovery", () => {
  it("shows a generic retryable list failure without presenting an empty import history and refreshes only one list read at a time", async () => {
    const { host, root } = await mount()

    const alert = host.querySelector<HTMLElement>(".workouts-load-state")
    expect(host.querySelectorAll(".workouts-load-state")).toHaveLength(1)
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Workouts couldn’t be loaded.")
    expect(host.textContent).not.toContain("Internal workout history detail")
    expect(host.textContent).not.toContain("No activity here yet")
    expect(refreshGenerations()).toEqual([0])

    await act(async () => {
      buttonNamed(host, "Refresh")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(refreshGenerations()).toEqual([0, 1])
    expect(buttonNamed(host, "Refreshing…")?.disabled).toBe(true)
    expect(buttonNamed(host, "Retrying…")?.disabled).toBe(true)

    queryStateMock.byRefreshKey.set(1, { status: "loading" as const })
    await renderPanel(root)
    expect(buttonNamed(host, "Refreshing…")?.disabled).toBe(true)
    expect(host.querySelector(".workouts-load-state")).toBeNull()

    queryStateMock.byRefreshKey.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Private workout retry detail" })
    })
    await renderPanel(root)

    const releasedRetry = buttonNamed(host, "Retry")
    expect(buttonNamed(host, "Refresh")?.disabled).toBe(false)
    expect(releasedRetry?.disabled).toBe(false)
    expect(host.textContent).not.toContain("Private workout retry detail")
    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(refreshGenerations()).toEqual([0, 1, 2])
  })

  it("keeps a successful empty import history distinct from a failed list request", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: { workouts: [] }
    }

    const { host } = await mount()

    expect(host.querySelector(".workouts-load-state")).toBeNull()
    expect(host.querySelector(".empty-state")?.textContent).toContain("No activity here yet")
    expect(host.querySelector("[role='alert']")).toBeNull()
    const homeLink = host.querySelector<HTMLAnchorElement>(".empty-state a")
    expect(homeLink?.textContent).toBe("Open today’s note")
    expect(homeLink?.getAttribute("href")).toBe("/notes")
  })

  it("keeps initial list loading distinct from a claimed manual refresh", async () => {
    queryStateMock.current = { status: "loading" as const }

    const { host } = await mount()

    expect(buttonNamed(host, "Loading…")?.disabled).toBe(true)
    expect(buttonNamed(host, "Refreshing…")).toBeUndefined()
  })

  it("retains workouts during a refresh and failure until a current empty history arrives", async () => {
    const privateDetail = "private workout history provider detail"
    queryStateMock.current = { status: "success" as const, value: { workouts: [workout] } }
    const { host, root } = await mount()

    expect(host.querySelector(".workouts-list-item-activity")?.textContent).toBe("strength-training")
    expect(host.querySelector(".empty-state")).toBeNull()

    queryStateMock.byRefreshKey.set(1, { status: "loading" as const })
    await act(async () => {
      buttonNamed(host, "Refresh")?.click()
      await flush()
    })

    expect(refreshGenerations()).toEqual([0, 1])
    expect(buttonNamed(host, "Refreshing…")?.disabled).toBe(true)
    expect(host.querySelector(".workouts-list-item-activity")?.textContent).toBe("strength-training")
    expect(host.querySelector(".empty-state")).toBeNull()

    queryStateMock.byRefreshKey.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: privateDetail })
    })
    await renderPanel(root)

    expect(host.querySelector(".workouts-list-item-activity")?.textContent).toBe("strength-training")
    expect(host.querySelector("[role='alert']")?.textContent).toContain("previously loaded workouts remain available")
    expect(host.textContent).not.toContain(privateDetail)

    queryStateMock.byRefreshKey.set(1, { status: "success" as const, value: { workouts: [] } })
    await renderPanel(root)

    expect(host.querySelector(".workouts-list-item-activity")).toBeNull()
    expect(host.querySelector(".empty-state")?.textContent).toContain("No activity here yet")
  })
})
