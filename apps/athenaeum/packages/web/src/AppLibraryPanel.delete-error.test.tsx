/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, UnexpectedError, type App } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: () => ({
    status: "success" as const,
    value: { codeVersion: { code: "export default {}" } }
  })
}))
vi.mock("./AppRunFrame.js", () => ({ AppRunFrame: () => <output data-app-preview /> }))

import { AppDetail } from "./AppLibraryPanel.js"

const appId = EntityId.make("00000000-0000-4000-8000-000000000001")
const app = {
  id: appId,
  title: "Counter",
  icon: "✦",
  serverCodeVersion: 2,
  clientCodeVersion: 4,
  revision: 3,
  acceptedRevision: 3,
  updatedAt: "2026-08-28T12:00:00.000Z"
} as App
const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const originalConfirm = Object.getOwnPropertyDescriptor(window, "confirm")

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const mount = async (onChanged: () => void): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<AppDetail app={app} onChanged={onChanged} />)
    await flush()
  })
  return host
}

const deleteButton = (host: HTMLDivElement): HTMLButtonElement | undefined =>
  host.querySelector<HTMLButtonElement>(".app-library-delete-button") ?? undefined

const setDeleteReason = (host: HTMLDivElement, value: string): void => {
  const input = host.querySelector<HTMLInputElement>("[aria-label='Delete App commit message']")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input?.dispatchEvent(new Event("input", { bubbles: true }))
}

const stubConfirm = () => {
  const confirm = vi.fn(() => true)
  Object.defineProperty(window, "confirm", { configurable: true, value: confirm })
  return confirm
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalConfirm === undefined) Reflect.deleteProperty(window, "confirm")
  else Object.defineProperty(window, "confirm", originalConfirm)
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AppDetail deletion custody", () => {
  it("keeps an uncertain deletion generic and leaves the existing detail available", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const confirm = stubConfirm()
    const onChanged = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private app deletion provider detail"
    const host = await mount(onChanged)

    await act(async () => {
      setDeleteReason(host, "Remove the obsolete counter app.")
      deleteButton(host)?.click()
      deleteButton(host)?.click()
      await flush()
    })
    expect(confirm).toHaveBeenCalledWith('Delete "Counter"? This cannot be undone.')
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(deleteButton(host)?.disabled).toBe(true)

    await act(async () => {
      observe?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that this app was deleted.")
    expect(alert?.textContent).toContain("It may still be available.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.querySelector("h3")?.textContent).toBe("Counter")
    expect(host.querySelector("[data-app-preview]")).not.toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    expect(deleteButton(host)?.disabled).toBe(false)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      deleteButton(host)?.click()
      await flush()
    })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
  })

  it("notifies the owner only after a confirmed deletion", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    stubConfirm()
    const onChanged = vi.fn()
    const host = await mount(onChanged)

    await act(async () => {
      setDeleteReason(host, "Remove the obsolete counter app.")
      deleteButton(host)?.click()
      await flush()
      observe?.(Exit.succeed(undefined))
      await flush()
    })

    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(host.querySelector("[role='alert']")).toBeNull()
  })
})
