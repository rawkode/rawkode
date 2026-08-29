/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { UnexpectedError, type ShareLink } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[],
  shareLinks: [] as ReadonlyArray<ShareLink>
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.dependencies.length % 2 === 1
      ? { status: "success" as const, value: { collaborators: [] } }
      : { status: "success" as const, value: { shareLinks: queryStateMock.shareLinks } }
  }
}))

import { SharePanel } from "./SharePanel.js"

const link = {
  id: "a".repeat(64),
  workspaceId: "00000000-0000-4000-8000-000000000001",
  creatorId: "owner@example.com",
  role: "build",
  revoked: false,
  createdAt: "2026-08-28T12:00:00.000Z"
} as ShareLink

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

const shareLinksSection = (host: HTMLDivElement): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>(".share-section")].find(
    (section) => section.querySelector("h3")?.textContent === "Share links"
  )

const buttonNamed = (section: HTMLElement | undefined, name: string): HTMLButtonElement | undefined =>
  [...(section?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === name)

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  queryStateMock.dependencies = []
  queryStateMock.shareLinks = [link]
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("SharePanel share-link revocation failure privacy", () => {
  it("keeps a failed preview generic and never starts a revocation", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private share-link preview detail"
    const host = await mount()
    const section = shareLinksSection(host)
    const revoke = buttonNamed(section, "Revoke")

    await act(async () => {
      revoke?.click()
      revoke?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(buttonNamed(section, "Checking…")?.disabled).toBe(true)

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = section?.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t inspect this share link’s effects.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(buttonNamed(section, "Confirm revoke")).toBeUndefined()
    expect(section?.textContent).toContain(link.id.slice(0, 12))
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(buttonNamed(section, "Revoke")?.disabled).toBe(false)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      buttonNamed(section, "Revoke")?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
  })

  it("keeps an uncertain revocation fail-closed, then refreshes only after confirmed success", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private share-link revocation detail"
    const host = await mount()
    const section = shareLinksSection(host)

    await act(async () => {
      buttonNamed(section, "Revoke")?.click()
      await flush()
    })
    await act(async () => {
      observers[0]?.(Exit.succeed({ affected: [] }))
      await flush()
    })
    await act(async () => {
      buttonNamed(section, "Confirm revoke")?.click()
      buttonNamed(section, "Confirm revoke")?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
    expect(buttonNamed(section, "Revoking…")?.disabled).toBe(true)
    expect(buttonNamed(section, "Cancel")?.disabled).toBe(true)

    await act(async () => {
      observers[1]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const failure = section?.querySelector<HTMLElement>("[role='alert']")
    expect(failure?.textContent).toContain("We couldn’t confirm that this share link was revoked.")
    expect(failure?.textContent).toContain("Review the active links before taking another action.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(buttonNamed(section, "Confirm revoke")).toBeUndefined()
    expect(section?.textContent).toContain(link.id.slice(0, 12))
    expect(queryStateMock.dependencies.every((dependencies) => dependencies[0] === 0)).toBe(true)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      buttonNamed(section, "Revoke")?.click()
      await flush()
    })
    await act(async () => {
      observers[2]?.(Exit.succeed({ affected: [] }))
      await flush()
    })
    await act(async () => {
      buttonNamed(section, "Confirm revoke")?.click()
      await flush()
    })
    await act(async () => {
      observers[3]?.(Exit.succeed({ affected: [] }))
      await flush()
    })

    expect(queryStateMock.dependencies.slice(-2)).toEqual([[1], [1]])
    expect(section?.querySelector("[role='alert']")).toBeNull()
  })
})
