/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[],
  forksState: "failure" as "failure" | "loading" | "success",
  twoArgumentCalls: 0
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
    if (dependencies.length === 3) {
      if (queryStateMock.forksState === "loading") return { status: "loading" as const }
      return queryStateMock.forksState === "success"
        ? { status: "success" as const, value: [legacyFork] }
        : { status: "failure" as const, error: new UnexpectedError({ message: privateDetail }) }
    }
    const value = queryStateMock.twoArgumentCalls++ % 2 === 0
      ? { messages }
      : { nodes: [], facts: [], edges: [] }
    return { status: "success" as const, value }
  }
}))

import { ChatPanel } from "./ChatPanel.js"

const chatId = EntityId.make("00000000-0000-4000-8000-000000000001")
const workspaceId = EntityId.make("00000000-0000-4000-8000-000000000002")
const nodeId = EntityId.make("00000000-0000-4000-8000-000000000003")
const chat = {
  id: chatId,
  workspaceId,
  title: "Working session",
  createdAt: "2026-08-28T00:00:00.000Z"
}
const legacyFork = { nodeId, forked: true, text: "Legacy pending note text" }
const privateDetail = "private legacy-fork descriptor detail"
const messages = [
  {
    id: EntityId.make("00000000-0000-4000-8000-000000000004"),
    chatId,
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id: "legacy-edit", name: "editNote", input: {} }],
    sequence: 0
  },
  {
    id: EntityId.make("00000000-0000-4000-8000-000000000005"),
    chatId,
    role: "tool" as const,
    content: JSON.stringify({
      toolUseId: "legacy-edit",
      entityIds: [],
      result: JSON.stringify({ nodeId, text: legacyFork.text }),
      isError: false
    }),
    sequence: 1
  }
]

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
  queryStateMock.forksState = "failure"
  queryStateMock.twoArgumentCalls = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ChatPanel legacy fork recovery", () => {
  it("keeps the selected chat usable through a generic fork lookup failure and restores the card after retry", async () => {
    const host = await mount()

    const alert = host.querySelector<HTMLElement>(".chat-note-forks-load-state")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Pending note edits couldn’t be checked.")
    expect(alert?.textContent).toContain("Nothing has been changed. Retry to review them.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.querySelector(".chat-note-fork-preview")).toBeNull()
    expect(host.querySelector(".chat-note-forks .chat-pending-actions")).toBeNull()
    expect(host.querySelector(".chat-list-item")?.textContent).toBe("Working session")
    expect(host.querySelector<HTMLInputElement>("[aria-label='Message the agent']")?.disabled).toBe(false)
    const listRefreshes = queryStateMock.dependencies.filter((dependencies) => dependencies.length === 1)
    expect(listRefreshes).toEqual(expect.arrayContaining([[0]]))
    expect(listRefreshes.every((dependencies) => dependencies[0] === 0)).toBe(true)

    queryStateMock.forksState = "success"
    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })

    expect(host.querySelector(".chat-note-forks-load-state")).toBeNull()
    expect(host.querySelector(".chat-note-fork-preview")?.textContent).toBe(legacyFork.text)
    expect(host.querySelector(".chat-note-forks .chat-pending-actions")).not.toBeNull()
    expect(queryStateMock.dependencies).toContainEqual([chatId, 1, nodeId])
    const finalListRefreshes = queryStateMock.dependencies.filter((dependencies) => dependencies.length === 1)
    expect(finalListRefreshes.every((dependencies) => dependencies[0] === 0)).toBe(true)
  })

  it("announces a pending note-fork check without exposing decision controls", async () => {
    queryStateMock.forksState = "loading"
    const host = await mount()

    const loadingStatus = host.querySelector<HTMLElement>(".chat-note-forks [role=status]")
    expect(loadingStatus?.textContent).toContain("Checking pending note edits…")
    expect(loadingStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadingStatus?.getAttribute("aria-atomic")).toBe("true")
    expect(host.querySelector(".chat-note-fork-preview")).toBeNull()
    expect(host.querySelector(".chat-note-forks .chat-pending-actions")).toBeNull()
    expect(host.querySelector<HTMLInputElement>("[aria-label='Message the agent']")?.disabled).toBe(false)
  })
})
