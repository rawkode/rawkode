/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  byRefreshKey: new Map<number, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))
const bookmarkIntentMock = vi.hoisted(() => ({
  pending: null as { readonly requestId: string; readonly url: string; readonly title?: string } | null
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.byRefreshKey.get(Number(dependencies[0])) ?? queryStateMock.current
  }
}))
vi.mock("./bookmark-intent.js", () => ({
  clearPendingBookmarkIntent: () => undefined,
  persistPendingBookmarkIntent: () => undefined,
  readPendingBookmarkIntent: () => bookmarkIntentMock.pending,
  resolveBookmarkIntent: (
    url: string,
    title: string,
    pending: { readonly requestId: string; readonly url: string; readonly title?: string } | null
  ) => pending ?? {
    requestId: "bookmark-request-1",
    url,
    ...(title.length > 0 ? { title } : {})
  }
}))

import { BookmarksPanel } from "./BookmarksPanel.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const submitCapture = (host: HTMLDivElement): void => {
  host.querySelector<HTMLFormElement>(".bookmarks-form")?.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true })
  )
}

const renderPanel = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<BookmarksPanel />)
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
  [...new Set(queryStateMock.dependencies.map((dependencies) => dependencies[0]))].filter(
    (generation): generation is number => typeof generation === "number"
  )

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  queryStateMock.dependencies = []
  queryStateMock.byRefreshKey.clear()
  bookmarkIntentMock.pending = null
  queryStateMock.current = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal bookmark archive detail" })
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

describe("BookmarksPanel list recovery", () => {
  it("keeps capture usable through a generic retryable archive failure and retries only one list read at a time", async () => {
    const { host, root } = await mount()

    const alert = host.querySelector<HTMLElement>(".bookmarks-load-state")
    const url = host.querySelector<HTMLInputElement>("[aria-label='Bookmark URL']")
    const title = host.querySelector<HTMLInputElement>("[aria-label='Bookmark title (optional)']")
    expect(host.querySelectorAll(".bookmarks-load-state")).toHaveLength(1)
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Bookmarks couldn’t be loaded.")
    expect(host.textContent).not.toContain("Internal bookmark archive detail")
    expect(host.textContent).not.toContain("No bookmarks yet")
    expect(url).not.toBeNull()
    expect(title).not.toBeNull()
    expect(refreshGenerations()).toEqual([0])

    await act(async () => {
      if (url) setInput(url, "https://example.com/reading")
      if (title) setInput(title, "Reading list")
      await flush()
    })

    expect(url?.value).toBe("https://example.com/reading")
    expect(title?.value).toBe("Reading list")

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(refreshGenerations()).toEqual([0, 1])
    expect(host.querySelector<HTMLButtonElement>(".bookmarks-load-state button")?.textContent).toBe("Retrying…")
    expect(host.querySelector<HTMLButtonElement>(".bookmarks-load-state button")?.disabled).toBe(true)
    expect(url?.value).toBe("https://example.com/reading")
    expect(title?.value).toBe("Reading list")

    queryStateMock.byRefreshKey.set(1, { status: "loading" as const })
    await renderPanel(root)
    expect(host.textContent).toContain("Loading…")
    const loadingStatus = host.querySelector('[role="status"]')
    expect(loadingStatus?.textContent).toBe("Loading…")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")

    queryStateMock.byRefreshKey.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Private bookmark retry detail" })
    })
    await renderPanel(root)

    const releasedRetry = host.querySelector<HTMLButtonElement>(".bookmarks-load-state button")
    expect(releasedRetry?.textContent).toBe("Retry")
    expect(releasedRetry?.disabled).toBe(false)
    expect(host.textContent).not.toContain("Private bookmark retry detail")
    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(refreshGenerations()).toEqual([0, 1, 2])
  })

  it("keeps a successful empty archive distinct from a failed list request", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: { bookmarks: [] }
    }

    const { host } = await mount()

    expect(host.querySelector(".bookmarks-load-state")).toBeNull()
    expect(host.querySelector(".bookmarks-empty")?.textContent).toContain("No bookmarks yet")
    expect(host.querySelector("[role='alert']")).toBeNull()
  })

  it("retains a confirmed archive through a capture-triggered reload failure and replaces it on success", async () => {
    let observer: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (next: (exit: unknown) => void) => {
        observer = next
      }
    }))
    const existingBookmark = {
      id: "00000000-0000-4000-8000-000000000010",
      url: "https://example.com/reading",
      title: "Reading list",
      capturedAt: "2026-08-28T10:00:00.000Z"
    }
    queryStateMock.current = {
      status: "success" as const,
      value: { bookmarks: [existingBookmark] }
    }

    const { host, root } = await mount()
    const url = host.querySelector<HTMLInputElement>("[aria-label='Bookmark URL']")
    expect(host.querySelector<HTMLAnchorElement>(".bookmarks-list a")?.textContent).toBe("Reading list")

    await act(async () => {
      setInput(url!, "https://example.com/new")
      submitCapture(host)
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

    queryStateMock.byRefreshKey.set(1, { status: "loading" as const })
    await act(async () => {
      observer?.(Exit.succeed(undefined))
      await flush()
    })

    expect(refreshGenerations()).toEqual([0, 1])
    expect(host.textContent).toContain("Refreshing bookmarks…")
    const refreshStatus = host.querySelector('[role="status"]')
    expect(refreshStatus?.textContent).toBe("Refreshing bookmarks…")
    expect(refreshStatus?.getAttribute("aria-live")).toBe("polite")
    expect(refreshStatus?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector<HTMLAnchorElement>(".bookmarks-list a")?.textContent).toBe("Reading list")
    expect(host.querySelector(".bookmarks-empty")).toBeNull()

    const privateDetail = "private bookmark reload detail"
    queryStateMock.byRefreshKey.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: privateDetail })
    })
    await renderPanel(root)

    const alert = host.querySelector<HTMLElement>(".bookmarks-load-state")
    expect(alert?.textContent).toContain("Bookmarks couldn’t be refreshed.")
    expect(alert?.textContent).toContain("previously loaded bookmarks remain available")
    expect(host.querySelector<HTMLAnchorElement>(".bookmarks-list a")?.textContent).toBe("Reading list")
    expect(host.textContent).not.toContain(privateDetail)

    queryStateMock.byRefreshKey.set(1, {
      status: "success" as const,
      value: { bookmarks: [] }
    })
    await renderPanel(root)

    expect(host.querySelector(".bookmarks-load-state")).toBeNull()
    expect(host.querySelector(".bookmarks-empty")?.textContent).toContain("No bookmarks yet")
    expect(host.querySelector(".bookmarks-list a")).toBeNull()
  })
})
