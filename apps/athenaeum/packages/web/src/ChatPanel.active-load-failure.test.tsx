/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[],
  twoArgumentCalls: 0,
  chatAvailable: false,
  chats: [] as unknown[]
}))

vi.mock("./model-availability.js", () => ({
  isModelUnavailable: () => false,
  setModelUnavailable: vi.fn(),
  subscribeModelAvailability: () => () => undefined
}))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    if (dependencies.length === 1) return { status: "success" as const, value: { chats: queryStateMock.chats } }
    if (dependencies.length === 3) return { status: "success" as const, value: [] }
    const value = queryStateMock.twoArgumentCalls++ % 2 === 0
      ? queryStateMock.chatAvailable
        ? { status: "success" as const, value: { messages: [] } }
        : { status: "failure" as const, error: new UnexpectedError({ message: privateDetail }) }
      : { status: "success" as const, value: { nodes: [], facts: [], edges: [] } }
    return value
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
const secondChatId = EntityId.make("00000000-0000-4000-8000-000000000003")
const secondChat = {
  id: secondChatId,
  workspaceId,
  title: "Next session",
  createdAt: "2026-08-28T01:00:00.000Z"
}
const privateDetail = "private active chat provider detail"

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
  queryStateMock.twoArgumentCalls = 0
  queryStateMock.chatAvailable = false
  queryStateMock.chats = [chat]
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ChatPanel active chat recovery", () => {
  it("marks exactly the selected chat as current and transfers that state when a person switches chats", async () => {
    queryStateMock.chats = [chat, secondChat]
    const host = await mount()
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".chat-list-item")]
    const first = buttons.find((button) => button.textContent === chat.title)
    const second = buttons.find((button) => button.textContent === secondChat.title)

    expect(first?.getAttribute("aria-current")).toBe("true")
    expect(second?.getAttribute("aria-current")).toBeNull()

    await act(async () => {
      second?.click()
      await flush()
    })

    expect(first?.getAttribute("aria-current")).toBeNull()
    expect(second?.getAttribute("aria-current")).toBe("true")
  })

  it("keeps the list and composer available through a generic selected-chat failure", async () => {
    const host = await mount()

    const alert = host.querySelector<HTMLElement>(".chat-active-load-state")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("This chat couldn’t be loaded.")
    expect(alert?.textContent).toContain("Your message composer remains available.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.textContent).not.toContain("No messages yet.")
    expect(host.querySelector(".chat-list-item")?.textContent).toBe("Working session")
    expect(host.querySelector<HTMLInputElement>("[aria-label='Message the agent']")?.disabled).toBe(false)
    expect(host.querySelector(".chat-model-unavailable")).toBeNull()
    const listRefreshes = queryStateMock.dependencies.filter((dependencies) => dependencies.length === 1)
    expect(listRefreshes).toEqual(expect.arrayContaining([[0]]))
    expect(listRefreshes.every((dependencies) => dependencies[0] === 0)).toBe(true)

    queryStateMock.chatAvailable = true
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(host.querySelector(".chat-active-load-state")).toBeNull()
    const finalListRefreshes = queryStateMock.dependencies.filter((dependencies) => dependencies.length === 1)
    expect(finalListRefreshes.every((dependencies) => dependencies[0] === 0)).toBe(true)
    expect(queryStateMock.dependencies).toContainEqual([chatId, 1])
    expect(queryStateMock.dependencies).toContainEqual([chatId, 1, ""])
  })
})
