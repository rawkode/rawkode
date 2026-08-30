/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { UnexpectedError, type LedgerActivityEntry } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  outcomes: new Map<number, "loading" | "success" | "failure">(),
  entries: new Map<number, readonly LedgerActivityEntry[]>(),
  precedingEntries: new Map<number, readonly LedgerActivityEntry[]>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

const dayWindowMock = vi.hoisted(() => ({
  value: {
    from: "2026-08-28T00:00:00.000Z",
    to: "2026-08-29T00:00:00.000Z"
  }
}))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    const refreshKey = dependencies[0]
    if (typeof refreshKey === "number") {
      const precedingEntries = queryStateMock.precedingEntries.get(refreshKey)
      if (precedingEntries !== undefined) {
        queryStateMock.precedingEntries.delete(refreshKey)
        return { status: "success" as const, value: { entries: precedingEntries } }
      }
    }
    const numericRefreshKey = typeof refreshKey === "number" ? refreshKey : undefined
    const outcome = numericRefreshKey === undefined ? "loading" : queryStateMock.outcomes.get(numericRefreshKey) ?? "failure"
    if (outcome === "loading") return { status: "loading" as const }
    if (outcome === "success") return { status: "success" as const, value: { entries: queryStateMock.entries.get(numericRefreshKey!) ?? [] } }
    return { status: "failure" as const, error: new UnexpectedError({ message: privateDetail }) }
  }
}))

vi.mock("./daily-standup-window.js", () => ({
  dailyStandupWindow: () => dayWindowMock.value
}))

import { DailyStandup } from "./LedgerActivityPanel.js"

const privateDetail = "private ledger provider detail"
const activity: LedgerActivityEntry = {
  occurredAt: "2026-08-28T09:30:00.000Z",
  type: "createNodeWithIntent",
  actor: "you",
  message: "Record the team standup outcomes."
} as LedgerActivityEntry
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<DailyStandup />)
    await flush()
  })
  return host
}

const rerender = async (): Promise<void> => {
  await act(async () => {
    for (const { root } of roots) root.render(<DailyStandup />)
    await flush()
  })
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.outcomes.clear()
  queryStateMock.entries.clear()
  queryStateMock.precedingEntries.clear()
  queryStateMock.dependencies = []
  dayWindowMock.value = {
    from: "2026-08-28T00:00:00.000Z",
    to: "2026-08-29T00:00:00.000Z"
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("DailyStandup activity recovery", () => {
  it("makes a failed activity read actionable without exposing its cause and restores the normal empty state after refresh", async () => {
    const host = await mount()

    const alert = host.querySelector<HTMLElement>(".ledger-activity-state")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Recorded activity couldn’t be loaded.")
    expect(alert?.textContent).toContain("Nothing has been changed. Refresh to check this workspace again.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.textContent).not.toContain("No ledgered changes yet.")
    expect(host.querySelector("#daily-standup-title")?.textContent).toBe("Recorded work")
    expect(queryStateMock.dependencies).toEqual(expect.arrayContaining([[0, true]]))
    expect(queryStateMock.dependencies.every((dependencies) => dependencies[0] === 0)).toBe(true)

    queryStateMock.outcomes.set(1, "success")
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[aria-label='Refresh recorded work']")?.click()
      await flush()
    })
    await rerender()

    expect(host.querySelector("[role='alert']")).toBeNull()
    expect(host.textContent).toContain("No ledgered changes yet.")
    expect(queryStateMock.dependencies).toContainEqual([1, true])
  })

  it("keeps same-window recorded work visible through refresh and failure until a confirmed empty result replaces it", async () => {
    queryStateMock.outcomes.set(0, "success")
    queryStateMock.entries.set(0, [activity])
    const host = await mount()

    expect(host.textContent).toContain(activity.message)
    expect(host.querySelector(".ledger-activity-summary")?.textContent).toContain("1 change")

    queryStateMock.outcomes.set(1, "loading")
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[aria-label='Refresh recorded work']")?.click()
      await flush()
    })
    await rerender()

    expect(host.querySelector("[role='status']")?.textContent).toContain("Refreshing activity…")
    expect(host.textContent).toContain(activity.message)
    expect(host.textContent).not.toContain("No ledgered changes yet.")

    queryStateMock.outcomes.set(1, "failure")
    await rerender()

    expect(host.querySelector("[role='alert']")?.textContent).toContain("Recorded activity couldn’t be loaded.")
    expect(host.textContent).toContain(activity.message)
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.textContent).not.toContain("No ledgered changes yet.")

    queryStateMock.outcomes.set(2, "success")
    queryStateMock.entries.set(2, [])
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[aria-label='Refresh recorded work']")?.click()
      await flush()
    })
    await rerender()

    expect(host.querySelector("[role='alert']")).toBeNull()
    expect(host.textContent).not.toContain(activity.message)
    expect(host.textContent).toContain("No ledgered changes yet.")
    expect(queryStateMock.dependencies).toContainEqual([2, true])
  })

  it("does not carry recorded work into a different daily window", async () => {
    queryStateMock.outcomes.set(0, "success")
    queryStateMock.entries.set(0, [activity])
    const host = await mount()

    dayWindowMock.value = {
      from: "2026-08-29T00:00:00.000Z",
      to: "2026-08-30T00:00:00.000Z"
    }
    queryStateMock.outcomes.set(1, "loading")
    // `useEffectQuery` exposes the preceding settled state for the first render of a new
    // generation. The view must not relabel that state as a successful result for tomorrow.
    queryStateMock.precedingEntries.set(1, [activity])
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[aria-label='Refresh recorded work']")?.click()
      await flush()
    })
    await rerender()

    expect(host.querySelector("[role='status']")?.textContent).toContain("Loading activity…")
    expect(host.textContent).not.toContain(activity.message)

    queryStateMock.outcomes.set(1, "failure")
    await rerender()

    expect(host.querySelector("[role='alert']")?.textContent).toContain("Recorded activity couldn’t be loaded.")
    expect(host.textContent).not.toContain(activity.message)
  })
})
