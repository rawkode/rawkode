/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[],
  pendingState: "failure" as "failure" | "loading" | "success",
  retryLoadingSeen: false
}))

vi.mock("./model-availability.js", () => ({
  isModelUnavailable: () => false,
  setModelUnavailable: vi.fn(),
  subscribeModelAvailability: () => () => undefined
}))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    if (dependencies.length === 1) return { status: "success" as const, value: { chats: [chat] } }
    if (dependencies.length === 3) return { status: "success" as const, value: [] }
    if (dependencies[1] === 1 && !queryStateMock.retryLoadingSeen) {
      queryStateMock.retryLoadingSeen = true
      return { status: "loading" as const }
    }
    if (queryStateMock.pendingState === "loading") return { status: "loading" as const }
    return queryStateMock.pendingState === "success"
      ? { status: "success" as const, value: review }
      : { status: "failure" as const, error: new UnexpectedError({ message: privateDetail }) }
  }
}))

import { ChatPanel } from "./ChatPanel.js"

const chatId = EntityId.make("00000000-0000-4000-8000-000000000001")
const workspaceId = EntityId.make("00000000-0000-4000-8000-000000000002")
const chat = {
  id: chatId,
  workspaceId,
  title: "Working session",
  createdAt: "2026-08-28T00:00:00.000Z"
}
const privateDetail = "private pending-changes provider detail"
const review = {
  chat,
  messages: [],
  items: [],
  witness: "a".repeat(64),
  noteForkWitness: "b".repeat(64),
  structuredForks: { total: 0, shown: 0, truncated: false, unavailable: 0 },
  legacyForks: { total: 0, shown: 0, truncated: false, unavailable: 0 }
}

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
    root.render(<ChatPanel />)
    await flush()
  })
  return host
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.dependencies = []
  queryStateMock.pendingState = "failure"
  queryStateMock.retryLoadingSeen = false
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ChatPanel pending changes recovery", () => {
  it("keeps the selected chat usable through a generic failure and retries only its refresh tuple", async () => {
    const host = await mount()

    const alert = host.querySelector<HTMLElement>(".chat-pending-load-state")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Pending changes couldn’t be loaded.")
    expect(alert?.textContent).toContain("Nothing has been changed. Retry to review them.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.querySelector(".chat-pending-list")).toBeNull()
    expect(host.querySelector(".chat-pending-actions")).toBeNull()
    expect(host.querySelector(".chat-list-item")?.textContent).toBe("Working session")
    expect(host.querySelector<HTMLInputElement>("[aria-label='Message the agent']")?.disabled).toBe(false)
    const listRefreshes = queryStateMock.dependencies.filter((dependencies) => dependencies.length === 1)
    expect(listRefreshes).toEqual(expect.arrayContaining([[0]]))
    expect(listRefreshes.every((dependencies) => dependencies[0] === 0)).toBe(true)

    queryStateMock.pendingState = "success"
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    await act(async () => {
      roots[0]?.root.render(<ChatPanel />)
      await flush()
    })

    expect(host.querySelector(".chat-pending-load-state")).toBeNull()
    expect(queryStateMock.dependencies).toContainEqual([chatId, 1])
    const finalListRefreshes = queryStateMock.dependencies.filter((dependencies) => dependencies.length === 1)
    expect(finalListRefreshes.every((dependencies) => dependencies[0] === 0)).toBe(true)
  })

  it("announces a pending-change read in progress without exposing decision controls", async () => {
    queryStateMock.pendingState = "loading"
    const host = await mount()

    const loadingStatus = host.querySelector<HTMLElement>(".chat-pending [role=status]")
    expect(loadingStatus?.textContent).toContain("Loading pending changes…")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector(".chat-pending-list")).toBeNull()
    expect(host.querySelector(".chat-pending-actions")).toBeNull()
    expect(host.querySelector<HTMLInputElement>("[aria-label='Message the agent']")?.disabled).toBe(false)
  })
})
