/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({ dependencies: [] as ReadonlyArray<unknown>[] }))
const bookmarkIntentMock = vi.hoisted(() => ({
  cleared: vi.fn(),
  persisted: [] as Array<{ readonly requestId: string; readonly url: string; readonly title?: string }>,
  pending: null as { readonly requestId: string; readonly url: string; readonly title?: string } | null,
  resolvedPending: [] as Array<{ readonly requestId: string; readonly url: string; readonly title?: string } | null>
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return { status: "success" as const, value: { bookmarks: [] } }
  }
}))
vi.mock("./bookmark-intent.js", () => ({
  clearPendingBookmarkIntent: () => bookmarkIntentMock.cleared(),
  persistPendingBookmarkIntent: (_workspaceId: unknown, intent: { readonly requestId: string; readonly url: string; readonly title?: string }) => {
    bookmarkIntentMock.persisted.push(intent)
  },
  readPendingBookmarkIntent: () => bookmarkIntentMock.pending,
  resolveBookmarkIntent: (
    url: string,
    title: string,
    pending: { readonly requestId: string; readonly url: string; readonly title?: string } | null
  ) => {
    bookmarkIntentMock.resolvedPending.push(pending)
    return pending ?? {
      requestId: "bookmark-request-1",
      url,
      ...(title.length > 0 ? { title } : {})
    }
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
  host.querySelector(".bookmarks-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<BookmarksPanel />)
    await flush()
  })
  return host
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  queryStateMock.dependencies = []
  bookmarkIntentMock.cleared.mockReset()
  bookmarkIntentMock.persisted = []
  bookmarkIntentMock.pending = null
  bookmarkIntentMock.resolvedPending = []
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("BookmarksPanel capture custody", () => {
  it("keeps a failed capture generic and reuses its frozen intent until a confirmed success", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private bookmark storage provider detail"
    const urlValue = "https://example.com/research"
    const titleValue = "Research"
    const host = await mount()
    const url = host.querySelector<HTMLInputElement>("[aria-label='Bookmark URL']")
    const title = host.querySelector<HTMLInputElement>("[aria-label='Bookmark title (optional)']")

    await act(async () => {
      setInput(url!, urlValue)
      setInput(title!, titleValue)
      submitCapture(host)
      submitCapture(host)
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(bookmarkIntentMock.resolvedPending).toEqual([null])
    expect(bookmarkIntentMock.persisted).toEqual([
      { requestId: "bookmark-request-1", url: urlValue, title: titleValue }
    ])
    expect(host.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true)

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that this bookmark was saved.")
    expect(alert?.textContent).toContain("Your capture details are still here.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(url?.value).toBe(urlValue)
    expect(title?.value).toBe(titleValue)
    expect(bookmarkIntentMock.cleared).not.toHaveBeenCalled()
    expect(queryStateMock.dependencies.every((dependencies) => dependencies[0] === 0)).toBe(true)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      submitCapture(host)
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
    expect(bookmarkIntentMock.resolvedPending).toEqual([null, bookmarkIntentMock.persisted[0]])
    expect(bookmarkIntentMock.persisted).toEqual([
      { requestId: "bookmark-request-1", url: urlValue, title: titleValue },
      { requestId: "bookmark-request-1", url: urlValue, title: titleValue }
    ])

    await act(async () => {
      observers[1]?.(Exit.succeed(undefined))
      await flush()
    })

    expect(bookmarkIntentMock.cleared).toHaveBeenCalledTimes(1)
    expect(url?.value).toBe("")
    expect(title?.value).toBe("")
    expect(queryStateMock.dependencies.at(-1)).toEqual([1])
  })
})
