/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const bindingStorageMock = vi.hoisted(() => ({ saveCalendarBindingId: vi.fn() }))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./calendar-binding-storage.js", () => bindingStorageMock)

import { CalendarOAuthCallback } from "./CalendarOAuthCallback.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const setCallbackLocation = (search: string): void => {
  window.history.replaceState(null, "", "/oauth/google-calendar/callback" + search)
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => {
    root.render(<CalendarOAuthCallback />)
    await flush()
  })
  return host
}

const expectBackOnlyRecovery = (host: HTMLDivElement): void => {
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.textContent).toContain("Back to Athenaeum")
  expect(buttons.some((button) => button.textContent === "Retry")).toBe(false)
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  bindingStorageMock.saveCalendarBindingId.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  window.history.replaceState(null, "", "/")
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("CalendarOAuthCallback failures", () => {
  it("renders a provider cancellation without echoing OAuth query values or starting the callback RPC", async () => {
    setCallbackLocation("?error=access_denied&error_description=private-provider-detail")

    const host = await mount()
    const alert = host.querySelector<HTMLElement>("[role='alert']")

    expect(alert?.textContent).toContain("Calendar connection was cancelled.")
    expect(host.textContent).not.toContain("access_denied")
    expect(host.textContent).not.toContain("private-provider-detail")
    expect(runtimeMock.runFork).not.toHaveBeenCalled()
    expect(bindingStorageMock.saveCalendarBindingId).not.toHaveBeenCalled()
    expectBackOnlyRecovery(host)
  })

  it("treats an incomplete callback link as a safe return-to-app state", async () => {
    setCallbackLocation("?code=private-single-use-code")

    const host = await mount()
    const alert = host.querySelector<HTMLElement>("[role='alert']")

    expect(alert?.textContent).toContain("This calendar connection link is incomplete.")
    expect(host.textContent).not.toContain("private-single-use-code")
    expect(host.textContent).not.toContain("?state=")
    expect(runtimeMock.runFork).not.toHaveBeenCalled()
    expect(bindingStorageMock.saveCalendarBindingId).not.toHaveBeenCalled()
    expectBackOnlyRecovery(host)
  })

  it("keeps an unexpected exchange failure generic and never writes a binding", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    setCallbackLocation("?code=single-use-code&state=opaque-state")

    const host = await mount()
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

    await act(async () => {
      observe?.(Exit.succeed(Exit.fail(new UnexpectedError({ message: "private exchange cause" }))))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("Calendar connection couldn’t be completed.")
    expect(host.textContent).not.toContain("private exchange cause")
    expect(host.textContent).not.toContain("single-use-code")
    expect(bindingStorageMock.saveCalendarBindingId).not.toHaveBeenCalled()
    expectBackOnlyRecovery(host)
  })

  it("persists a successful callback binding unchanged", async () => {
    const bindingId = EntityId.make("00000000-0000-4000-8000-000000000009")
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    setCallbackLocation("?code=single-use-code&state=opaque-state")

    const host = await mount()
    await act(async () => {
      observe?.(Exit.succeed(Exit.succeed({ binding: { id: bindingId } })))
      await flush()
    })

    expect(host.textContent).toContain("Google Calendar is connected.")
    expect(bindingStorageMock.saveCalendarBindingId).toHaveBeenCalledWith(expect.any(String), bindingId)
  })
})
