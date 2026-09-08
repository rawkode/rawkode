/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { WorkspaceNotFound } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  byQuery: new Map<string, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))
const routerMock = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    const dateStamp = dependencies[0]
    const refreshKey = dependencies[1]
    const queryKey = typeof dateStamp === "string" && typeof refreshKey === "number"
      ? `${dateStamp}:${refreshKey}`
      : undefined
    return queryKey === undefined ? queryStateMock.current : queryStateMock.byQuery.get(queryKey) ?? queryStateMock.current
  }
}))
vi.mock("react-router", () => ({ useNavigate: () => routerMock.navigate }))

import { CalendarEventsPanel } from "./CalendarEventsPanel.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const renderPanel = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<CalendarEventsPanel />)
    await flush()
  })
}

const mount = async (
  state: unknown = { status: "success" as const, value: { events: [] } }
): Promise<{ readonly host: HTMLDivElement; readonly root: Root }> => {
  queryStateMock.current = state
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await renderPanel(root)
  return { host, root }
}

const queryKey = (dateStamp: string, refreshKey: number): string => `${dateStamp}:${refreshKey}`

const refreshGenerations = (): ReadonlyArray<number> => [
  ...new Set(
    queryStateMock.dependencies
      .map((dependencies) => dependencies[1])
      .filter((value): value is number => typeof value === "number")
  )
]

const setDate = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 7, 28, 12, 0, 0))
  queryStateMock.byQuery.clear()
  queryStateMock.dependencies = []
  routerMock.navigate.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  queryStateMock.current = undefined
  queryStateMock.byQuery.clear()
  queryStateMock.dependencies = []
  routerMock.navigate.mockReset()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("CalendarEventsPanel day retrieval", () => {
  it("shares one refresh claim across header, retry, and focus events before releasing it after settled reads", async () => {
    const { host, root } = await mount({
      status: "failure",
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Choose calendar day"]')
    const headerRefresh = host.querySelector<HTMLButtonElement>(".calendar-events-refresh")

    expect(host.querySelectorAll(".calendar-events-load-state")).toHaveLength(1)
    expect(host.querySelector("[role=alert]")?.textContent).toContain("The schedule could not be loaded.")
    expect(host.textContent).not.toContain("This workspace doesn't exist")
    expect(host.textContent).not.toContain("No events are synced")
    expect(input?.value).toBe("2026-08-28")
    expect(queryStateMock.dependencies).toEqual([["2026-08-28", 0]])

    await act(async () => {
      headerRefresh?.click()
      host.querySelector<HTMLButtonElement>(".calendar-events-load-state button")?.click()
      window.dispatchEvent(new Event("focus"))
      await flush()
    })
    expect(input?.value).toBe("2026-08-28")
    expect(refreshGenerations()).toEqual([0, 1])
    expect(headerRefresh?.disabled).toBe(true)
    expect(headerRefresh?.textContent).toBe("Refreshing…")
    expect(host.querySelector<HTMLButtonElement>(".calendar-events-load-state button")?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>(".calendar-events-load-state button")?.textContent).toBe("Retrying…")

    queryStateMock.byQuery.set(queryKey("2026-08-28", 1), { status: "loading" as const })
    await renderPanel(root)
    expect(headerRefresh?.disabled).toBe(true)
    expect(host.querySelector(".calendar-events-load-state")).toBeNull()

    queryStateMock.byQuery.set(queryKey("2026-08-28", 1), { status: "success" as const, value: { events: [] } })
    await renderPanel(root)
    expect(headerRefresh?.disabled).toBe(false)
    expect(headerRefresh?.textContent).toBe("Refresh")

    await act(async () => {
      headerRefresh?.click()
      window.dispatchEvent(new Event("focus"))
      await flush()
    })
    expect(refreshGenerations()).toEqual([0, 1, 2])

    queryStateMock.byQuery.set(queryKey("2026-08-28", 2), { status: "loading" as const })
    await renderPanel(root)

    queryStateMock.byQuery.set(queryKey("2026-08-28", 2), {
      status: "failure" as const,
      error: new Error("Private calendar retry detail")
    })
    await renderPanel(root)
    expect(headerRefresh?.disabled).toBe(false)
    expect(host.textContent).not.toContain("Private calendar retry detail")

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".calendar-events-load-state button")?.click()
      await flush()
    })
    expect(refreshGenerations()).toEqual([0, 1, 2, 3])
  })

  it("re-reads the active day after a connection panel confirms a sync request", async () => {
    const { host } = await mount()
    expect(queryStateMock.dependencies).toEqual([["2026-08-28", 0]])

    await act(async () => {
      window.dispatchEvent(new Event("athenaeum:calendarSyncTriggered"))
      await flush()
    })

    expect(queryStateMock.dependencies.at(-1)).toEqual(["2026-08-28", 1])
    expect(host.querySelector<HTMLButtonElement>(".calendar-events-refresh")?.disabled).toBe(true)
  })

  it("releases a claimed refresh when day navigation starts a different read", async () => {
    const { host } = await mount({
      status: "failure",
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })
    const headerRefresh = host.querySelector<HTMLButtonElement>(".calendar-events-refresh")
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Choose calendar day"]')

    await act(async () => {
      headerRefresh?.click()
      await flush()
    })
    expect(headerRefresh?.disabled).toBe(true)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Previous day"]')?.click()
      await flush()
    })
    expect(input?.value).toBe("2026-08-27")
    expect(headerRefresh?.disabled).toBe(false)

    await act(async () => {
      headerRefresh?.click()
      await flush()
    })
    expect(queryStateMock.dependencies.at(-1)).toEqual(["2026-08-27", 2])
  })

  it("moves through local calendar days and hands a historic day to its daily note", async () => {
    const { host } = await mount()
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Choose calendar day"]')
    expect(input?.value).toBe("2026-08-28")
    expect(host.textContent).toContain("Today’s events")

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Previous day"]')?.click()
      await flush()
    })
    expect(input?.value).toBe("2026-08-27")
    expect(host.textContent).toContain("No events are synced for 2026-08-27.")
    expect(host.querySelector<HTMLButtonElement>(".calendar-events-day-nav-today")?.textContent).toBe("Today")

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".calendar-events-open-note")?.click()
      await flush()
    })
    expect(routerMock.navigate).toHaveBeenLastCalledWith("/notes?date=2026-08-27")
  })

  it("accepts real date input, ignores an impossible day, and preserves the canonical today route", async () => {
    const { host } = await mount()
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Choose calendar day"]')
    expect(input).not.toBeNull()

    await act(async () => {
      setDate(input!, "2026-02-28")
      await flush()
    })
    expect(input?.value).toBe("2026-02-28")

    await act(async () => {
      setDate(input!, "2026-02-30")
      await flush()
    })
    expect(input?.value).toBe("2026-02-28")

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".calendar-events-day-nav-today")?.click()
      await flush()
    })
    expect(input?.value).toBe("2026-08-28")

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".calendar-events-open-note")?.click()
      await flush()
    })
    expect(routerMock.navigate).toHaveBeenLastCalledWith("/notes")
  })
})
