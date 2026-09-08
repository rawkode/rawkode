/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[]
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
    return { status: "success" as const, value: review }
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
const pendingNode = {
  id: EntityId.make("00000000-0000-4000-8000-000000000003"),
  title: "Project north",
  pending: { sequence: 13 }
}
const review = {
  chat,
  messages: [],
  items: [
    { lane: "structured" as const, kind: "node" as const, sequence: pendingNode.pending.sequence, label: 'Created "Project north"', stamped: true, targetAvailable: true, actionable: true },
    { lane: "legacy-fork" as const, kind: "unresolved" as const, sequence: 0, label: "This note edit’s target is unavailable.", stamped: true, targetAvailable: false, actionable: false }
  ],
  witness: "a".repeat(64),
  noteForkWitness: "b".repeat(64),
  structuredForks: { total: 1, shown: 1, truncated: false, unavailable: 0 },
  legacyForks: { total: 1, shown: 0, truncated: false, unavailable: 1 }
}

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const pendingActionButton = (
  host: HTMLElement,
  kind: "accept" | "revert"
): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>(".chat-pending:not(.chat-note-forks) .chat-pending-actions button")]
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
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ChatPanel pending decision failure privacy", () => {
  it("starts only one structured pending decision until the current decision settles", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const host = await mount()

    await act(async () => {
      pendingActionButton(host, "accept")?.click()
      pendingActionButton(host, "revert")?.click()
      await flush()
    })

    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    const pendingButtons = [...host.querySelectorAll<HTMLButtonElement>(".chat-pending:not(.chat-note-forks) .chat-pending-actions button")]
    expect(pendingButtons.map((button) => button.textContent)).toEqual(["Accepting…", "Revert"])
    expect(pendingButtons.every((button) => button.disabled)).toBe(true)
    expect(host.textContent).toContain("Some pending note edits couldn’t be safely shown.")

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: "private pending decision detail" })))
      await flush()
    })

    expect(pendingActionButton(host, "accept")?.disabled).toBe(false)
    expect(pendingActionButton(host, "revert")?.disabled).toBe(false)

    await act(async () => {
      pendingActionButton(host, "revert")?.click()
      await flush()
    })

    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
  })

  for (const [kind, pastTense] of [["accept", "accepted"], ["revert", "reverted"]] as const) {
    it(`keeps an uncertain ${kind} generic and refreshes only after a confirmed result`, async () => {
      const observers: Array<(exit: unknown) => void> = []
      runtimeMock.runFork.mockImplementation(() => ({
        addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
      }))
      const privateDetail = "private pending " + kind + " provider detail"
      const host = await mount()

      await act(async () => {
        pendingActionButton(host, kind)?.click()
        await flush()
      })
      expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

      await act(async () => {
        observers[0]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
        await flush()
      })

      const alert = host.querySelector<HTMLElement>(".chat-pending-action-error")
      expect(alert?.getAttribute("role")).toBe("alert")
      expect(alert?.textContent).toContain(`We couldn’t confirm that these changes were ${pastTense}.`)
      expect(alert?.textContent).toContain("Review the pending changes before taking another action.")
      expect(host.textContent).not.toContain(privateDetail)
      expect(host.querySelector(".chat-pending-list")?.textContent).toContain("Project north")
      expect(pendingActionButton(host, kind)?.disabled).toBe(false)
      expect(queryStateMock.dependencies.some((dependencies) => dependencies.includes(1))).toBe(false)

      await act(async () => {
        pendingActionButton(host, kind)?.click()
        await flush()
      })
      expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)

      await act(async () => {
        observers[1]?.(Exit.succeed(undefined))
        await flush()
      })

      expect(host.querySelector(".chat-pending-action-error")).toBeNull()
      expect(queryStateMock.dependencies.some((dependencies) => dependencies.includes(1))).toBe(true)
    })
  }
})
