/** @vitest-environment happy-dom */

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GetTodayBriefOutput } from "@athenaeum/domain"

const queryState = vi.hoisted(() => ({
  value: undefined as unknown,
  settled: new Map<number, "success" | "failure">(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryState.dependencies.push([...dependencies])
    const refreshKey = dependencies[1]
    const outcome = typeof refreshKey === "number"
      ? queryState.settled.get(refreshKey) ?? (refreshKey === 0 ? "success" : "loading")
      : "loading"
    if (outcome === "success") return { status: "success" as const, value: queryState.value }
    if (outcome === "failure") return { status: "failure" as const, error: new Error("private refresh detail") }
    return { status: "loading" as const }
  }
}))

import { TodayBrief } from "./TodayBrief.js"

const brief = {
  localDate: "2026-08-26",
  timeZone: "UTC",
  calendarHistory: { status: "found" },
  events: []
} as unknown as GetTodayBriefOutput
const reference = new Date("2026-08-26T12:00:00.000Z")

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const refreshKeys = (): number[] => [
  ...new Set(
    queryState.dependencies
      .map((dependencies) => dependencies[1])
      .filter((value): value is number => typeof value === "number")
  )
]

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  queryState.value = undefined
  queryState.settled.clear()
  queryState.dependencies = []
  vi.useRealTimers()
})

describe("TodayBrief refresh single flight", () => {
  it("shares one synchronous claim across stale and header refreshes, then releases it after settled outcomes", async () => {
    vi.useFakeTimers()
    let current = new Date("2026-08-26T23:59:59.999Z")
    const clock = () => current
    queryState.value = brief

    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    const render = async () => {
      await act(async () => {
        root.render(createElement(TodayBrief, { reference, clock }))
        await flush()
      })
    }
    await render()

    current = new Date("2026-08-27T00:00:00.000Z")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
      await flush()
    })
    const staleRefresh = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Refresh brief")
    expect(staleRefresh).not.toBeUndefined()

    await act(async () => {
      staleRefresh?.click()
      staleRefresh?.click()
      await flush()
    })
    const headerRefresh = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh today’s brief"]')
    expect(refreshKeys()).toEqual([0, 1])
    expect(headerRefresh?.disabled).toBe(true)
    expect(headerRefresh?.textContent).toBe("Refreshing…")

    queryState.settled.set(1, "success")
    await render()
    expect(headerRefresh?.disabled).toBe(false)
    expect(headerRefresh?.textContent).toBe("Refresh")

    await act(async () => {
      headerRefresh?.click()
      headerRefresh?.click()
      await flush()
    })
    expect(refreshKeys()).toEqual([0, 1, 2])
    expect(headerRefresh?.disabled).toBe(true)

    queryState.settled.set(2, "failure")
    await render()
    expect(headerRefresh?.disabled).toBe(false)
    expect(host.querySelector("[role=alert]")?.textContent).not.toContain("private refresh detail")

    await act(async () => {
      headerRefresh?.click()
      await flush()
    })
    expect(refreshKeys()).toEqual([0, 1, 2, 3])
  })
})
