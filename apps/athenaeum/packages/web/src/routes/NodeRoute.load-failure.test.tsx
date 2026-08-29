/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  nodeState: undefined as unknown,
  nodeOutcomes: new Map<number, "loading" | "failure">(),
  pageOutcomes: new Map<number, "loading" | "failure" | "notFound">(),
  nodeDependencies: [] as ReadonlyArray<unknown>[],
  pageDependencies: [] as ReadonlyArray<unknown>[],
  callIndex: 0
}))
const routeMock = vi.hoisted(() => ({ nodeId: "" }))

vi.mock("../use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    const isNodeQuery = queryStateMock.callIndex % 2 === 0
    queryStateMock.callIndex += 1
    if (isNodeQuery) {
      queryStateMock.nodeDependencies.push([...dependencies])
      const refreshKey = dependencies[1]
      const outcome = typeof refreshKey === "number" ? queryStateMock.nodeOutcomes.get(refreshKey) : undefined
      if (outcome === "loading") return { status: "loading" as const }
      if (outcome === "failure") return { status: "failure" as const, error: new Error("Internal node lookup detail") }
      return queryStateMock.nodeState
    }

    queryStateMock.pageDependencies.push([...dependencies])
    const refreshKey = dependencies[1]
    const outcome = typeof refreshKey === "number"
      ? queryStateMock.pageOutcomes.get(refreshKey) ?? "failure"
      : "loading"
    if (outcome === "loading") return { status: "loading" as const }
    if (outcome === "notFound") return { status: "failure" as const, error: { _tag: "PageNotFound" } }
    return { status: "failure" as const, error: new Error("Internal page lookup detail") }
  }
}))
vi.mock("react-router", () => ({
  Link: ({ children }: { readonly children?: ReactNode }) => <a>{children}</a>,
  Navigate: ({ to }: { readonly to: string }) => <output data-navigate>{to}</output>,
  useParams: () => ({ nodeId: routeMock.nodeId })
}))
vi.mock("../NoteTags.js", () => ({
  NoteTags: ({ nodeId }: { readonly nodeId: string }) => <output data-note-tags>{nodeId}</output>
}))
vi.mock("../Backlinks.js", () => ({
  Backlinks: ({ nodeId }: { readonly nodeId: string }) => <output data-backlinks>{nodeId}</output>
}))
vi.mock("../SupertagFieldPopover.js", () => ({ SupertagFieldPopover: () => null }))

import { NodeRoute } from "./NodeRoute.js"

const genericNodeId = "00000000-0000-4000-8000-000000000042"
const canonicalDailyNodeId = "00000000-0000-4000-8000-000020260827"
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const render = async (root: Root): Promise<void> => {
  queryStateMock.callIndex = 0
  await act(async () => {
    root.render(<NodeRoute />)
    await flush()
  })
}

const mount = async (): Promise<{ readonly root: Root; readonly host: HTMLDivElement }> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root)
  return { root, host }
}

const queryKeys = (dependencies: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<number> =>
  dependencies.map((entry) => entry[1]).filter((key): key is number => typeof key === "number")

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  routeMock.nodeId = genericNodeId
  queryStateMock.nodeState = { status: "loading" }
  queryStateMock.nodeOutcomes.clear()
  queryStateMock.pageOutcomes.clear()
  queryStateMock.nodeDependencies = []
  queryStateMock.pageDependencies = []
  queryStateMock.callIndex = 0
})

afterEach(() => {
  queryStateMock.nodeState = undefined
  queryStateMock.nodeOutcomes.clear()
  queryStateMock.pageOutcomes.clear()
  queryStateMock.nodeDependencies = []
  queryStateMock.pageDependencies = []
  queryStateMock.callIndex = 0
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("NodeRoute load recovery", () => {
  it("keeps a failed node lookup generic while retrying it once at a time", async () => {
    queryStateMock.nodeState = { status: "failure", error: new Error("Internal node lookup detail") }
    const { root, host } = await mount()
    const alert = host.querySelector<HTMLElement>(".node-view-load-state")

    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("This node couldn’t be loaded.")
    expect(host.textContent).not.toContain("Internal node lookup detail")
    expect(host.textContent).not.toContain("No page content yet")
    expect(queryKeys(queryStateMock.nodeDependencies)).toEqual([0])
    expect(queryKeys(queryStateMock.pageDependencies)).toEqual([0])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(queryKeys(queryStateMock.nodeDependencies)).toEqual([0, 1])
    expect(queryKeys(queryStateMock.pageDependencies)).toEqual([0, 0])
    expect(host.querySelector<HTMLButtonElement>(".node-view-load-state button")?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>(".node-view-load-state button")?.textContent).toBe("Retrying…")

    queryStateMock.nodeOutcomes.set(1, "loading")
    await render(root)
    const loading = host.querySelector<HTMLElement>(".node-view-loading")
    expect(loading?.textContent).toBe("Loading node…")
    expect(loading?.getAttribute("role")).toBe("status")
    expect(loading?.getAttribute("aria-live")).toBe("polite")
    expect(loading?.getAttribute("aria-atomic")).toBe("true")

    queryStateMock.nodeOutcomes.set(1, "failure")
    await render(root)
    const releasedRetry = host.querySelector<HTMLButtonElement>(".node-view-load-state button")
    expect(releasedRetry?.disabled).toBe(false)
    expect(releasedRetry?.textContent).toBe("Retry")
    const nodeQueryCountBeforeNextRetry = queryStateMock.nodeDependencies.length
    const pageQueryCountBeforeNextRetry = queryStateMock.pageDependencies.length

    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(queryKeys(queryStateMock.nodeDependencies).slice(nodeQueryCountBeforeNextRetry)).toEqual([2])
    expect(queryKeys(queryStateMock.pageDependencies).slice(pageQueryCountBeforeNextRetry)).toEqual([0])
  })

  it("keeps loaded node metadata visible while a failed page preview retries once at a time", async () => {
    queryStateMock.nodeState = { status: "success", value: { node: { title: "Project Atlas" } } }
    const { root, host } = await mount()
    const alert = host.querySelector<HTMLElement>(".node-view-page-load-state")

    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Page content couldn’t be loaded.")
    expect(host.textContent).not.toContain("Internal page lookup detail")
    expect(host.textContent).not.toContain("No page content yet")
    expect(host.querySelector("h1")?.textContent).toBe("Project Atlas")
    expect(host.querySelector("[data-note-tags]")?.textContent).toBe(genericNodeId)
    expect(host.querySelector("[data-backlinks]")?.textContent).toBe(genericNodeId)
    expect(queryKeys(queryStateMock.nodeDependencies)).toEqual([0])
    expect(queryKeys(queryStateMock.pageDependencies)).toEqual([0])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(queryKeys(queryStateMock.nodeDependencies)).toEqual([0, 0])
    expect(queryKeys(queryStateMock.pageDependencies)).toEqual([0, 1])
    expect(host.querySelector<HTMLButtonElement>(".node-view-page-load-state button")?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>(".node-view-page-load-state button")?.textContent).toBe("Retrying…")

    queryStateMock.pageOutcomes.set(1, "loading")
    await render(root)
    expect(host.querySelector("h2")?.textContent).toBe("Loading content…")
    expect(host.querySelector("h1")?.textContent).toBe("Project Atlas")
    expect(host.querySelector("[data-note-tags]")?.textContent).toBe(genericNodeId)
    expect(host.querySelector("[data-backlinks]")?.textContent).toBe(genericNodeId)

    queryStateMock.pageOutcomes.set(1, "failure")
    await render(root)
    const releasedRetry = host.querySelector<HTMLButtonElement>(".node-view-page-load-state button")
    expect(releasedRetry?.disabled).toBe(false)
    expect(releasedRetry?.textContent).toBe("Retry")
    const nodeQueryCountBeforeNextRetry = queryStateMock.nodeDependencies.length
    const pageQueryCountBeforeNextRetry = queryStateMock.pageDependencies.length

    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(queryKeys(queryStateMock.nodeDependencies).slice(nodeQueryCountBeforeNextRetry)).toEqual([0])
    expect(queryKeys(queryStateMock.pageDependencies).slice(pageQueryCountBeforeNextRetry)).toEqual([2])
  })

  it("shows the empty page only for a known PageNotFound absence", async () => {
    queryStateMock.nodeState = { status: "success", value: { node: { title: "Project Atlas" } } }
    queryStateMock.pageOutcomes.set(0, "notFound")
    const { host } = await mount()

    expect(host.textContent).toContain("No page content yet")
    expect(host.querySelector("[role=alert]")).toBeNull()
  })

  it("redirects a canonical daily note before either generic query can start", async () => {
    routeMock.nodeId = canonicalDailyNodeId
    const { host } = await mount()

    expect(host.querySelector("[data-navigate]")?.textContent).toBe("/notes?date=2026-08-27")
    expect(queryStateMock.nodeDependencies).toEqual([])
    expect(queryStateMock.pageDependencies).toEqual([])
  })
})
