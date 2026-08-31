/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const queryState = vi.hoisted(() => ({
  value: { status: "success" as const, value: { chats: [] as unknown[] } }
}))

vi.mock("./model-availability.js", () => ({
  isModelUnavailable: () => false,
  setModelUnavailable: vi.fn(),
  subscribeModelAvailability: () => () => undefined
}))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: () => queryState.value
}))

import { ChatPanel } from "./ChatPanel.js"

const roots: Root[] = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ChatPanel confirmed empty catalog", () => {
  it("offers one composer-first path without a competing named-chat or empty-list state", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(<ChatPanel />)
      await Promise.resolve()
    })

    expect(host.querySelector<HTMLTextAreaElement>("[aria-label='First message']")).not.toBeNull()
    expect(host.textContent).toContain("Start with the work")
    expect(host.querySelector(".chat-list-empty")?.parentElement?.hidden).toBe(true)
    expect(host.querySelector<HTMLDetailsElement>(".chat-create-disclosure")?.hidden).toBe(true)
    expect(host.querySelector<HTMLInputElement>("[aria-label='New chat title']")?.closest("details")?.hidden).toBe(true)
  })
})
