/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const bindingStorageMock = vi.hoisted(() => ({
  loadCalendarBindingId: vi.fn(),
  clearCalendarBindingId: vi.fn()
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./calendar-binding-storage.js", () => ({
  CALENDAR_BINDING_CHANGED_EVENT: "calendar-binding-changed",
  loadCalendarBindingId: bindingStorageMock.loadCalendarBindingId,
  clearCalendarBindingId: bindingStorageMock.clearCalendarBindingId
}))

import { CalendarPanel } from "./CalendarPanel.js"

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
    root.render(<CalendarPanel />)
    await flush()
  })
  return host
}

const connectButton = (host: HTMLDivElement): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Connect Google Calendar"
  )

const disconnectButton = (host: HTMLDivElement): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Disconnect")

const calendarBindingId = EntityId.make("00000000-0000-4000-8000-000000000005")

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  bindingStorageMock.loadCalendarBindingId.mockReset()
  bindingStorageMock.loadCalendarBindingId.mockReturnValue(undefined)
  bindingStorageMock.clearCalendarBindingId.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("CalendarPanel connection custody", () => {
  it("keeps an unexpected connection failure generic, logged, and retryable", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private calendar gatekeeper endpoint"
    const host = await mount()

    await act(async () => {
      connectButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

    await act(async () => {
      observe?.(Exit.succeed(Exit.fail(new UnexpectedError({ message: privateDetail }))))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>(".calendar-connect-unavailable")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("Calendar connection couldn’t be started.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(consoleError).toHaveBeenCalled()
    expect(connectButton(host)?.disabled).toBe(false)

    await act(async () => {
      connectButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
  })

  it("does not expose a non-domain connection failure", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private upstream exchange detail"
    const host = await mount()

    await act(async () => {
      connectButton(host)?.click()
      observe?.(Exit.succeed(Exit.fail(new Error(privateDetail))))
      await flush()
    })

    expect(host.querySelector(".calendar-connect-unavailable")?.textContent).toContain(
      "Check the calendar integration, then try again."
    )
    expect(host.textContent).not.toContain(privateDetail)
  })

  it("keeps the successful authorization link unchanged", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=opaque-state"
    const host = await mount()

    await act(async () => {
      connectButton(host)?.click()
      observe?.(Exit.succeed(Exit.succeed({ authorizationUrl })))
      await flush()
    })

    const link = host.querySelector<HTMLAnchorElement>(".calendar-redirect-link")
    expect(link?.href).toBe(authorizationUrl)
    expect(link?.textContent).toContain("Continue to Google")
    expect(host.querySelector(".calendar-connect-unavailable")).toBeNull()
  })

  it("keeps an uncertain disconnect generic and retains the local binding until it is confirmed", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    bindingStorageMock.loadCalendarBindingId.mockReturnValue(calendarBindingId)
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private calendar disconnect provider detail"
    const host = await mount()

    await act(async () => {
      disconnectButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

    await act(async () => {
      observe?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>(".calendar-disconnect-unavailable")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("We couldn’t confirm that your calendar was disconnected.")
    expect(alert?.textContent).toContain("It may still be connected.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(host.textContent).toContain("Google Calendar connected")
    expect(bindingStorageMock.clearCalendarBindingId).not.toHaveBeenCalled()
    expect(disconnectButton(host)?.disabled).toBe(false)
    expect(consoleError).toHaveBeenCalled()
  })

  it("clears the local calendar binding only after a confirmed disconnect", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    bindingStorageMock.loadCalendarBindingId.mockReturnValue(calendarBindingId)
    const host = await mount()

    await act(async () => {
      disconnectButton(host)?.click()
      await flush()
      observe?.(Exit.succeed(undefined))
      await flush()
    })

    expect(bindingStorageMock.clearCalendarBindingId).toHaveBeenCalledTimes(1)
    expect(host.querySelector(".calendar-connected")).toBeNull()
    expect(connectButton(host)).toBeDefined()
    expect(host.querySelector(".calendar-disconnect-unavailable")).toBeNull()
  })
})
