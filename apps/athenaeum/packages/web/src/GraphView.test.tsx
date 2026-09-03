/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { WorkspaceNotFound } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  byDependencies: new Map<string, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./runtime.js", () => ({ runtime: { runFork: vi.fn() } }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.byDependencies.get(JSON.stringify(dependencies)) ?? queryStateMock.current
  }
}))
vi.mock("react-router", () => ({
  Link: ({
    to,
    children,
    className
  }: {
    readonly to: string
    readonly children: ReactNode
    readonly className?: string
  }) => <a className={className} href={to}>{children}</a>
}))

import { GraphView } from "./GraphView.js"
import { dailyNoteIdForDate } from "./daily-note-id.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const graphRefreshKeys = (onlyPerson: boolean): number[] => [
  ...new Set(
    queryStateMock.dependencies
      .filter((dependencies) => dependencies[0] === onlyPerson)
      .map((dependencies) => dependencies[1])
      .filter((value): value is number => typeof value === "number")
  )
]

const buttonNamed = (host: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)

const render = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<GraphView />)
    await flush()
  })
}

const mount = async (state: unknown): Promise<HTMLDivElement> => {
  queryStateMock.current = state
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root)
  return host
}

const rerender = async (host: HTMLDivElement): Promise<void> => {
  const root = roots.find((entry) => entry.host === host)?.root
  if (root === undefined) throw new Error("expected mounted GraphView root")
  await render(root)
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.byDependencies.clear()
  queryStateMock.dependencies = []
})

afterEach(() => {
  queryStateMock.current = undefined
  queryStateMock.byDependencies.clear()
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("GraphView browse recovery", () => {
  it("announces graph loading as an atomic polite status", async () => {
    const host = await mount({ status: "loading" })

    const status = host.querySelector('[role="status"]')
    expect(status?.textContent).toBe("Loading…")
    expect(status?.getAttribute("aria-live")).toBe("polite")
    expect(status?.getAttribute("aria-atomic")).toBe("true")
  })

  it("renders one generic retryable failure instead of an empty or raw domain-error state", async () => {
    const host = await mount({
      status: "failure",
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })

    expect(host.querySelectorAll(".graph-view-load-state")).toHaveLength(1)
    expect(host.querySelector("[role=alert]")?.textContent).toContain("The node list could not be loaded.")
    expect(host.textContent).not.toContain("This workspace doesn't exist")
    expect(host.textContent).not.toContain("No nodes")
    expect(host.querySelector(".graph-view-table-wrap")).toBeNull()
    expect(queryStateMock.dependencies).toEqual([[false, 0]])
    expect(buttonNamed(host, "Refresh")).toBeUndefined()
  })

  it("refreshes a settled current filter only once and restores the control after the existing read settles", async () => {
    const host = await mount({
      status: "success",
      value: {
        rows: [{ id: "00000000-0000-4000-8000-000000000001", title: "Project north", createdAt: "2026-08-28T10:00:00.000Z" }]
      }
    })
    const refresh = buttonNamed(host, "Refresh")
    expect(refresh?.disabled).toBe(false)

    await act(async () => {
      refresh?.click()
      refresh?.click()
      await flush()
    })

    expect(graphRefreshKeys(false)).toEqual([0, 1])
    expect(buttonNamed(host, "Refreshing…")?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>(".graph-view-col-action button")?.disabled).toBe(true)

    queryStateMock.byDependencies.set(JSON.stringify([false, 1]), { status: "loading" as const })
    await rerender(host)
    expect(buttonNamed(host, "Refreshing…")?.disabled).toBe(true)
    expect(host.querySelector(".graph-view-col-action button")).toBeNull()

    queryStateMock.byDependencies.set(JSON.stringify([false, 1]), {
      status: "success" as const,
      value: {
        rows: [{ id: "00000000-0000-4000-8000-000000000001", title: "Project north", createdAt: "2026-08-28T10:00:00.000Z" }]
      }
    })
    await rerender(host)

    expect(buttonNamed(host, "Refresh")?.disabled).toBe(false)
    expect(host.querySelector<HTMLButtonElement>(".graph-view-col-action button")?.disabled).toBe(false)
  })

  it("retries the active people-filter graph read once at a time and releases after a terminal result", async () => {
    const host = await mount({
      status: "failure",
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })
    queryStateMock.byDependencies.set(JSON.stringify([true, 0]), {
      status: "failure" as const,
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })

    await act(async () => {
      const filter = host.querySelector<HTMLInputElement>(".graph-view-filter input")
      filter?.click()
      await flush()
    })
    expect(queryStateMock.dependencies).toEqual([[false, 0], [true, 0]])
    expect(host.textContent).toContain("Loading…")
    expect(host.querySelector(".graph-view-load-state")).toBeNull()

    await rerender(host)
    expect(host.querySelector<HTMLButtonElement>(".graph-view-load-state button")?.textContent).toBe("Retry")

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".graph-view-load-state button")?.click()
      host.querySelector<HTMLButtonElement>(".graph-view-load-state button")?.click()
      await flush()
    })
    expect(graphRefreshKeys(true)).toEqual([0, 1])
    const retryingButton = host.querySelector<HTMLButtonElement>(".graph-view-load-state button")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    queryStateMock.byDependencies.set(JSON.stringify([true, 1]), { status: "loading" as const })
    await rerender(host)
    expect(host.textContent).toContain("Loading…")

    queryStateMock.byDependencies.set(JSON.stringify([true, 1]), {
      status: "failure" as const,
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })
    await rerender(host)
    const releasedButton = host.querySelector<HTMLButtonElement>(".graph-view-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(graphRefreshKeys(true)).toEqual([0, 1, 2])
  })

  it("clears a claimed retry when the active graph filter changes", async () => {
    const host = await mount({
      status: "failure",
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".graph-view-load-state button")?.click()
      await flush()
    })
    expect(graphRefreshKeys(false)).toEqual([0, 1])
    expect(host.querySelector<HTMLButtonElement>(".graph-view-load-state button")?.disabled).toBe(true)

    queryStateMock.byDependencies.set(JSON.stringify([true, 1]), {
      status: "failure" as const,
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000003" })
    })

    await act(async () => {
      host.querySelector<HTMLInputElement>(".graph-view-filter input")?.click()
      await flush()
    })
    expect(graphRefreshKeys(true)).toEqual([1])
    const releasedButton = host.querySelector<HTMLButtonElement>(".graph-view-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(graphRefreshKeys(true)).toEqual([1, 2])
  })

  it("keeps successful node-title retrieval links intact and omits redundant Person tagging when filtered", async () => {
    const host = await mount({
      status: "success",
      value: {
        rows: [{ id: "00000000-0000-4000-8000-000000000001", title: "Project north", createdAt: "2026-08-28T10:00:00.000Z" }]
      }
    })

    expect(host.querySelector(".graph-view-load-state")).toBeNull()
    const link = host.querySelector<HTMLAnchorElement>(".graph-view-title-link")
    expect(link?.textContent).toBe("Project north")
    expect(link?.getAttribute("href")).toBe("/node/00000000-0000-4000-8000-000000000001")
    expect(host.querySelector(".graph-view-col-action button")?.textContent).toBe("+ Person")

    queryStateMock.byDependencies.set(JSON.stringify([true, 0]), {
      status: "success" as const,
      value: {
        rows: [{ id: "00000000-0000-4000-8000-000000000002", title: "Ada Lovelace", createdAt: "2026-08-28T11:00:00.000Z" }]
      }
    })

    await act(async () => {
      host.querySelector<HTMLInputElement>(".graph-view-filter input")?.click()
      await flush()
    })

    expect(queryStateMock.dependencies).toEqual([[false, 0], [true, 0]])
    expect(host.textContent).toContain("Loading…")
    expect(host.querySelector(".graph-view-table-wrap")).toBeNull()
    expect(host.querySelector(".graph-view-count")).toBeNull()
    expect(host.querySelector(".graph-view-col-action button")).toBeNull()
    expect(buttonNamed(host, "Refresh")).toBeUndefined()

    await rerender(host)

    expect(host.querySelector<HTMLAnchorElement>(".graph-view-title-link")?.textContent).toBe("Ada Lovelace")
    expect(host.querySelector<HTMLAnchorElement>(".graph-view-title-link")?.getAttribute("href")).toBe(
      "/node/00000000-0000-4000-8000-000000000002"
    )
    expect(host.querySelector(".graph-view-count")?.textContent).toContain("1 node · tagged Person")
    expect(host.querySelector(".graph-view-col-action button")).toBeNull()
    expect(buttonNamed(host, "Refresh")?.disabled).toBe(false)
  })

  it("routes canonical daily-note rows directly to the date-addressed editor", async () => {
    const dailyNoteId = dailyNoteIdForDate(new Date(2026, 7, 22))
    const host = await mount({
      status: "success",
      value: {
        rows: [{ id: dailyNoteId, title: "Daily Note — 2026-08-22", createdAt: "2026-08-22T10:00:00.000Z" }]
      }
    })

    expect(host.querySelector<HTMLAnchorElement>(".graph-view-title-link")?.getAttribute("href")).toBe(
      "/notes?date=2026-08-22"
    )
  })
})
