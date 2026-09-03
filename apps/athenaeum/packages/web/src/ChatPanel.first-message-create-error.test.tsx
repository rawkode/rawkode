/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({ dependencies: [] as ReadonlyArray<unknown>[] }))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./model-availability.js", () => ({
  isModelUnavailable: () => false,
  setModelUnavailable: vi.fn(),
  subscribeModelAvailability: () => () => undefined
}))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    if (dependencies.length === 1) return { status: "success" as const, value: { chats: [] } }
    if (dependencies.length === 3) return { status: "success" as const, value: [] }
    return { status: "success" as const, value: { messages: [], nodes: [], facts: [], edges: [] } }
  }
}))

import { ChatPanel } from "./ChatPanel.js"

const createdChat = {
  id: EntityId.make("00000000-0000-4000-8000-000000000001"),
  workspaceId: EntityId.make("00000000-0000-4000-8000-000000000002"),
  title: "Move forward",
  createdAt: "2026-08-28T00:00:00.000Z"
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

const setTextArea = (input: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  queryStateMock.dependencies = []
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ChatPanel first-message chat creation failure privacy", () => {
  it("keeps an uncertain create generic and preserves the first message until a confirmed create and send", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private first-chat provider detail"
    const firstMessage = "Move this work forward"
    const host = await mount()
    const input = host.querySelector<HTMLTextAreaElement>("[aria-label='First message']")
    const form = host.querySelector<HTMLFormElement>(".chat-first-message-form")

    await act(async () => {
      setTextArea(input!, firstMessage)
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(input?.disabled).toBe(true)

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>(".chat-start-error[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that a chat was started.")
    expect(alert?.textContent).toContain("Your message is still here.")
    expect(alert?.textContent).toContain("Review your chats before taking another action.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(input?.value).toBe(firstMessage)
    expect(input?.disabled).toBe(false)
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(queryStateMock.dependencies.filter((dependencies) => dependencies.length === 1).every(
      (dependencies) => dependencies[0] === 0
    )).toBe(true)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)

    await act(async () => {
      observers[1]?.(Exit.succeed({ chat: createdChat }))
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(3)

    await act(async () => {
      observers[2]?.(Exit.succeed({ messages: [], changesSequences: [] }))
      await flush()
    })

    expect(host.querySelector(".chat-start-error")).toBeNull()
    expect(host.querySelector("[aria-label='First message']")).toBeNull()
    expect(host.querySelector(".chat-active")).not.toBeNull()
    expect(queryStateMock.dependencies.some(
      (dependencies) => dependencies.length === 1 && dependencies[0] === 1
    )).toBe(true)
  })
})
