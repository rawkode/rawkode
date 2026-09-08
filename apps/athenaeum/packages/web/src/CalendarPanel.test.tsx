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
const catalogQueryMock = vi.hoisted(() => ({
  state: {
    status: "success",
    value: { generation: 1, value: { bindings: [] } }
  } as unknown,
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    catalogQueryMock.dependencies.push([...dependencies])
    return catalogQueryMock.state
  }
}))
vi.mock("./calendar-binding-storage.js", () => ({
  CALENDAR_BINDING_CHANGED_EVENT: "calendar-binding-changed",
  CALENDAR_SYNC_TRIGGERED_EVENT: "calendar-sync-triggered",
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
    .find((button) => button.textContent?.startsWith("Disconnect"))

const calendarBindingId = EntityId.make("00000000-0000-4000-8000-000000000005")
const secondCalendarBindingId = EntityId.make("00000000-0000-4000-8000-000000000006")

const catalogSuccess = (bindings: ReadonlyArray<unknown>, generation = 1) => ({
  status: "success" as const,
  value: { generation, value: { bindings } }
})

const catalogFailure = (generation = 1) => ({
  status: "failure" as const,
  error: { generation, error: new UnexpectedError({ message: "private catalog detail" }) }
})

const serverBinding = (id: EntityId, mode: "selected" | "allVisible" = "selected") => ({
  id,
  workspaceId: "00000000-0000-4000-8000-000000000010",
  gatekeeperKind: "google-calendar",
  mode,
  createdAt: "2026-08-29T09:00:00.000Z"
})

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  bindingStorageMock.loadCalendarBindingId.mockReset()
  bindingStorageMock.loadCalendarBindingId.mockReturnValue(undefined)
  bindingStorageMock.clearCalendarBindingId.mockReset()
  catalogQueryMock.state = catalogSuccess([], 1)
  catalogQueryMock.dependencies = []
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

  it("does not fabricate a launch when the local effect never produced an opaque handle", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    const host = await mount()

    await act(async () => {
      connectButton(host)?.click()
      observe?.(Exit.succeed(Exit.succeed({ fixedLaunchUrl: "https://athenaeum.example/oauth/google-calendar/launch/ocl_3fa85f64-5717-4562-b3fc-2c963f66afa6" })))
      await flush()
    })

    expect(host.querySelector(".calendar-redirect-link")).toBeNull()
    expect(host.querySelector(".calendar-connect-unavailable")).not.toBeNull()
  })

  it("does not allow destructive disconnect while the server catalog is unavailable", async () => {
    bindingStorageMock.loadCalendarBindingId.mockReturnValue(calendarBindingId)
    catalogQueryMock.state = catalogFailure()
    const host = await mount()

    expect(runtimeMock.runFork).not.toHaveBeenCalled()
    const alert = host.querySelector<HTMLElement>(".calendar-catalog-unavailable")
    expect(alert?.getAttribute("role")).toBe("alert")
    expect(alert?.textContent).toContain("could not confirm it")
    expect(host.querySelector("button")?.textContent).toBe("Retry")
    expect(bindingStorageMock.clearCalendarBindingId).not.toHaveBeenCalled()
  })

  it("clears the local calendar binding only after a confirmed disconnect", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    bindingStorageMock.loadCalendarBindingId.mockReturnValue(calendarBindingId)
    catalogQueryMock.state = catalogSuccess([serverBinding(calendarBindingId)])
    const host = await mount()

    await act(async () => {
      disconnectButton(host)?.click()
      await flush()
      catalogQueryMock.state = catalogSuccess([], 2)
      observe?.(Exit.succeed(undefined))
      await flush()
    })

    expect(bindingStorageMock.clearCalendarBindingId).toHaveBeenCalledTimes(1)
    expect(host.querySelector(".calendar-connected")).toBeNull()
    expect(connectButton(host)).toBeDefined()
    expect(host.querySelector(".calendar-disconnect-unavailable")).toBeNull()
  })

  it("uses the server catalog when this browser has no remembered binding", async () => {
    catalogQueryMock.state = catalogSuccess([serverBinding(calendarBindingId)])
    const host = await mount()

    expect(host.textContent).toContain("Google Calendar connected")
    expect(host.textContent).toContain("Selected calendar")
    expect(host.textContent).toContain("Connect another account")
    expect(host.textContent).not.toContain("in this browser")
    expect(host.querySelector(".calendar-connect")).toBeNull()
  })

  it("offers a scoped sync action and emits a sibling refresh signal only after the server acknowledges it", async () => {
    let observe: ((exit: unknown) => void) | undefined
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => {
        observe = observer
      }
    }))
    catalogQueryMock.state = catalogSuccess([serverBinding(calendarBindingId)])
    const host = await mount()
    const syncButton = host.querySelector<HTMLButtonElement>(".calendar-sync-button")
    expect(syncButton?.textContent).toBe("Sync now")

    const dispatch = vi.spyOn(window, "dispatchEvent")
    await act(async () => {
      syncButton?.click()
      await flush()
    })
    expect(syncButton?.disabled).toBe(true)
    expect(syncButton?.textContent).toBe("Syncing…")
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "calendar-sync-triggered" }))

    await act(async () => {
      observe?.(Exit.succeed(Exit.succeed({ triggered: true })))
      await flush()
    })
    expect(host.querySelector(".calendar-sync-success")?.textContent).toContain("Sync requested")
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "calendar-sync-triggered" }))
  })

  it("supersedes stale local storage with a confirmed server catalog", async () => {
    bindingStorageMock.loadCalendarBindingId.mockReturnValue(calendarBindingId)
    catalogQueryMock.state = catalogSuccess([serverBinding(secondCalendarBindingId, "allVisible")])
    const host = await mount()

    expect(host.textContent).toContain("All visible calendars")
    expect(host.textContent).not.toContain("in this browser")
    expect(host.querySelector(".calendar-connect")).toBeNull()
  })

  it("renders a privacy-safe selector for multiple connections and keeps failed catalog reads non-destructive", async () => {
    catalogQueryMock.state = catalogSuccess([
      serverBinding(calendarBindingId),
      serverBinding(secondCalendarBindingId, "allVisible")
    ])
    const host = await mount()
    const selector = host.querySelector<HTMLSelectElement>("select[aria-label='Select Google Calendar connection']")
    expect(selector).not.toBeNull()
    expect(selector?.options).toHaveLength(2)
    expect(host.textContent).not.toContain(calendarBindingId)
    expect(host.textContent).not.toContain(secondCalendarBindingId)

    catalogQueryMock.state = catalogFailure()
    bindingStorageMock.loadCalendarBindingId.mockReturnValue(calendarBindingId)
    const failedHost = await mount()
    expect(failedHost.querySelector(".calendar-catalog-unavailable")?.textContent).toContain(
      "could not confirm it"
    )
    expect(failedHost.querySelector("button")?.textContent).toBe("Retry")
    expect(failedHost.textContent).not.toContain("private catalog detail")
    expect(failedHost.textContent).not.toContain("Disconnect")
  })

  it("ignores an out-of-order catalog result after a callback refresh", async () => {
    catalogQueryMock.state = catalogSuccess([serverBinding(calendarBindingId)], 1)
    const host = await mount()
    expect(host.textContent).toContain("Selected calendar")

    await act(async () => {
      window.dispatchEvent(new CustomEvent("calendar-binding-changed"))
      await flush()
    })
    expect(host.textContent).toContain("Checking calendar connections")
    expect(host.textContent).not.toContain("Selected calendar")

    catalogQueryMock.state = catalogSuccess([serverBinding(secondCalendarBindingId, "allVisible")], 2)
    await act(async () => {
      for (const { root } of roots) root.render(<CalendarPanel />)
      await flush()
    })
    expect(host.textContent).toContain("All visible calendars")
    expect(host.textContent).not.toContain("Selected calendar")
  })
})
