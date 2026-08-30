/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, Tag, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({ tags: [] as ReadonlyArray<Tag> }))

vi.mock("./AddTagFieldForm.js", () => ({ AddTagFieldForm: () => null }))
vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => dependencies.length === 1
    ? { status: "success" as const, value: queryStateMock.tags }
    : { status: "success" as const, value: [] }
}))

import { SupertagsManager } from "./SupertagsManager.js"

const parentTag = new Tag({
  id: EntityId.make("00000000-0000-4000-8000-000000000001"),
  name: "Person",
  parentIds: [],
  builtin: true
})
const projectTag = new Tag({
  id: EntityId.make("00000000-0000-4000-8000-000000000002"),
  name: "Research",
  parentIds: [parentTag.id],
  builtin: false
})
const otherTag = new Tag({
  id: EntityId.make("00000000-0000-4000-8000-000000000003"),
  name: "Delivery",
  parentIds: [],
  builtin: false
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
    root.render(<SupertagsManager />)
    await flush()
  })
  return host
}

const projectButton = (host: HTMLElement): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>(".supertags-list-item-button")]
    .find((button) => button.textContent?.includes("#Research"))
const otherButton = (host: HTMLElement): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>(".supertags-list-item-button")]
    .find((button) => button.textContent?.includes("#Delivery"))

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  queryStateMock.tags = [parentTag, projectTag, otherTag]
})

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  queryStateMock.tags = []
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("SupertagsManager schema editing", () => {
  it("shows a recoverable load error when the server revision read fails", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const host = await mount()

    await act(async () => {
      projectButton(host)?.click()
      await flush()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".supertags-detail-header button")?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: "private revision read detail" })))
      await flush()
    })
    const alert = host.querySelector<HTMLElement>(".supertags-detail > [role='alert']")
    expect(alert?.textContent).toContain("We couldn’t load the latest schema.")
    expect(host.textContent).not.toContain("private revision read detail")
    expect(alert?.querySelector("button")?.textContent).toBe("Retry load")

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)
    await act(async () => {
      observers[1]?.(Exit.succeed({ tag: { tag: projectTag, revision: "a".repeat(64) } }))
      await flush()
    })
    expect(host.querySelector(".supertags-edit-form")).not.toBeNull()
  })

  it("keeps the typed draft on a stale save and offers retry or reload", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const host = await mount()

    await act(async () => {
      projectButton(host)?.click()
      await flush()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".supertags-detail-header button")?.click()
      await flush()
      observers[0]?.(Exit.succeed({ tag: { tag: projectTag, revision: "b".repeat(64) } }))
      await flush()
    })
    const input = host.querySelector<HTMLInputElement>(".supertags-edit-form input:not([type='checkbox'])")
    setInput(input!, "Research for delivery")
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".supertags-edit-form button")?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)

    await act(async () => {
      observers[1]?.(Exit.fail(new UnexpectedError({ message: "This Supertag changed elsewhere. Reload it before saving." })))
      await flush()
    })
    const alert = host.querySelector<HTMLElement>(".supertags-edit-form [role='alert']")
    expect(alert?.textContent).toContain("changed elsewhere")
    expect(alert?.textContent).toContain("Your draft is still here")
    expect(input?.value).toBe("Research for delivery")
    expect(alert?.querySelectorAll("button")).toHaveLength(2)

    await act(async () => {
      alert?.querySelector<HTMLButtonElement>("button")?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(3)
    await act(async () => {
      observers[2]?.(Exit.succeed({ tag: { tag: projectTag, revision: "c".repeat(64) } }))
      await flush()
    })
    expect(host.querySelector(".supertags-edit-form")).toBeNull()
  })

  it("does not carry a failed edit from one selected Supertag into another", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({ addObserver: (observer: (exit: unknown) => void) => observers.push(observer) }))
    const host = await mount()
    await act(async () => { projectButton(host)?.click(); await flush(); host.querySelector<HTMLButtonElement>(".supertags-detail-header button")?.click(); await flush() })
    await act(async () => { observers[0]?.(Exit.succeed({ tag: { tag: projectTag, revision: "a".repeat(64) } })); await flush() })
    const input = host.querySelector<HTMLInputElement>(".supertags-edit-form input:not([type='checkbox'])")!
    setInput(input, "Research draft")
    await act(async () => { host.querySelector<HTMLButtonElement>(".supertags-edit-form button")?.click(); await flush(); observers[1]?.(Exit.fail(new UnexpectedError({ message: "save failed" }))); await flush() })
    expect(host.textContent).toContain("Your draft is still here")

    await act(async () => { otherButton(host)?.click(); await flush() })
    expect(host.querySelector(".supertags-edit-form")).toBeNull()
    expect(host.querySelector(".supertags-detail [role='alert']")).toBeNull()
    expect(host.textContent).not.toContain("Research draft")
    expect(host.querySelector(".supertag-chip")?.textContent).toContain("#Delivery")
  })
})
