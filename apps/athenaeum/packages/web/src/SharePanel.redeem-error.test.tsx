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

describe("SharePanel share-key redemption custody", () => {
  it("starts only one key redemption until the current submission settles", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const shareKey = "same-share-key"
    const host = await mount()
    const input = host.querySelector<HTMLInputElement>("[aria-label='Share key to redeem']")
    const form = host.querySelector<HTMLFormElement>(".share-redeem-form")

    await act(async () => {
      setInput(input!, shareKey)
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(input?.disabled).toBe(true)
    expect(form?.querySelector<HTMLButtonElement>("button")?.textContent).toBe("Redeeming…")

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: "private redemption mutation detail" })))
      await flush()
    })

    expect(input?.value).toBe(shareKey)
    expect(form?.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false)

    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })

    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("private redemption mutation detail"))
  })

  it("retains an uncertain redemption without exposing its cause or refreshing sharing details", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private redeem provider detail"
    const shareKey = "sensitive-share-key"
    const host = await mount()
    const input = host.querySelector<HTMLInputElement>("[aria-label='Share key to redeem']")
    const form = host.querySelector<HTMLFormElement>(".share-redeem-form")

    await act(async () => {
      setInput(input!, shareKey)
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

    await act(async () => {
      observe?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = form?.parentElement?.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm whether this share key was redeemed.")
    expect(alert?.textContent).toContain("The key is still here. Review access before taking another action.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.textContent).not.toContain(shareKey)
    expect(input?.value).toBe(shareKey)
    expect(input?.disabled).toBe(false)
    expect(form?.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false)
    expect(queryStateMock.dependencies).toEqual(expect.arrayContaining([[0], [0]]))
    expect(queryStateMock.dependencies.every((dependencies) => dependencies[0] === 0)).toBe(true)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(privateDetail))
  })

  it("clears the key and refreshes sharing details only after a confirmed redemption", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const host = await mount()
    const input = host.querySelector<HTMLInputElement>("[aria-label='Share key to redeem']")
    const form = host.querySelector<HTMLFormElement>(".share-redeem-form")

    await act(async () => {
      setInput(input!, "confirmed-share-key")
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await flush()
      observe?.(Exit.succeed(undefined))
      await flush()
    })

    expect(input?.value).toBe("")
    expect(host.querySelector(".share-redeem-success")?.textContent).toContain("Redeemed")
    expect(form?.parentElement?.querySelector("[role='alert']")).toBeNull()
    expect(queryStateMock.dependencies.slice(-2)).toEqual([[1], [1]])
  })
})
