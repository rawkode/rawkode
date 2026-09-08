/** @vitest-environment happy-dom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import * as Exit from "effect/Exit"
import { EntityId, Tag, UnexpectedError } from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMock = vi.hoisted(() => ({ runFork: vi.fn() }))
const queryStateMock = vi.hoisted(() => ({
  dependencies: [] as ReadonlyArray<unknown>[],
  tags: [] as ReadonlyArray<Tag>
}))

vi.mock("./AddTagFieldForm.js", () => ({ AddTagFieldForm: () => null }))
vi.mock("./runtime.js", () => ({ runtime: runtimeMock }))
vi.mock("./use-effect-query.js", () => ({
  useEffectQuery: (_effect: unknown, dependencies: ReadonlyArray<unknown>) => {
    queryStateMock.dependencies.push([...dependencies])
    return dependencies.length === 1
      ? { status: "success" as const, value: queryStateMock.tags }
      : { status: "success" as const, value: [] }
  }
}))

import { SupertagsManager } from "./SupertagsManager.js"

const parentTag = new Tag({
  id: EntityId.make("00000000-0000-4000-8000-000000000001"),
  name: "Person",
  parentIds: [],
  builtin: true
})
const createdTag = new Tag({
  id: EntityId.make("00000000-0000-4000-8000-000000000002"),
  name: "Research",
  parentIds: [parentTag.id],
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

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const createTagButton = (host: HTMLDivElement): HTMLButtonElement | undefined =>
  host.querySelector<HTMLButtonElement>(".supertags-create-form-row button") ?? undefined

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  runtimeMock.runFork.mockReset()
  queryStateMock.dependencies = []
  queryStateMock.tags = [parentTag]
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("SupertagsManager creation failure privacy", () => {
  it("keeps an uncertain create generic and retains its name and parents until confirmed success", async () => {
    const observers: Array<(exit: unknown) => void> = []
    runtimeMock.runFork.mockImplementation(() => ({
      addObserver: (observer: (exit: unknown) => void) => observers.push(observer)
    }))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const privateDetail = "private supertag provider detail"
    const host = await mount()
    const input = host.querySelector<HTMLInputElement>("[aria-label='New Supertag name']")
    const parent = host.querySelector<HTMLInputElement>(".supertags-create-form-parents input")

    await act(async () => {
      setInput(input!, createdTag.name)
      parent?.click()
      createTagButton(host)?.click()
      createTagButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(1)
    expect(createTagButton(host)?.disabled).toBe(true)

    await act(async () => {
      observers[0]?.(Exit.fail(new UnexpectedError({ message: privateDetail })))
      await flush()
    })

    const alert = host.querySelector<HTMLElement>(".supertags-create-form [role='alert']")
    expect(alert?.textContent).toContain("We couldn’t confirm that this Supertag was created.")
    expect(alert?.textContent).toContain("The name and parents are still here.")
    expect(alert?.textContent).toContain("Review your tags before taking another action.")
    expect(host.textContent).not.toContain(privateDetail)
    expect(input?.value).toBe(createdTag.name)
    expect(parent?.checked).toBe(true)
    expect(queryStateMock.dependencies.filter((dependencies) => dependencies.length === 1).every(
      (dependencies) => dependencies[0] === 0
    )).toBe(true)
    expect(consoleError).toHaveBeenCalled()

    await act(async () => {
      createTagButton(host)?.click()
      await flush()
    })
    expect(runtimeMock.runFork).toHaveBeenCalledTimes(2)

    queryStateMock.tags = [parentTag, createdTag]
    await act(async () => {
      observers[1]?.(Exit.succeed({ tag: createdTag }))
      await flush()
    })

    expect(input?.value).toBe("")
    expect(parent?.checked).toBe(false)
    expect(host.querySelector(".supertags-create-form [role='alert']")).toBeNull()
    expect(host.querySelector(".supertags-detail")?.textContent).toContain("#Research")
    expect(queryStateMock.dependencies.some(
      (dependencies) => dependencies.length === 1 && dependencies[0] === 1
    )).toBe(true)
  })
})
