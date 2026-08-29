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
    if (dependencies.length === 1) {
      return { status: "success", value: { chats: [chat] } }
    }
    if (dependencies.length === 3) {
      return { status: "success", value: [] }
    }
    return {
      status: "success",
      value: { messages: [], nodes: [], facts: [], edges: [] }
    }
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
})

afterEach(() => {
  vi.restoreAllMocks()
  runtimeMock.runFork.mockReset()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ChatPanel send failure", () => {
  it("keeps an uncertain active-chat send generic, retained, and unrefreshed", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private active-chat provider detail"

    const host = await mount()
    const input = host.querySelector<HTMLInputElement>("[aria-label='Message the agent']")
    const form = host.querySelector<HTMLFormElement>(".chat-send-form")
    expect(input).not.toBeNull()
    expect(form).not.toBeNull()

    await act(async () => {
      setInput(input!, "Keep this draft")
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(input?.disabled).toBe(true)

    await act(async () => {
      observe?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const error = host.querySelector<HTMLElement>(".chat-send-error")
    expect(error?.getAttribute("role")).toBe("alert")
    expect(error?.textContent).toContain("We couldn’t confirm that your message was sent.")
    expect(error?.textContent).toContain("Your draft is still here. Review the chat before taking another action.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(input?.value).toBe("Keep this draft")
    expect(input?.disabled).toBe(false)
    expect(host.querySelector(".chat-active")).not.toBeNull()
    expect(host.querySelector(".chat-model-unavailable")).toBeNull()
    expect(queryStateMock.dependencies.some((dependencies) => dependencies.includes(1))).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(privateDetail))

    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
  })
})
