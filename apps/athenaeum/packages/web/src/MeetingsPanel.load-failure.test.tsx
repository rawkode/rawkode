/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError, type Meeting } from "@athenaeum/domain"
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

import { MeetingsPanel } from "./MeetingsPanel.js"

const meeting = {
  id: EntityId.make("00000000-0000-4000-8000-000000000002"),
  title: "Project Atlas review",
  startedAt: "2026-08-28T09:00:00.000Z",
  endedAt: "2026-08-28T09:30:00.000Z"
} as Meeting

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const renderPanel = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<MeetingsPanel />)
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
    error: new UnexpectedError({ message: "Internal meeting history detail" })
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

describe("MeetingsPanel list recovery", () => {
  it("shows a generic retryable list failure without presenting an empty history and refreshes only one list read at a time", async () => {
    const { host, root } = await mount()

    const alert = host.querySelector<HTMLElement>(".meetings-load-state")
    expect(host.querySelectorAll(".meetings-load-state")).toHaveLength(1)
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Meetings couldn’t be loaded.")
    expect(host.textContent).not.toContain("Internal meeting history detail")
    expect(host.textContent).not.toContain("Your meeting history starts here")
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
    expect(host.querySelector(".meetings-load-state")).toBeNull()

    queryStateMock.byRefreshKey.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Private meeting retry detail" })
    })
    await renderPanel(root)

    const releasedRetry = buttonNamed(host, "Retry")
    expect(buttonNamed(host, "Refresh")?.disabled).toBe(false)
    expect(releasedRetry?.disabled).toBe(false)
    expect(host.textContent).not.toContain("Private meeting retry detail")
    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(refreshGenerations()).toEqual([0, 1, 2])
  })

  it("keeps a successful empty history distinct from a failed list request", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: { meetings: [] }
    }

    const { host } = await mount()

    expect(host.querySelector(".meetings-load-state")).toBeNull()
    expect(host.querySelector(".empty-state")?.textContent).toContain("Your meeting history starts here")
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
    const loadingStatus = host.querySelector('[role="status"]')
    expect(loadingStatus?.textContent).toBe("Loading meetings…")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")
  })

  it("retains meetings during a refresh and failure until a current empty history arrives", async () => {
    const privateDetail = "private meeting history provider detail"
    queryStateMock.current = { status: "success" as const, value: { meetings: [meeting] } }
    const { host, root } = await mount()

    expect(host.querySelector(".meetings-list-item-title")?.textContent).toBe("Project Atlas review")
    expect(host.querySelector(".empty-state")).toBeNull()

    queryStateMock.byRefreshKey.set(1, { status: "loading" as const })
    await act(async () => {
      buttonNamed(host, "Refresh")?.click()
      await flush()
    })

    expect(refreshGenerations()).toEqual([0, 1])
    expect(buttonNamed(host, "Refreshing…")?.disabled).toBe(true)
    const refreshStatus = host.querySelector('[role="status"]')
    expect(refreshStatus?.textContent).toBe("Refreshing meetings…")
    expect(refreshStatus?.getAttribute("aria-live")).toBe("polite")
    expect(refreshStatus?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector(".meetings-list-item-title")?.textContent).toBe("Project Atlas review")
    expect(host.querySelector(".empty-state")).toBeNull()

    queryStateMock.byRefreshKey.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: privateDetail })
    })
    await renderPanel(root)

    expect(host.querySelector(".meetings-list-item-title")?.textContent).toBe("Project Atlas review")
    expect(host.querySelector("[role='alert']")?.textContent).toContain("previously loaded meetings remain available")
    expect(host.textContent).not.toContain(privateDetail)

    queryStateMock.byRefreshKey.set(1, { status: "success" as const, value: { meetings: [] } })
    await renderPanel(root)

    expect(host.querySelector(".meetings-list-item-title")).toBeNull()
    expect(host.querySelector(".empty-state")?.textContent).toContain("Your meeting history starts here")
  })
})
