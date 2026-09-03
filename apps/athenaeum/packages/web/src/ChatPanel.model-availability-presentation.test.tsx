/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./model-availability.js", () => ({
  isModelUnavailable: () => true,
  setModelUnavailable: vi.fn(),
  subscribeModelAvailability: () => () => undefined
}))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    if (dependencies.length === 1) return { status: "success" as const, value: { chats: [] } }
    return { status: "success" as const, value: [] }
  }
}))

import { ChatPanel } from "./ChatPanel.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
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
  runtimeMock.runFork.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ChatPanel model availability", () => {
  it("keeps provider setup details out of the user-facing availability state", async () => {
    const host = await mount()
    const notice = host.querySelector<HTMLElement>(".chat-model-unavailable")

    expect(notice?.getAttribute("role")).toBe("status")
    expect(notice?.textContent).toContain("Agent replies are unavailable for this workspace.")
    expect(notice?.textContent).toContain("Your message is saved.")
    expect(notice?.textContent).toContain("try again later")
    expect(host.textContent).not.toContain("ANTHROPIC_API_KEY")
    expect(host.textContent).not.toContain("wrangler")
    expect(host.textContent).not.toContain("docs/agent-model-client")
  })
})
