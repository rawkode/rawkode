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

const shareLinkSection = (host: HTMLDivElement): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>(".share-section")].find(
    (section) => section.querySelector("h3")?.textContent === "Share link"
  )

const createShareLinkButton = (section: HTMLElement | undefined): HTMLButtonElement | undefined =>
  section?.querySelector<HTMLButtonElement>("button[type='button']") ?? undefined

const setSelect = (select: HTMLSelectElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
  setter?.call(select, value)
  select.dispatchEvent(new Event("change", { bubbles: true }))
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

describe("SharePanel share-link failure custody", () => {
  it("keeps a failed mint generic and withholds any key until a confirmed success", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private share-link provider detail"
    const expectedKey = "one-time-share-key"
    const host = await mount()
    const section = shareLinkSection(host)
    const role = section?.querySelector<HTMLSelectElement>("select")

    await act(async () => {
      setSelect(role!, "build")
      createShareLinkButton(section)?.click()
      createShareLinkButton(section)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(createShareLinkButton(section)?.disabled).toBe(true)

    await act(async () => {
      observe?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = section?.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that a share link was created.")
    expect(alert?.textContent).toContain("Review the active links before creating another.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.querySelector<HTMLInputElement>("#share-key")).toBeNull()
    expect(role?.value).toBe("build")
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      createShareLinkButton(section)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)

    await act(async () => {
      observe?.(Exit.succeed({ key: expectedKey }))
      await flush()
    })
    expect(host.querySelector<HTMLInputElement>("#share-key")?.value).toBe(expectedKey)
    expect(section?.querySelector("[role='alert']")).toBeNull()
    expect(queryStateMock.dependencies.slice(-2)).toEqual([[1], [1]])
  })
})
