/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

const queryState = vi.hoisted(() => ({
  settled: new Map<number, "success" | "failure">(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryState.dependencies.push([...dependencies])
    const refreshKey = dependencies[0]
    const outcome = typeof refreshKey === "number"
      ? queryState.settled.get(refreshKey) ?? (refreshKey === 0 ? "success" : "loading")
      : "loading"
    if (outcome === "success") return { status: "success" as const, value: { entries: [] } }
    if (outcome === "failure") return { status: "failure" as const, error: new Error("private ledger refresh detail") }
    return { status: "loading" as const }
  }
}))

import { DailyStandup } from "./LedgerActivityPanel.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const refreshKeys = (): number[] => [
  ...new Set(
    queryState.dependencies
      .map((dependencies) => dependencies[0])
      .filter((value): value is number => typeof value === "number")
  )
]

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  queryState.settled.clear()
  queryState.dependencies = []
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("DailyStandup refresh single flight", () => {
  it("shares one synchronous claim across header and focus refreshes, then releases it after settled outcomes", async () => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    const render = async () => {
      await act(async () => {
        root.render(<DailyStandup />)
        await flush()
      })
    }
    await render()

    const refresh = host.querySelector<HTMLButtonElement>("[aria-label='Refresh recorded work']")
    expect(refresh).not.toBeNull()

    await act(async () => {
      refresh?.click()
      refresh?.click()
      window.dispatchEvent(new Event("focus"))
      await flush()
    })
    expect(refreshKeys()).toEqual([0, 1])
    expect(refresh?.disabled).toBe(true)
    expect(refresh?.textContent).toBe("Refreshing…")

    queryState.settled.set(1, "success")
    await render()
    expect(refresh?.disabled).toBe(false)
    expect(refresh?.textContent).toBe("Refresh")

    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      refresh?.click()
      await flush()
    })
    expect(refreshKeys()).toEqual([0, 1, 2])
    expect(refresh?.disabled).toBe(true)

    queryState.settled.set(2, "failure")
    await render()
    expect(refresh?.disabled).toBe(false)
    expect(host.querySelector("[role=alert]")?.textContent).not.toContain("private ledger refresh detail")

    await act(async () => {
      refresh?.click()
      await flush()
    })
    expect(refreshKeys()).toEqual([0, 1, 2, 3])
  })
})
