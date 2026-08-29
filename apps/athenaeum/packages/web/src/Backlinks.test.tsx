/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EntityId, ValidationError, WorkspaceNotFound } from "@athenaeum/domain"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({
  current: undefined as unknown,
  states: new Map<string, unknown>(),
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.states.get(`${String(dependencies[0])}:${String(dependencies[1])}`) ?? queryStateMock.current
  }
}))
// Keep navigation inert while allowing continuity assertions to see the source title without
// introducing a second React instance into the isolated Vitest overlay.
vi.mock("react-router", () => ({ Link: ({ children }: { readonly children: string }) => children }))

import { Backlinks } from "./Backlinks.js"

const nodeId = EntityId.make("00000000-0000-4000-8000-000000000001")
const otherNodeId = EntityId.make("00000000-0000-4000-8000-000000000002")
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

const setDisclosureOpen = async (details: HTMLDetailsElement, open: boolean): Promise<void> => {
  await act(async () => {
    details.open = open
    details.dispatchEvent(new Event("toggle", { bubbles: true }))
    await flush()
  })
}

const queryKey = (targetNodeId: EntityId, refreshKey: number): string => `${targetNodeId}:${refreshKey}`

const render = async (root: Root, targetNodeId = nodeId): Promise<void> => {
  await act(async () => {
    root.render(<Backlinks nodeId={targetNodeId} />)
    await flush()
  })
}

const mount = async (state: unknown = { status: "success", value: [] }, targetNodeId = nodeId) => {
  queryStateMock.current = state
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await render(root, targetNodeId)
  return { root, host }
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queryStateMock.states.clear()
  queryStateMock.dependencies = []
})

afterEach(() => {
  vi.restoreAllMocks()
  runtimeMock.runFork.mockReset()
  queryStateMock.current = undefined
  queryStateMock.states.clear()
  queryStateMock.dependencies = []
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("Backlinks creation disclosure", () => {
  it("uses one actionable load failure without hiding the linked-note form", async () => {
    const { root, host } = await mount({
      status: "failure",
      error: new WorkspaceNotFound({ workspaceId: "00000000-0000-4000-8000-000000000002" })
    })

    expect(host.querySelectorAll(".backlinks-load-state")).toHaveLength(1)
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Backlinks could not be loaded.")
    expect(host.textContent).not.toContain("This workspace doesn't exist")
    expect(host.textContent).not.toContain("No backlinks yet.")
    expect(queryStateMock.dependencies).toEqual([[nodeId, 0]])

    const disclosure = host.querySelector<HTMLDetailsElement>(".backlinks-create-disclosure")
    await setDisclosureOpen(disclosure!, true)
    const input = host.querySelector<HTMLInputElement>("[aria-label='New node title']")
    expect(input).not.toBeNull()
    await act(async () => {
      setInput(input!, "Follow up with Alex")
      await flush()
    })
    const dependencyCountBeforeRetry = queryStateMock.dependencies.length

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".backlinks-load-state button")?.click()
      host.querySelector<HTMLButtonElement>(".backlinks-load-state button")?.click()
      await flush()
    })
    expect(queryStateMock.dependencies.slice(dependencyCountBeforeRetry)).toEqual([[nodeId, 1]])
    expect(host.querySelector<HTMLButtonElement>(".backlinks-load-state button")?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>(".backlinks-load-state button")?.textContent).toBe("Retrying…")

    queryStateMock.states.set(queryKey(nodeId, 1), { status: "loading" as const })
    await render(root)
    expect(host.querySelector(".backlinks-load-state")).toBeNull()
    expect(disclosure?.open).toBe(true)
    expect(host.querySelector<HTMLInputElement>("[aria-label='New node title']")?.value).toBe("Follow up with Alex")

    queryStateMock.states.set(queryKey(nodeId, 1), queryStateMock.current)
    await render(root)
    const releasedRetry = host.querySelector<HTMLButtonElement>(".backlinks-load-state button")
    expect(releasedRetry?.disabled).toBe(false)
    expect(releasedRetry?.textContent).toBe("Retry")
    const dependencyCountBeforeNextRetry = queryStateMock.dependencies.length

    await act(async () => {
      releasedRetry?.click()
      await flush()
    })
    expect(queryStateMock.dependencies.slice(dependencyCountBeforeNextRetry)).toEqual([[nodeId, 2]])
  })

  it("starts closed and retains an unsubmitted draft across disclosure toggles", async () => {
    const { host } = await mount()
    const disclosure = host.querySelector<HTMLDetailsElement>(".backlinks-create-disclosure")
    expect(disclosure?.open).toBe(false)
    expect(host.querySelector(".backlinks-load-state")).toBeNull()
    expect(host.textContent).toContain("No backlinks yet.")

    await setDisclosureOpen(disclosure!, true)
    const input = host.querySelector<HTMLInputElement>("[aria-label='New node title']")
    expect(input).not.toBeNull()
    await act(async () => {
      setInput(input!, "Follow up with Alex")
      await flush()
    })

    await setDisclosureOpen(disclosure!, false)
    await setDisclosureOpen(disclosure!, true)
    expect(host.querySelector<HTMLInputElement>("[aria-label='New node title']")?.value).toBe("Follow up with Alex")
  })

  it("blocks rapid duplicate submits, then reopens failed work for the same retry", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const randomUUID = vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000010")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000011")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000012")
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private backlink provider detail"
    const { host } = await mount()
    const disclosure = host.querySelector<HTMLDetailsElement>(".backlinks-create-disclosure")
    await setDisclosureOpen(disclosure!, true)
    const input = host.querySelector<HTMLInputElement>("[aria-label='New node title']")

    await act(async () => {
      setInput(input!, "A linked note")
      host.querySelector<HTMLFormElement>(".backlinks-create-form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
      host.querySelector<HTMLFormElement>(".backlinks-create-form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(randomUUID).toHaveBeenCalledTimes(3)
    expect(disclosure?.open).toBe(true)
    expect(input?.disabled).toBe(true)

    await setDisclosureOpen(disclosure!, false)
    expect(disclosure?.open).toBe(true)

    await act(async () => {
      observe?.(Exit.fail(new ValidationError({ message: privateDetail })))
      await flush()
    })
    expect(disclosure?.open).toBe(true)
    expect(host.querySelector<HTMLInputElement>("[aria-label='New node title']")?.value).toBe("A linked note")
    const alert = host.querySelector<HTMLElement>(".backlinks-create-disclosure [role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that this note was linked.")
    expect(alert?.textContent).toContain("Your title is still here.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      host.querySelector<HTMLFormElement>(".backlinks-create-form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
    expect(randomUUID).toHaveBeenCalledTimes(3)

    await act(async () => {
      observe?.(Exit.succeed(undefined))
      await flush()
    })
    expect(disclosure?.open).toBe(false)
    expect(host.querySelector<HTMLInputElement>("[aria-label='New node title']")?.value).toBe("")
  })

  it("retains confirmed backlinks through a create-triggered reload failure and replaces them on success", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000010")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000011")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000012")
    queryStateMock.current = {
      status: "success" as const,
      value: [{
        edgeId: EntityId.make("00000000-0000-4000-8000-000000000020"),
        sourceNodeId: EntityId.make("00000000-0000-4000-8000-000000000021"),
        sourceTitle: "Project review"
      }]
    }

    const { root, host } = await mount(queryStateMock.current)
    expect(host.textContent).toContain("Project review")
    const disclosure = host.querySelector<HTMLDetailsElement>(".backlinks-create-disclosure")
    await setDisclosureOpen(disclosure!, true)
    const input = host.querySelector<HTMLInputElement>("[aria-label='New node title']")

    await act(async () => {
      setInput(input!, "Follow up")
      host.querySelector<HTMLFormElement>(".backlinks-create-form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
      await flush()
    })
    queryStateMock.states.set(queryKey(nodeId, 1), { status: "loading" as const })
    await act(async () => {
      observe?.(Exit.succeed(undefined))
      await flush()
    })

    expect(host.textContent).toContain("Refreshing backlinks…")
    const refreshStatus = host.querySelector('[role="status"]')
    expect(refreshStatus?.textContent).toBe("Refreshing backlinks…")
    expect(refreshStatus?.getAttribute("aria-live")).toBe("polite")
    expect(refreshStatus?.getAttribute("aria-atomic")).toBe("true")
    expect(host.textContent).toContain("Project review")
    expect(host.textContent).not.toContain("No backlinks yet.")

    const privateDetail = "private backlink reload detail"
    queryStateMock.states.set(queryKey(nodeId, 1), {
      status: "failure" as const,
      error: new ValidationError({ message: privateDetail })
    })
    await render(root)

    expect(host.querySelector(".backlinks-load-state")?.textContent).toContain("Backlinks could not be refreshed.")
    expect(host.textContent).toContain("Project review")
    expect(host.textContent).not.toContain(privateDetail)

    queryStateMock.states.set(queryKey(nodeId, 1), { status: "success" as const, value: [] })
    await render(root)

    expect(host.querySelector(".backlinks-load-state")).toBeNull()
    expect(host.textContent).toContain("No backlinks yet.")
    expect(host.textContent).not.toContain("Project review")
  })

  it("does not expose a prior node's backlinks while another node is loading", async () => {
    const { root, host } = await mount({
      status: "success" as const,
      value: [{
        edgeId: EntityId.make("00000000-0000-4000-8000-000000000030"),
        sourceNodeId: EntityId.make("00000000-0000-4000-8000-000000000031"),
        sourceTitle: "Private source"
      }]
    })
    expect(host.textContent).toContain("Private source")

    await render(root, otherNodeId)

    expect(host.textContent).toContain("Loading…")
    const loadStatus = host.querySelector('[role="status"]')
    expect(loadStatus?.textContent).toBe("Loading…")
    expect(loadStatus?.getAttribute("aria-live")).toBe("polite")
    expect(loadStatus?.getAttribute("aria-atomic")).toBe("true")
    expect(host.textContent).not.toContain("Private source")
    expect(host.textContent).not.toContain("No backlinks yet.")
  })
})
