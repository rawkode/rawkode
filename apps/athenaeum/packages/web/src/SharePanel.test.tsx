/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnexpectedError, WorkspaceNotFound, type CollaboratorInfo } from "@athenaeum/domain"

const queryStateMock = vi.hoisted(() => ({
  states: [] as unknown[],
  statesByRefreshKey: new Map<number, readonly [unknown, unknown]>(),
  deps: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./runtime.js", () => ({ runtime: { runFork: vi.fn() } }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, deps: ReadonlyArray<unknown>) => {
    const index = queryStateMock.deps.length % 2
    const state = queryStateMock.statesByRefreshKey.get(Number(deps[0]))?.[index] ?? queryStateMock.states[index]
    queryStateMock.deps.push([...deps])
    return state
  }
}))

import { SharePanel } from "./SharePanel.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const failedState = {
  status: "failure" as const,
  error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000001" })
}

const emptySuccess = (key: "collaborators" | "shareLinks") => ({
  status: "success" as const,
  value: { [key]: [] }
})

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const renderPanel = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<SharePanel />)
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

const refreshGenerations = (): ReadonlyArray<number> =>
  [...new Set(queryStateMock.deps.map((dependencies) => dependencies[0]))].filter(
    (generation): generation is number => typeof generation === "number"
  )

const queryPairCount = (generation: number): number =>
  queryStateMock.deps.filter((dependencies) => dependencies[0] === generation).length

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.states = []
  queryStateMock.statesByRefreshKey.clear()
  queryStateMock.deps = []
})

afterEach(() => {
  queryStateMock.statesByRefreshKey.clear()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("SharePanel load states", () => {
  it("uses one actionable failure state instead of duplicate raw errors and retries both existing queries only once at a time", async () => {
    queryStateMock.states = [failedState, failedState]
    const { host, root } = await mount()

    expect(host.querySelectorAll(".share-load-state")).toHaveLength(1)
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Collaborators and share links could not be loaded.")
    expect(host.textContent).not.toContain("This workspace doesn't exist")
    expect(host.textContent).not.toContain("No collaborators yet.")
    expect(host.textContent).not.toContain("No active share links.")
    expect(host.querySelector<HTMLInputElement>("[aria-label='Collaborator email']")).not.toBeNull()
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "Create share link")).toBe(true)
    expect(refreshGenerations()).toEqual([0])
    expect(queryPairCount(0)).toBe(2)

    await act(async () => {
      const retry = host.querySelector<HTMLButtonElement>(".share-load-state button")
      retry?.click()
      retry?.click()
      await flush()
    })
    expect(refreshGenerations()).toEqual([0, 1])
    expect(queryPairCount(1)).toBe(2)
    expect(host.querySelector<HTMLButtonElement>(".share-load-state button")?.textContent).toBe("Retrying…")
    expect(host.querySelector<HTMLButtonElement>(".share-load-state button")?.disabled).toBe(true)

    queryStateMock.statesByRefreshKey.set(1, [{ status: "loading" as const }, { status: "loading" as const }])
    await renderPanel(root)
    expect(host.querySelector(".share-load-state")).toBeNull()
    const loadingStatuses = [...host.querySelectorAll<HTMLElement>("[role=status]")]
    expect(loadingStatuses.map((status) => status.textContent?.trim())).toEqual([
      "Loading collaborators…",
      "Loading share links…"
    ])
    for (const status of loadingStatuses) {
      expect(status.getAttribute("aria-live")).toBe("polite")
      expect(status.getAttribute("aria-atomic")).toBe("true")
    }

    queryStateMock.statesByRefreshKey.set(1, [
      { status: "failure" as const, error: new UnexpectedError({ message: "Private collaborator retry detail" }) },
      { status: "failure" as const, error: new UnexpectedError({ message: "Private share-link retry detail" }) }
    ])
    await renderPanel(root)

    const releasedRetry = host.querySelector<HTMLButtonElement>(".share-load-state button")
    expect(releasedRetry?.textContent).toBe("Retry")
    expect(releasedRetry?.disabled).toBe(false)
    expect(host.textContent).not.toContain("Private collaborator retry detail")
    expect(host.textContent).not.toContain("Private share-link retry detail")
    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(refreshGenerations()).toEqual([0, 1, 2])
    expect(queryPairCount(2)).toBe(2)
  })

  it("keeps successfully loaded collaborators available when only share links fail", async () => {
    const collaborator = {
      profileId: "alex@example.com",
      role: "use"
    } as CollaboratorInfo
    queryStateMock.states = [
      { status: "success" as const, value: { collaborators: [collaborator] } },
      failedState
    ]
    const { host } = await mount()

    expect(host.textContent).toContain("alex@example.com")
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Share links could not be loaded.")
    expect(host.textContent).not.toContain("No collaborators yet.")
    expect(host.textContent).not.toContain("No active share links.")
  })

  it("keeps normal empty states when both sharing queries succeed", async () => {
    queryStateMock.states = [emptySuccess("collaborators"), emptySuccess("shareLinks")]
    const { host } = await mount()

    expect(host.querySelector(".share-load-state")).toBeNull()
    expect(host.textContent).toContain("No collaborators yet.")
    expect(host.textContent).toContain("No active share links.")
  })
})
