/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  byRefreshKey: new Map<number, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./model-availability.js", () => ({
  isModelUnavailable: () => false,
  setModelUnavailable: vi.fn(),
  subscribeModelAvailability: () => () => undefined
}))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.byRefreshKey.get(Number(dependencies[0])) ?? queryStateMock.current
  }
}))

import { ChatPanel } from "./ChatPanel.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const chatRefreshKeys = (): number[] => [
  ...new Set(
    queryStateMock.dependencies
      .map((dependencies) => dependencies[0])
      .filter((value): value is number => typeof value === "number")
  )
]

const render = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<ChatPanel />)
    await flush()
  })
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root)
  return host
}

const rerender = async (host: HTMLDivElement): Promise<void> => {
  const root = roots.find((entry) => entry.host === host)?.root
  if (root === undefined) throw new Error("expected mounted ChatPanel root")
  await render(root)
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.byRefreshKey.clear()
  queryStateMock.dependencies = []
  queryStateMock.current = {
    status: "failure" as const,
    error: new UnexpectedError({ message: "Internal chat list detail" })
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

describe("ChatPanel list recovery", () => {
  it("shows one generic retryable failure while preserving both chat creation paths", async () => {
    const host = await mount()

    const alert = host.querySelector<HTMLElement>(".chat-list-load-state")
    expect(host.querySelectorAll(".chat-list-load-state")).toHaveLength(1)
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Chats couldn’t be loaded.")
    expect(host.textContent).not.toContain("Internal chat list detail")
    expect(host.textContent).not.toContain("No chats yet.")
    expect(host.querySelector<HTMLTextAreaElement>("[aria-label='First message']")).not.toBeNull()
    expect(host.querySelector<HTMLDetailsElement>(".chat-create-disclosure")).not.toBeNull()
    expect(chatRefreshKeys()).toEqual([0])

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(chatRefreshKeys()).toEqual([0, 1])
    const retryingButton = host.querySelector<HTMLButtonElement>(".chat-list-load-state button")
    expect(retryingButton?.disabled).toBe(true)
    expect(retryingButton?.textContent).toBe("Retrying…")

    queryStateMock.byRefreshKey.set(1, { status: "loading" as const })
    await rerender(host)
    const loadingStatus = host.querySelector<HTMLElement>(".chat-list [role=status]")
    expect(loadingStatus?.textContent).toContain("Loading chats…")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")

    queryStateMock.byRefreshKey.set(1, {
      status: "failure" as const,
      error: new UnexpectedError({ message: "Internal chat list detail" })
    })
    await rerender(host)
    const releasedButton = host.querySelector<HTMLButtonElement>(".chat-list-load-state button")
    expect(releasedButton?.disabled).toBe(false)
    expect(releasedButton?.textContent).toBe("Retry")

    await act(async () => {
      releasedButton?.click()
      await flush()
    })
    expect(chatRefreshKeys()).toEqual([0, 1, 2])
  })

  it("keeps a successful empty workspace distinct from a failed list request", async () => {
    queryStateMock.current = {
      status: "success" as const,
      value: { chats: [] }
    }

    const host = await mount()

    expect(host.querySelector(".chat-list-load-state")).toBeNull()
    expect(host.querySelector(".chat-list-empty")?.textContent).toContain("No chats yet.")
    expect(host.querySelector("[role='alert']")).toBeNull()
  })
})
