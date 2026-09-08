/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.dependencies.length % 2 === 1
      ? { status: "success" as const, value: { collaborators: [] } }
      : { status: "success" as const, value: { shareLinks: [] } }
  }
}))

import { SharePanel } from "./SharePanel.js"

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
    root.render(<SharePanel />)
    await flush()
  })
  return host
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const setSelect = (select: HTMLSelectElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
  setter?.call(select, value)
  select.dispatchEvent(new Event("change", { bubbles: true }))
}

const addForm = (host: HTMLDivElement): HTMLFormElement | undefined =>
  host.querySelector<HTMLFormElement>(".share-section .share-form") ?? undefined

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

describe("SharePanel add-collaborator failure custody", () => {
  it("starts only one collaborator mutation until the current submission settles", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const host = await mount()
    const email = host.querySelector<HTMLInputElement>("[aria-label='Collaborator email']")
    const role = addForm(host)?.querySelector<HTMLSelectElement>("select")

    await act(async () => {
      setInput(email!, "Alex@example.com")
      setSelect(role!, "build")
      await flush()
    })

    await act(async () => {
      addForm(host)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      addForm(host)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(email?.disabled).toBe(true)
    expect(addForm(host)?.querySelector<HTMLButtonElement>("button")?.textContent).toBe("Adding…")

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: "private collaborator mutation detail" })))
      await flush()
    })

    expect(email?.value).toBe("Alex@example.com")
    expect(role?.value).toBe("build")
    expect(addForm(host)?.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false)

    await act(async () => {
      addForm(host)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("private collaborator mutation detail"))
  })

  it("keeps a failed collaborator draft actionable without exposing the mutation cause", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private collaborator provider detail"
    const host = await mount()
    const email = host.querySelector<HTMLInputElement>("[aria-label='Collaborator email']")
    const role = addForm(host)?.querySelector<HTMLSelectElement>("select")

    await act(async () => {
      setInput(email!, "Alex@example.com")
      setSelect(role!, "build")
      await flush()
    })

    await act(async () => {
      addForm(host)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

    await act(async () => {
      observe?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = addForm(host)?.parentElement?.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that this collaborator was added.")
    expect(alert?.textContent).toContain("The email is still here.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(email?.value).toBe("Alex@example.com")
    expect(role?.value).toBe("build")
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      addForm(host)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)

    await act(async () => {
      observe?.(Exit.succeed(undefined))
      await flush()
    })
    expect(email?.value).toBe("")
    expect(queryStateMock.dependencies.slice(-2)).toEqual([[1], [1]])
  })
})
