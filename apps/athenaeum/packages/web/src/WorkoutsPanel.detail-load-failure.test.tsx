/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError, WorkoutNotFound, type WorkoutSummary } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  list: undefined as unknown,
  detail: undefined as unknown,
  detailByGeneration: new Map<number, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    if (dependencies.length === 1) return queryStateMock.list
    const generation = dependencies[1]
    return typeof generation === "number"
      ? queryStateMock.detailByGeneration.get(generation) ?? queryStateMock.detail
      : queryStateMock.detail
  }
}))

import { WorkoutsPanel } from "./WorkoutsPanel.js"

const workspaceId = EntityId.make("00000000-0000-4000-8000-000000000010")
const workoutNodeId = EntityId.make("00000000-0000-4000-8000-000000000001")
const summary = {
  nodeId: workoutNodeId,
  workspaceId,
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

const buttonNamed = (host: HTMLDivElement, label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)

const detailQueries = (): ReadonlyArray<ReadonlyArray<unknown>> =>
  queryStateMock.dependencies.filter((dependencies) => dependencies.length === 2)

const detailGenerations = (): number[] => [
  ...new Set(
    detailQueries()
      .map((dependencies) => dependencies[1])
      .filter((value): value is number => typeof value === "number")
  )
]

const render = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<WorkoutsPanel />)
    await flush()
  })
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root)
  return host
}

const rerender = async (host: HTMLDivElement): Promise<void> => {
  const root = roots.find((entry) => entry.host === host)?.root
  if (root === undefined) throw new Error("expected mounted WorkoutsPanel root")
  await render(root)
}

const selectWorkout = async (host: HTMLDivElement): Promise<void> => {
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".workouts-list-item-button")?.click()
    await flush()
  })
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.list = { status: "success" as const, value: { workouts: [summary] } }
  queryStateMock.detail = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal workout detail retrieval" })
  }
  queryStateMock.detailByGeneration.clear()
  queryStateMock.dependencies = []
})

afterEach(() => {
  queryStateMock.list = undefined
  queryStateMock.detail = undefined
  queryStateMock.detailByGeneration.clear()
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("WorkoutsPanel detail-load recovery", () => {
  it("keeps the selected workout visible and retries only one unknown detail read at a time", async () => {
    const host = await mount()
    expect(host.querySelector(".workouts-list-item-button")?.getAttribute("aria-current")).toBeNull()
    await selectWorkout(host)
    const alert = host.querySelector<HTMLElement>(".workouts-load-state")

    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Workout details couldn’t be loaded.")
    expect(alert?.textContent).toContain("Nothing has been changed.")
    expect(host.textContent).not.toContain("Internal workout detail retrieval")
    expect(host.querySelector(".workouts-list-item-button")?.textContent).toContain("strength-training")
    expect(host.querySelector(".workouts-list-item-button")?.getAttribute("aria-current")).toBe("true")
    expect(detailQueries()).toEqual([[workoutNodeId, 0]])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(detailGenerations()).toEqual([0, 1])
    const retryingButton = host.querySelector<HTMLButtonElement>(".workouts-load-state button")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    queryStateMock.detailByGeneration.set(1, { status: "loading" as const })
    await rerender(host)
    const loadingStatus = host.querySelector<HTMLElement>(".workouts-detail-loading")
    expect(loadingStatus?.textContent).toContain("Loading workout…")
    expect(loadingStatus?.getAttribute("role")).toBe("status")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")

    queryStateMock.detailByGeneration.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Internal workout detail retrieval" })
    })
    await rerender(host)
    const releasedButton = host.querySelector<HTMLButtonElement>(".workouts-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(detailGenerations()).toEqual([0, 1, 2])
  })

  it("keeps a confirmed missing workout distinct from a retryable detail failure", async () => {
    queryStateMock.detail = { status: "failure" as const, error: new WorkoutNotFound({ nodeId: workoutNodeId }) }
    const host = await mount()
    await selectWorkout(host)
    const notice = host.querySelector<HTMLElement>(".workouts-load-state")

    expect(notice?.getAttribute("role")).toBe("status")
    expect(notice?.textContent).toContain("This workout is no longer available.")
    expect(buttonNamed(host, "Retry")).toBeUndefined()
    expect(host.querySelector(".workouts-list-item-button")?.textContent).toContain("strength-training")
  })

  it("keeps successful strength and cardio rendering unchanged", async () => {
    queryStateMock.detail = {
      status: "success" as const,
      value: {
        workout: {
          ...summary,
          payload: { kind: "strength", exercises: [] }
        }
      }
    }
    const strengthHost = await mount()
    await selectWorkout(strengthHost)

    expect(strengthHost.querySelector(".workouts-detail h3")?.textContent).toBe("strength-training")
    expect(strengthHost.querySelector(".workouts-detail-empty")?.textContent).toContain("No exercises recorded.")

    queryStateMock.detail = {
      status: "success" as const,
      value: {
        workout: {
          ...summary,
          kind: "cardio",
          activity: "running",
          payload: { kind: "cardio", splits: [], distanceMeters: 5000 }
        }
      }
    }
    const cardioHost = await mount()
    await selectWorkout(cardioHost)

    expect(cardioHost.querySelector(".workouts-detail h3")?.textContent).toBe("running")
    expect(cardioHost.querySelector(".workouts-detail-cardio-rollups")?.textContent).toContain("5.00 km")
    expect(cardioHost.querySelector(".workouts-detail-empty")?.textContent).toContain("No split/lap structure recorded")
  })
})
