/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { CollaboratorInfo, EntityId, UnexpectedError, type Email } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({
  collaborators: [] as ReadonlyArray<CollaboratorInfo>,
  dependencies: [] as ReadonlyArray<unknown>[]
}))

vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return queryStateMock.dependencies.length % 2 === 1
      ? { status: "success" as const, value: { collaborators: queryStateMock.collaborators } }
      : { status: "success" as const, value: { shareLinks: [] } }
  }
}))

import { SharePanel } from "./SharePanel.js"

const collaborator = new CollaboratorInfo({
  profileId: "alex@example.com" as Email,
  workspaceId: EntityId.make("00000000-0000-4000-8000-000000000001"),
  edges: [],
  role: "build"
})

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

const collaboratorsSection = (host: HTMLDivElement): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>(".share-section")].find(
    (section) => section.querySelector("h3")?.textContent === "Collaborators"
  )

const buttonNamed = (section: HTMLElement | undefined, name: string): HTMLButtonElement | undefined =>
  [...(section?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === name)

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  queryStateMock.collaborators = [collaborator]
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

describe("SharePanel collaborator-removal failure privacy", () => {
  it("keeps a failed preview generic and never starts a removal", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private collaborator preview detail"
    const host = await mount()
    const section = collaboratorsSection(host)
    const remove = buttonNamed(section, "Remove")

    await act(async () => {
      remove?.click()
      remove?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(buttonNamed(section, "Checking…")?.disabled).toBe(true)

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = section?.querySelector<HTMLElement>("[role='alert']")
    expect(alert?.textContent).toContain("We couldn’t inspect this collaborator’s access changes.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(buttonNamed(section, "Confirm removal")).toBeUndefined()
    expect(section?.textContent).toContain(collaborator.profileId)
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(buttonNamed(section, "Remove")?.disabled).toBe(false)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      buttonNamed(section, "Remove")?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
  })

  it("keeps an uncertain removal fail-closed, then refreshes only after confirmed success", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private collaborator removal detail"
    const host = await mount()
    const section = collaboratorsSection(host)

    await act(async () => {
      buttonNamed(section, "Remove")?.click()
      await flush()
    })
    await act(async () => {
      observers[0]?.(Exit.succeed({ affected: [] }))
      await flush()
    })
    await act(async () => {
      buttonNamed(section, "Confirm removal")?.click()
      buttonNamed(section, "Confirm removal")?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
    expect(buttonNamed(section, "Removing…")?.disabled).toBe(true)
    expect(buttonNamed(section, "Cancel")?.disabled).toBe(true)

    await act(async () => {
      observers[1]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const failure = section?.querySelector<HTMLElement>("[role='alert']")
    expect(failure?.textContent).toContain("We couldn’t confirm that this collaborator was removed.")
    expect(failure?.textContent).toContain("Review the collaborators before taking another action.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(buttonNamed(section, "Confirm removal")).toBeUndefined()
    expect(section?.textContent).toContain(collaborator.profileId)
    expect(queryStateMock.dependencies.every((dependencies) => dependencies[0] === 0)).toBe(true)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      buttonNamed(section, "Remove")?.click()
      await flush()
    })
    await act(async () => {
      observers[2]?.(Exit.succeed({ affected: [] }))
      await flush()
    })
    await act(async () => {
      buttonNamed(section, "Confirm removal")?.click()
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
