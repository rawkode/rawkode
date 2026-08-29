/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[],
  twoArgumentCalls: 0
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./model-availability.js", () => ({
  isModelUnavailable: () => false,
  setModelUnavailable: vi.fn(),
  subscribeModelAvailability: () => () => undefined
}))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    if (dependencies.length === 1) return { status: "success" as const, value: { chats: [chat] } }
    if (dependencies.length === 3) return { status: "success" as const, value: [legacyFork] }
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

const noteForkActionButton = (
  host: HTMLElement,
  kind: "accept" | "revert"
): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>(".chat-note-forks .chat-pending-actions button")]
    .find((button) => button.textContent === (kind === "accept" ? "Accept" : "Revert"))

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
  runtimeMock.runFork.mockReset()
  queryStateMock.dependencies = []
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

describe("ChatPanel legacy fork decision failure privacy", () => {
  it("starts only one legacy fork decision for the same node until it settles", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const host = await mount()

    await act(async () => {
      noteForkActionButton(host, "accept")?.click()
      noteForkActionButton(host, "revert")?.click()
      await flush()
    })

    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    const actionButtons = [...host.querySelectorAll<HTMLButtonElement>(".chat-note-forks .chat-pending-actions button")]
    expect(actionButtons.map((button) => button.textContent)).toEqual(["Accepting…", "Revert"])
    expect(actionButtons.every((button) => button.disabled)).toBe(true)

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: "private legacy decision detail" })))
      await flush()
    })

    expect(noteForkActionButton(host, "accept")?.disabled).toBe(false)
    expect(noteForkActionButton(host, "revert")?.disabled).toBe(false)

    await act(async () => {
      noteForkActionButton(host, "revert")?.click()
      await flush()
    })

    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("private legacy decision detail"))
  })

  for (const [kind, pastTense] of [["accept", "accepted"], ["revert", "reverted"]] as const) {
    it(`keeps an uncertain ${kind} generic and refreshes only after a confirmed result`, async () => {
      const observers: Array<(exit: unknown) => void> = []
      runtimeMock.runFork.mockImplementation(() => ({
        addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
      }))
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
      const privateDetail = `private legacy ${kind} provider detail`
      const host = await mount()

      expect(host.querySelector(".chat-note-fork-preview")?.textContent).toBe(legacyFork.text)
      await act(async () => {
        noteForkActionButton(host, kind)?.click()
        await flush()
      })
      expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

      await act(async () => {
        observers[0]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
        await flush()
      })

      const alert = host.querySelector<HTMLElement>(".chat-note-fork-action-error")
      expect(alert?.getAttribute("role")).toBe("alert")
      expect(alert?.textContent).toContain(`We couldn’t confirm that this note edit was ${pastTense}.`)
      expect(alert?.textContent).toContain("Review the pending note edit before taking another action.")
      expect(host.textContent).not.toContain(privateDetail)
      expect(host.querySelector(".chat-note-fork-preview")?.textContent).toBe(legacyFork.text)
      expect(noteForkActionButton(host, kind)?.disabled).toBe(false)
      expect(queryStateMock.dependencies.some((dependencies) => dependencies.includes(1))).toBe(false)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(privateDetail))

      await act(async () => {
        noteForkActionButton(host, kind)?.click()
        await flush()
      })
      expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)

      await act(async () => {
        observers[1]?.(Exit.succeed(undefined))
        await flush()
      })

      expect(host.querySelector(".chat-note-fork-action-error")).toBeNull()
      expect(queryStateMock.dependencies.some((dependencies) => dependencies.includes(1))).toBe(true)
    })
  }
})
