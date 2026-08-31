/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({ deps: [] as ReadonlyArray<unknown>[] }))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.deps.push([...dependencies])
    return { status: "success" as const, value: { apps: [] } }
  }
}))

import { AppLauncherGrid } from "./AppLauncherGrid.js"

const createdAppId = EntityId.make("00000000-0000-4000-8000-000000000002")
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const mount = async (onEdit: (appId: EntityId) => void): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<AppLauncherGrid onLaunch={vi.fn()} onEdit={onEdit} />)
    await flush()
  })
  return host
}

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const createButton = (host: HTMLDivElement): HTMLButtonElement | undefined =>
  host.querySelector<HTMLButtonElement>(".app-create-form button[type='submit']") ?? undefined

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  queryStateMock.deps = []
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AppLauncherGrid creation custody", () => {
  it("keeps an uncertain creation generic and retains the app form", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const onEdit = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private app creation provider detail"
    const titleValue = "Research Helper"
    const iconValue = "🔎"
    const host = await mount(onEdit)

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".app-tile-new")?.click()
      await flush()
      setInput(host.querySelector<HTMLInputElement>("[aria-label='App title']")!, titleValue)
      setInput(host.querySelector<HTMLInputElement>("[aria-label='App icon']")!, iconValue)
      setInput(host.querySelector<HTMLInputElement>("[aria-label='Create commit message']")!, "Create a research helper.")
      createButton(host)?.click()
      createButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(createButton(host)?.disabled).toBe(true)

    await act(async () => {
      observe?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that this app was created.")
    expect(alert?.textContent).toContain("Its title and icon are still here.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.querySelector<HTMLInputElement>("[aria-label='App title']")?.value).toBe(titleValue)
    expect(host.querySelector<HTMLInputElement>("[aria-label='App icon']")?.value).toBe(iconValue)
    expect(createButton(host)?.disabled).toBe(false)
    expect(onEdit).not.toHaveBeenCalled()
    expect(queryStateMock.deps.every((dependencies) => dependencies[0] === 0)).toBe(true)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      createButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
  })

  it("refreshes and enters the editor only after a confirmed creation", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const onEdit = vi.fn()
    const host = await mount(onEdit)

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".app-tile-new")?.click()
      await flush()
      setInput(host.querySelector<HTMLInputElement>("[aria-label='App title']")!, "Research Helper")
      setInput(host.querySelector<HTMLInputElement>("[aria-label='Create commit message']")!, "Create a research helper.")
      createButton(host)?.click()
      await flush()
      observe?.(Exit.succeed({ app: { id: createdAppId } }))
      await flush()
    })

    expect(onEdit).toHaveBeenCalledWith(createdAppId)
    expect(host.querySelector(".app-create-form")).toBeNull()
    expect(host.querySelector(".app-tile-new")?.textContent).toContain("New App")
    expect(queryStateMock.deps).toEqual([[0], [1]])
  })
})
